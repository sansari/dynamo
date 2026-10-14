import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import { buildContext } from "./check.js";
import {
  DYNAMO_SESSION_SCHEMA_VERSION,
  createSession,
  loadSession,
  transitionSession,
  type DynamoSession,
} from "./session.js";

const LOOPBACK_HOST = "127.0.0.1";
const MAX_REQUEST_BYTES = 64 * 1024;
export const DRAFT_HANDOFF_PATH = ".dynamo/handoffs/draft-requirements.md";
const adjacentWebRoot = join(import.meta.dirname, "web");
const WEB_ROOT = existsSync(adjacentWebRoot) ? adjacentWebRoot : resolve(import.meta.dirname, "../dist/web");

export interface WizardHandle {
  url: string;
  server: Server;
  close(): Promise<void>;
}

export interface StartWizardOptions {
  openBrowser?: boolean;
  port?: number;
  view?: "wizard" | "dashboard";
}

export type DashboardQualityStatus = "pass" | "fail" | "pending" | "uncovered" | "not-required";

export interface DashboardRequirement {
  id: string;
  text: string;
  tests: Array<{ path: string; line: number }>;
  quality: { status: DashboardQualityStatus; summary?: string };
}

export interface DashboardSpec {
  path: string;
  title: string;
  requirements: DashboardRequirement[];
  issues: Array<{ line: number; message: string }>;
}

export interface WizardState {
  repository: { name: string; path: string };
  session: DynamoSession;
  specs: DashboardSpec[];
}

