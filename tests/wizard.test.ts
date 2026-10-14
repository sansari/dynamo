import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildContext } from "../src/check.js";
import { createSession, transitionSession } from "../src/session.js";
import { parseSpec } from "../src/spec.js";
import { writeVerdict } from "../src/verdict.js";
import { DRAFT_HANDOFF_PATH, discoverRepository, startWizard } from "../src/wizard.js";

const DYNAMO_CLI = resolve(import.meta.dirname, "../dist/dynamo.js");

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "dynamo-wizard-"));
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "test"));
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({ name: "demo-shop", private: true, scripts: { test: "node --test" } }, null, 2)}\n`,
  );
  writeFileSync(join(root, "src/discounts.js"), "export const discount = value => value;\n");
  writeFileSync(join(root, "test/discounts-test-js.tmpl"), "template\n");
  return root;
}

function tokenFrom(url: string): string {
  return new URL(url).searchParams.get("token")!;
}

async function state(url: string) {
  const response = await fetch(`${new URL(url).origin}/api/state`, {
    headers: { "x-dynamo-token": tokenFrom(url) },
  });
  expect(response.status).toBe(200);
  return response.json();
}

async function actionResponse(url: string, revision: number, body: Record<string, unknown>) {
  return fetch(`${new URL(url).origin}/api/action`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-dynamo-token": tokenFrom(url) },
    body: JSON.stringify({ revision, ...body }),
  });
}

async function action(url: string, revision: number, body: Record<string, unknown>) {
  const response = await actionResponse(url, revision, body);
  expect(response.status).toBe(200);
  return response.json();
}

describe("local first-run wizard", () => {
  // 2119: first-run-flow.1.1, first-run-flow.1.4
  it("serves the React app only on loopback behind an unguessable session token", async () => {
    const wizard = await startWizard(fixture(), { openBrowser: false });
    try {
      const address = wizard.server.address();
      expect(address).toMatchObject({ address: "127.0.0.1" });

      const forbiddenPage = await fetch(new URL(wizard.url).origin);
      expect(forbiddenPage.status).toBe(403);
      const forbiddenApi = await fetch(`${new URL(wizard.url).origin}/api/state`);
      expect(forbiddenApi.status).toBe(403);

      const page = await fetch(wizard.url);
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).toContain('<div id="root"></div>');
      const assetPath = html.match(/src="(\/assets\/[^"]+\.js)"/)?.[1];
      expect(assetPath).toBeTruthy();
      const asset = await fetch(`${new URL(wizard.url).origin}${assetPath}`);
      expect(asset.status).toBe(200);
      expect(asset.headers.get("content-type")).toContain("text/javascript");
    } finally {
      await wizard.close();
    }
  });

  it("opens existing specifications in direct dashboard mode", async () => {
    const root = fixture();
    mkdirSync(join(root, "specs"));
    writeFileSync(join(root, "specs/cart.md"), `# Cart behavior
## Overview
Cart totals.
## Requirements
### 1: Totals
1. The cart MUST show its total.
2. The cart MUST reject an invalid quantity.
`);
    writeFileSync(join(root, "specs/shipping.md"), `# Shipping behavior
## Overview
Shipping choices.
## Requirements
### 1: Availability
1. The shop SHOULD explain unavailable shipping methods.
`);
    const annotationPrefix = "2119";
    writeFileSync(join(root, "test/cart.test.js"), `// ${annotationPrefix}: cart.1.1
test("shows total", () => {});
// ${annotationPrefix}: cart.1.2
test("rejects invalid quantity", () => {});
`);
    const context = buildContext(root);
    const totalTarget = context.reviewTargets.find((target) => target.requirement.id === "cart.1.1")!;
    const quantityTarget = context.reviewTargets.find((target) => target.requirement.id === "cart.1.2")!;
    writeVerdict(root, totalTarget.reviewId, "cart.1.1", "pass", "The total assertion exercises production output.");
    writeVerdict(root, quantityTarget.reviewId, "cart.1.2", "fail", "The rejection test does not exercise production behavior.");
    const dashboard = await startWizard(root, { openBrowser: false, view: "dashboard" });
    try {
      expect(new URL(dashboard.url).searchParams.get("view")).toBe("dashboard");
      expect(existsSync(join(root, ".dynamo"))).toBe(false);
      const model = await state(dashboard.url);
      expect(existsSync(join(root, ".dynamo"))).toBe(false);
      expect(model.specs).toEqual([
        expect.objectContaining({
          path: "specs/cart.md",
          requirements: [
            {
              id: "cart.1.1",
              text: "The cart MUST show its total.",
              tests: [{ path: "test/cart.test.js", line: 1 }],
              quality: { status: "pass", summary: "The total assertion exercises production output." },
            },
            {
              id: "cart.1.2",
              text: "The cart MUST reject an invalid quantity.",
              tests: [{ path: "test/cart.test.js", line: 3 }],
              quality: { status: "fail", summary: "The rejection test does not exercise production behavior." },
            },
          ],
          issues: [],
        }),
        expect.objectContaining({
          path: "specs/shipping.md",
          requirements: [expect.objectContaining({ id: "shipping.1.1", text: "The shop SHOULD explain unavailable shipping methods." })],
          issues: [],
        }),
      ]);
    } finally {
      await dashboard.close();
    }
  });

  // 2119: first-run-flow.1.1, first-run-flow.1.4
  it("launches through the packaged dynamo init command", async () => {
    const root = fixture();
    const child = spawn("node", [DYNAMO_CLI, "init", "--no-open"], { cwd: root });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    try {
      const url = await new Promise<string>((resolveUrl, reject) => {
        let stdout = "";
        child.stdout.setEncoding("utf8").on("data", (chunk) => {
          stdout += chunk;
          const match = stdout.match(/Dynamo is ready at (http:\/\/[^\s]+)/);
          if (match) resolveUrl(match[1]);
        });
        child.once("error", reject);
        child.once("exit", (code) => reject(new Error(`dynamo init exited early (${code}): ${stderr}`)));
      });
      const response = await fetch(url);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('<div id="root"></div>');
      expect(new URL(url).searchParams.has("view")).toBe(false);
      expect(existsSync(join(root, ".dynamo/session.json"))).toBe(true);
      expect(await state(url)).toMatchObject({
        repository: { path: realpathSync(root) },
        session: { phase: "discovering", discovery: { confirmed: false } },
      });
      const externalAddress = Object.values(networkInterfaces()).flat().find(
        (address) => address?.family === "IPv4" && !address.internal,
      )?.address;
      expect(externalAddress).toBeTruthy();
      const nonLoopbackUrl = new URL(url);
      nonLoopbackUrl.hostname = externalAddress!;
      await expect(fetch(nonLoopbackUrl, { signal: AbortSignal.timeout(1_000) })).rejects.toThrow();
    } finally {
      child.kill("SIGTERM");
      await new Promise<void>((resolveExit) => child.once("close", () => resolveExit()));
    }
  });

  it("launches the packaged dynamo dash command without entering the wizard", async () => {
    const root = fixture();
    const child = spawn("node", [DYNAMO_CLI, "dash", "--no-open"], { cwd: root });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    try {
      const url = await new Promise<string>((resolveUrl, reject) => {
        let stdout = "";
        child.stdout.setEncoding("utf8").on("data", (chunk) => {
          stdout += chunk;
          const match = stdout.match(/Dynamo dashboard is ready at (http:\/\/[^\s]+)/);
          if (match) resolveUrl(match[1]);
        });
        child.once("error", reject);
        child.once("exit", (code) => reject(new Error(`dynamo dash exited early (${code}): ${stderr}`)));
      });
      expect(new URL(url).searchParams.get("view")).toBe("dashboard");
      const response = await fetch(url);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('<div id="root"></div>');
      expect(existsSync(join(root, ".dynamo"))).toBe(false);
    } finally {
      child.kill("SIGTERM");
      await new Promise<void>((resolveExit) => child.once("close", () => resolveExit()));
    }
  });

  it("resumes completed approvals when the wizard starts again", async () => {
    const root = fixture();
    let session = createSession(root);
    session = transitionSession(root, session.revision, (draft) => {
      draft.discovery.confirmed = true;
      draft.focus = { area: "cart recovery", boundary: null };
      draft.phase = "concern-selected";
    });
    session = transitionSession(root, session.revision, (draft) => {
      draft.focus!.boundary = "approved cart behavior";
      draft.phase = "boundary-confirmed";
    });
    session = transitionSession(root, session.revision, (draft) => {
      draft.requirements = [{ id: "cart.1.1", text: "The cart MUST recover.", approval: "approved" }];
      draft.phase = "requirements-drafted";
    });
    transitionSession(root, session.revision, (draft) => {
      draft.phase = "requirements-approved";
    });

    const resumed = await startWizard(root, { openBrowser: false });
    try {
      expect(await state(resumed.url)).toMatchObject({
        session: {
          phase: "requirements-approved",
          discovery: { confirmed: true },
          focus: { area: "cart recovery", boundary: "approved cart behavior" },
          requirements: [{ id: "cart.1.1", approval: "approved" }],
        },
      });
    } finally {
      await resumed.close();
    }

    const unconfirmedRoot = fixture();
    createSession(unconfirmedRoot);
    const unconfirmed = await startWizard(unconfirmedRoot, { openBrowser: false });
    try {
      expect(await state(unconfirmed.url)).toMatchObject({ session: { discovery: { confirmed: false } } });
    } finally {
      await unconfirmed.close();
    }
  });

  it("discovers every supported test command and existing 2119 artifact", () => {
    const commandCases = [
      { file: "package.json", content: '{"scripts":{"test":"vitest"}}\n', command: "npm test" },
      { file: "pyproject.toml", content: "[project]\nname = 'demo'\n", command: "pytest" },
      { file: "Cargo.toml", content: "[package]\nname = 'demo'\n", command: "cargo test" },
      { file: "go.mod", content: "module example.test/demo\n", command: "go test ./..." },
    ];
    for (const { file, content, command } of commandCases) {
      const root = mkdtempSync(join(tmpdir(), "dynamo-discovery-"));
      writeFileSync(join(root, file), content);
      expect(discoverRepository(root).testCommands).toEqual([command]);
    }

    const root = mkdtempSync(join(tmpdir(), "dynamo-artifacts-"));
    writeFileSync(join(root, ".2119.yml"), 'prefix: "REQ"\n');
    mkdirSync(join(root, "specs"));
    mkdirSync(join(root, ".2119"));
    expect(discoverRepository(root).existing2119Artifacts).toEqual([".2119.yml", "specs", ".2119"]);
  });

  // 2119: first-run-flow.1.2, first-run-flow.2.2
  it("discovers, persists, resumes, and resets a narrowed repository concern", async () => {
    const root = fixture();
    writeFileSync(join(root, ".2119.yml"), 'prefix: "REQ"\n');
    const first = await startWizard(root, { openBrowser: false });
    let revision: number;
    try {
      let model = await state(first.url);
      expect(model.repository).toMatchObject({ name: expect.stringContaining("dynamo-wizard-") });
      expect(model.session).toMatchObject({
        phase: "discovering",
        discovery: {
          confirmed: false,
          testCommands: ["npm test"],
          projectStructure: [".2119.yml", "package.json", "src/", "test/"],
          existing2119Artifacts: [".2119.yml"],
        },
      });

      expect((await actionResponse(first.url, model.session.revision, {
        action: "select-concern",
        concern: "Too early",
      })).status).toBe(409);
      expect((await actionResponse(first.url, model.session.revision, {
        action: "confirm-boundary",
        boundary: "Too early",
      })).status).toBe(409);
      model = await state(first.url);
      expect(model.session.handoffs).toEqual([]);

      model = await action(first.url, model.session.revision, {
        action: "confirm-discovery",
        testCommand: "npm test",
      });
      expect((await actionResponse(first.url, model.session.revision, {
        action: "confirm-boundary",
        boundary: "Still too early",
      })).status).toBe(409);
      model = await state(first.url);
      expect(model.session.handoffs).toEqual([]);
      model = await action(first.url, model.session.revision, {
        action: "select-concern",
        concern: "Promotion eligibility is under-tested",
      });
      expect((await actionResponse(first.url, model.session.revision, {
        action: "confirm-boundary",
        boundary: "   ",
      })).status).toBe(400);
      model = await state(first.url);
      expect(model.session.handoffs).toEqual([]);
      model = await action(first.url, model.session.revision, {
        action: "confirm-boundary",
        boundary: "Whether a promotion may reduce an order",
      });
      expect(model.session).toMatchObject({
        phase: "boundary-confirmed",
        focus: {
          area: "Promotion eligibility is under-tested",
          boundary: "Whether a promotion may reduce an order",
        },
        handoffs: [{ kind: "draft-requirements", path: DRAFT_HANDOFF_PATH, status: "ready" }],
      });

      // 2119: first-run-flow.2.3
      const handoffPath = join(root, DRAFT_HANDOFF_PATH);
      expect(existsSync(handoffPath)).toBe(true);
      const handoff = readFileSync(handoffPath, "utf8");
      expect(handoff).toContain("Promotion eligibility is under-tested");
      expect(handoff).toContain("Whether a promotion may reduce an order");
      expect(handoff).toContain("coding agent of your choice");
      const draftingInstruction = "Draft between three and eight individually testable, user-observable requirements for the confirmed boundary.";
      expect(handoff).toContain(draftingInstruction);
      expect(handoff.split(draftingInstruction)).toHaveLength(2);
      expect(handoff).not.toMatch(/(?:nine|ten|\d{2,})[^\n]*requirements/i);
      expect(handoff).toContain("exactly one RFC 2119 keyword");
      expect(handoff).toContain("Use Dynamo's file-scoped format");
      const template = handoff.match(/```markdown\n([\s\S]*?)```/)?.[1];
      expect(template).toBeTruthy();
      const parsedTemplate = parseSpec(join(root, "specs/example.md"), "REQ", template);
      expect(parsedTemplate.violations).toEqual([]);
      expect(parsedTemplate.sections.flatMap((section) => section.items)).toHaveLength(3);

      expect(model.specs).toEqual([]);
      mkdirSync(join(root, "specs"));
      writeFileSync(join(root, "specs/promotion-eligibility.md"), `# Promotion eligibility