export async function startWizard(root: string, options: StartWizardOptions = {}): Promise<WizardHandle> {
  const initialSession = options.view === "dashboard" ? transientDashboardSession(root) : ensureDiscoveredSession(root);
  const token = randomBytes(24).toString("hex");
  const server = createServer((request, response) => {
    handleRequest(root, token, request, response, initialSession).catch((error) => {
      if (!response.headersSent) {
        sendJson(response, error instanceof HttpError ? error.status : 500, { error: message(error) });
      } else {
        response.destroy(error instanceof Error ? error : undefined);
      }
    });
  });

  await new Promise<void>((resolveReady, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, LOOPBACK_HOST, () => {
      server.off("error", reject);
      resolveReady();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Dynamo wizard did not receive a TCP port");
  const view = options.view === "dashboard" ? "&view=dashboard" : "";
  const url = `http://${LOOPBACK_HOST}:${address.port}/?token=${token}${view}`;
  if (options.openBrowser !== false) openBrowser(url);

  return {
    url,
    server,
    close: () =>
      new Promise<void>((resolveClosed, reject) => {
        server.close((error) => (error ? reject(error) : resolveClosed()));
      }),
  };
}

export async function runDynamoInit(root: string, args: string[]): Promise<void> {
  const openBrowser = parseOpenBrowserFlag("init", args);
  const wizard = await startWizard(root, { openBrowser });
  console.log(`Dynamo is ready at ${wizard.url}`);
  console.log("Press Ctrl-C to stop the local server. Progress is saved in .dynamo/session.json.");
}

export async function runDynamoDash(root: string, args: string[]): Promise<void> {
  const openBrowser = parseOpenBrowserFlag("dash", args);
  const dashboard = await startWizard(root, { openBrowser, view: "dashboard" });
  console.log(`Dynamo dashboard is ready at ${dashboard.url}`);
  console.log("Press Ctrl-C to stop the local server.");
}

function parseOpenBrowserFlag(command: "init" | "dash", args: string[]): boolean {
  let open = true;
  for (const arg of args) {
    if (arg === "--no-open") open = false;
    else {
      console.error(`dynamo ${command}: unknown argument "${arg}"`);
      console.error(`usage: dynamo ${command} [--no-open]`);
      process.exit(2);
    }
  }
  return open;
}

function transientDashboardSession(root: string): DynamoSession {
  const timestamp = new Date().toISOString();
  return {
    schemaVersion: DYNAMO_SESSION_SCHEMA_VERSION,
    revision: 0,
    phase: "discovering",
    createdAt: timestamp,
    updatedAt: timestamp,
    discovery: discoverRepository(root),
    focus: null,
    requirements: [],
    testMappings: [],
    handoffs: [],
    runs: [],
  };
}

function ensureDiscoveredSession(root: string): DynamoSession {
  const existing = loadSession(root);
  if (existing) {
    if (existing.phase !== "discovering" && existing.focus?.boundary) ensureDraftHandoff(root, existing, false);
    return existing;
  }
  const created = createSession(root);
  return transitionSession(root, created.revision, (draft) => {
    draft.discovery = discoverRepository(root);
  });
}

export function discoverRepository(root: string): DynamoSession["discovery"] {
  const ignored = new Set([".git", ".dynamo", "node_modules"]);
  const projectStructure = readdirSync(root, { withFileTypes: true })
    .filter((entry) => !ignored.has(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 30)
    .map((entry) => `${entry.name}${entry.isDirectory() ? "/" : ""}`);

  const testCommands: string[] = [];
  const packagePath = join(root, "package.json");
  if (existsSync(packagePath)) {
    try {
      const packageJson = JSON.parse(readFileSync(packagePath, "utf8")) as { scripts?: { test?: unknown } };
      if (typeof packageJson.scripts?.test === "string") testCommands.push("npm test");
    } catch {
      // Malformed metadata remains visible in the file list for user correction.
    }
  }
  if (testCommands.length === 0 && existsSync(join(root, "pyproject.toml"))) testCommands.push("pytest");
  if (testCommands.length === 0 && existsSync(join(root, "Cargo.toml"))) testCommands.push("cargo test");
  if (testCommands.length === 0 && existsSync(join(root, "go.mod"))) testCommands.push("go test ./...");

  const existing2119Artifacts = [".2119.yml", "specs", ".2119"].filter((path) => existsSync(join(root, path)));
  return { projectStructure, testCommands, existing2119Artifacts, confirmed: false };
}

async function handleRequest(
  root: string,
  token: string,
  request: IncomingMessage,
  response: ServerResponse,
  initialSession: DynamoSession,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${LOOPBACK_HOST}`);
  setSecurityHeaders(response);

  if (request.method === "GET" && url.pathname === "/favicon.ico") {
    response.writeHead(204).end();
    return;
  }
  if (request.method === "GET" && url.pathname === "/") {
    if (url.searchParams.get("token") !== token) throw new HttpError(403, "Invalid wizard URL");
    serveFile(response, join(WEB_ROOT, "index.html"));
    return;
  }
  if (request.method === "GET" && url.pathname.startsWith("/assets/")) {
    const path = resolve(WEB_ROOT, `.${url.pathname}`);
    if (!isContained(WEB_ROOT, path)) throw new HttpError(404, "Not found");
    serveFile(response, path);
    return;
  }
  if (url.pathname.startsWith("/api/")) {
    if (request.headers["x-dynamo-token"] !== token) throw new HttpError(403, "Invalid Dynamo session token");
    if (request.method === "GET" && url.pathname === "/api/state") {
      sendJson(response, 200, stateResponse(root, loadSession(root) ?? initialSession));
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/action") {
      const session = applyAction(root, await readJsonBody(request));
      sendJson(response, 200, stateResponse(root, session));
      return;
    }
  }
  throw new HttpError(404, "Not found");
}

function applyAction(root: string, body: Record<string, unknown>): DynamoSession {
  if (!Number.isInteger(body.revision)) throw new HttpError(400, "revision must be an integer");
  const revision = body.revision as number;
  try {
    switch (body.action) {
      case "confirm-discovery": {
        const testCommand = optionalString(body.testCommand, "testCommand", 300);
        return transitionSession(root, revision, (draft) => {
          draft.discovery.testCommands = testCommand ? [testCommand] : [];
          draft.discovery.confirmed = true;
        });
      }
      case "select-concern": {
        const concern = requiredString(body.concern, "concern", 500);
        return transitionSession(root, revision, (draft) => {
          if (!draft.discovery.confirmed) throw new HttpError(409, "Confirm repository discovery first");
          draft.focus = { area: concern, boundary: null };
          draft.phase = "concern-selected";
        });
      }
      case "confirm-boundary": {
        const boundary = requiredString(body.boundary, "boundary", 800);
        const session = transitionSession(root, revision, (draft) => {
          if (!draft.focus) throw new HttpError(409, "Select a concern first");
          draft.focus.boundary = boundary;
          draft.phase = "boundary-confirmed";
          draft.handoffs = [
            ...draft.handoffs.filter((handoff) => handoff.kind !== "draft-requirements"),
            { kind: "draft-requirements", path: DRAFT_HANDOFF_PATH, status: "ready" },
          ];
        });
        ensureDraftHandoff(root, session, true);
        return session;
      }
      case "reset":
        return transitionSession(root, revision, (draft) => {
          draft.phase = "discovering";
          draft.discovery.confirmed = false;
          draft.focus = null;
          draft.requirements = [];
          draft.testMappings = [];
          draft.handoffs = [];
          draft.runs = [];
        });
      default:
        throw new HttpError(400, "Unknown wizard action");
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error instanceof Error && error.message.includes("revision changed")) {
      throw new HttpError(409, "The wizard changed in another tab. Reload and try again.");
    }
    throw error;
  }
}

function stateResponse(root: string, knownSession?: DynamoSession): WizardState {
  const session = knownSession ?? loadSession(root);
  if (!session) throw new HttpError(404, "No Dynamo session exists");
  return { repository: repositorySummary(root), session, specs: dashboardSpecs(root) };
}

function dashboardSpecs(root: string): DashboardSpec[] {
  const context = buildContext(root);
  const reviewTargets = new Map(context.reviewTargets.map((target) => [target.requirement.id, target]));
  return context.specs.map((spec) => ({
    path: relative(root, spec.path),
    title: spec.title ?? basename(spec.path),
    requirements: spec.sections.flatMap((section) =>
      section.items.filter((requirement) => !requirement.removed).map((requirement) => {
        const { id, text } = requirement;
        const target = reviewTargets.get(id);
        const verdict = target ? context.verdicts.get(target.reviewId) : undefined;
        const tests = (context.coverage.covered.get(id) ?? []).map((annotation) => ({
          path: isAbsolute(annotation.file) ? relative(root, annotation.file) : annotation.file,
          line: annotation.line,
        }));
        const enforced = requirement.keywords.length === 1 && context.config.enforce.includes(requirement.keywords[0]);
        return {
          id,
          text,
          tests,
          quality: target
            ? { status: verdict?.verdict ?? "pending", ...(verdict?.summary ? { summary: verdict.summary } : {}) }
            : enforced && requirement.coverage.kind === "test"
              ? { status: "uncovered" }
              : { status: "not-required" },
        } satisfies DashboardRequirement;
      }),
    ),
    issues: context.lintViolations
      .filter((violation) => violation.file === spec.path)
      .map(({ line, message }) => ({ line, message })),
  }));
}

function ensureDraftHandoff(root: string, session: DynamoSession, replace: boolean): void {
  if (!session.focus?.boundary) return;
  const target = join(root, DRAFT_HANDOFF_PATH);
  if (existsSync(target)) {
    if (lstatSync(target).isSymbolicLink()) throw new Error(`Refusing to write a symlinked handoff at ${target}`);
    if (!replace) return;
  }
  const directory = join(root, ".dynamo", "handoffs");
  if (existsSync(directory)) {
    if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) {
      throw new Error(`Dynamo handoff path must be a real directory: ${directory}`);
    }
  } else {
    mkdirSync(directory, { mode: 0o700 });
  }
  writeAtomic(target, renderDraftHandoff(root, session));
}

function renderDraftHandoff(root: string, session: DynamoSession): string {
  const quote = (value: string) => value.split(/\r?\n/).map((line) => `> ${line}`).join("\n");
  return `# Dynamo agent handoff: draft requirements

This file was generated by Dynamo. Complete the task with the coding agent of your choice; Dynamo does not invoke a language model.

## Repository context

- Repository: \`${basename(root)}\`
- Test command: \`${session.discovery.testCommands[0] || "not configured"}\`

### Worrying area

${quote(session.focus!.area)}

### Confirmed behavior boundary

${quote(session.focus!.boundary!)}

## Task

Create or update one focused Markdown specification under \`specs/\`. Draft between three and eight individually testable, user-observable requirements for the confirmed boundary. Each requirement must contain exactly one RFC 2119 keyword and must describe product behavior rather than implementation mechanics or a testing instruction.

Use Dynamo's file-scoped format:

\`\`\`markdown
# Descriptive title
## Overview
Brief context for this behavior boundary.
## Requirements
### 1: Cohesive behavior group
1. The product MUST produce an observable outcome.
2. The product MUST NOT permit a forbidden outcome.
3. The product MUST explain the outcome when the user needs to act.
\`\`\`

Choose a descriptive lowercase-hyphen filename such as \`specs/promotion-eligibility.md\`. Do not edit \`.dynamo/session.json\`. When the specification is saved, return to the Dynamo dashboard and select **Refresh specs**.
`;
}

function writeAtomic(target: string, content: string): void {
  const temporary = join(resolve(target, ".."), `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  let descriptor: number | null = null;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, content, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    renameSync(temporary, target);
  } catch (error) {
    if (descriptor !== null) closeSync(descriptor);
    rmSync(temporary, { force: true });
    throw error;
  }
}

function repositorySummary(root: string): { name: string; path: string } {
  return { name: basename(root), path: root };
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_REQUEST_BYTES) throw new HttpError(413, "Request body is too large");
    chunks.push(buffer);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "Request body must be a JSON object");
  }
}

function requiredString(value: unknown, field: string, maximum: number): string {
  const text = optionalString(value, field, maximum);
  if (!text) throw new HttpError(400, `${field} is required`);
  return text;
}

function optionalString(value: unknown, field: string, maximum: number): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new HttpError(400, `${field} must be a string`);
  const text = value.trim();
  if (text.length > maximum) throw new HttpError(400, `${field} must be at most ${maximum} characters`);
  return text;
}

function serveFile(response: ServerResponse, path: string): void {
  if (!existsSync(path)) throw new HttpError(503, "Dynamo web assets are missing; run the package build first");
  const contentTypes: Record<string, string> = {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
  };
  response.writeHead(200, { "content-type": contentTypes[extname(path)] ?? "application/octet-stream" });
  response.end(readFileSync(path));
}

function isContained(root: string, candidate: string): boolean {
  const path = relative(resolve(root), candidate);
  return path !== ".." && !path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(path);
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader("cache-control", "no-store");
  response.setHeader("content-security-policy", "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("x-frame-options", "DENY");
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(value)}\n`);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function openBrowser(url: string): void {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.on("error", (error) => console.error(`Could not open the browser automatically: ${error.message}`));
  child.unref();
}