## Overview
Promotion behavior.
## Requirements
### 1: Eligibility
1. The shop MUST reject expired promotions.
2. Active promotions reduce an order.
`);

      model = await state(first.url);
      expect(model.specs).toEqual([
        expect.objectContaining({
          path: "specs/promotion-eligibility.md",
          title: "Promotion eligibility",
          requirements: [
            expect.objectContaining({ id: "promotion-eligibility.1.1", text: "The shop MUST reject expired promotions." }),
            expect.objectContaining({ id: "promotion-eligibility.1.2", text: "Active promotions reduce an order." }),
          ],
          issues: [expect.objectContaining({ line: 7, message: expect.stringContaining("has no RFC 2119 keyword") })],
        }),
      ]);
      revision = model.session.revision;
    } finally {
      await first.close();
    }

    const resumed = await startWizard(root, { openBrowser: false });
    try {
      let model = await state(resumed.url);
      expect(model.session).toMatchObject({
        revision,
        phase: "boundary-confirmed",
        discovery: { confirmed: true },
        focus: {
          area: "Promotion eligibility is under-tested",
          boundary: "Whether a promotion may reduce an order",
        },
      });
      model = await action(resumed.url, model.session.revision, { action: "reset" });
      expect(model.session).toMatchObject({ phase: "discovering", focus: null, discovery: { confirmed: false } });
    } finally {
      await resumed.close();
    }
  });
});
