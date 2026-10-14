import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";

export const DYNAMO_STATE_DIRECTORY = ".dynamo";
export const DYNAMO_SESSION_FILENAME = "session.json";
export const DYNAMO_SESSION_SCHEMA_VERSION = 1;

export const SESSION_PHASES = [
  "discovering",
  "concern-selected",
  "boundary-confirmed",
  "requirements-drafted",
  "requirements-approved",
  "tests-mapped",
  "awaiting-agent",
  "validating",
  "complete",
] as const;

export type SessionPhase = (typeof SESSION_PHASES)[number];
export type RequirementApproval = "pending" | "approved" | "rejected";
export type MappingStatus = "suggested" | "confirmed" | "unresolved";
export type HandoffStatus = "ready" | "returned";
export type RunKind = "project-tests" | "2119-check";

export interface SessionDiscovery {
  projectStructure: string[];
  testCommands: string[];
  existing2119Artifacts: string[];
  confirmed: boolean;
}

export interface SessionFocus {
  area: string;
  boundary: string | null;
}

export interface SessionRequirement {
  id: string;
  text: string;
  approval: RequirementApproval;
}

export interface SessionTestMapping {
  requirementId: string;
  testFiles: string[];
  status: MappingStatus;
}

export interface SessionHandoff {
  kind: "draft-requirements" | "map-tests" | "update-tests";
  path: string;
  status: HandoffStatus;
}

export interface SessionRun {
  kind: RunKind;
  command: string;
  exitCode: number;
  completedAt: string;
}

export interface DynamoSession {
  schemaVersion: typeof DYNAMO_SESSION_SCHEMA_VERSION;
  revision: number;
  phase: SessionPhase;
  createdAt: string;
  updatedAt: string;
  discovery: SessionDiscovery;
  focus: SessionFocus | null;
  requirements: SessionRequirement[];
  testMappings: SessionTestMapping[];
  handoffs: SessionHandoff[];
  runs: SessionRun[];
}

export class SessionStateError extends Error {}
export class SessionRevisionError extends SessionStateError {}

export function sessionPath(root: string): string {
  return join(resolve(root), DYNAMO_STATE_DIRECTORY, DYNAMO_SESSION_FILENAME);
}

export function createSession(root: string, now = new Date()): DynamoSession {
  return withSessionLock(root, () => {
    if (existsSync(sessionPath(root))) {
      throw new SessionStateError(`A Dynamo session already exists at ${sessionPath(root)}`);
    }
    const timestamp = now.toISOString();
    const session: DynamoSession = {
      schemaVersion: DYNAMO_SESSION_SCHEMA_VERSION,
      revision: 0,
      phase: "discovering",
      createdAt: timestamp,
      updatedAt: timestamp,
      discovery: {
        projectStructure: [],
        testCommands: [],
        existing2119Artifacts: [],
        confirmed: false,
      },
      focus: null,
      requirements: [],
      testMappings: [],
      handoffs: [],
      runs: [],
    };
    writeSession(root, session);
    return session;
  });
}

export function loadSession(root: string): DynamoSession | null {
  const path = sessionPath(root);
  if (!existsSync(path)) return null;
  if (lstatSync(path).isSymbolicLink()) {
    throw new SessionStateError(`Refusing to read a symlinked Dynamo session at ${path}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new SessionStateError(`Cannot read Dynamo session at ${path}: ${errorMessage(error)}`);
  }
  assertSession(value);
  return value;
}

export function transitionSession(
  root: string,
  expectedRevision: number,
  update: (draft: DynamoSession) => void,
  now = new Date(),
): DynamoSession {
  return withSessionLock(root, () => {
    const current = loadSession(root);
    if (!current) throw new SessionStateError(`No Dynamo session exists at ${sessionPath(root)}`);
    if (current.revision !== expectedRevision) {
      throw new SessionRevisionError(
        `Dynamo session revision changed: expected ${expectedRevision}, found ${current.revision}`,
      );
    }

    const next = structuredClone(current);
    update(next);
    assertPhaseTransition(current.phase, next.phase);
    next.schemaVersion = DYNAMO_SESSION_SCHEMA_VERSION;
    next.revision = current.revision + 1;
    next.createdAt = current.createdAt;
    next.updatedAt = now.toISOString();
    assertSession(next);
    writeSession(root, next);
    return next;
  });
}

function writeSession(root: string, session: DynamoSession): void {
  assertSession(session);
  const stateDirectory = ensureStateDirectory(root);
  const target = join(stateDirectory, DYNAMO_SESSION_FILENAME);
  const temporary = join(stateDirectory, `.${DYNAMO_SESSION_FILENAME}.${process.pid}.${randomUUID()}.tmp`);
  let descriptor: number | null = null;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(session, null, 2)}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    renameSync(temporary, target);
  } catch (error) {
    if (descriptor !== null) closeSync(descriptor);
    rmSync(temporary, { force: true });
    if (error instanceof SessionStateError) throw error;
    throw new SessionStateError(`Cannot persist Dynamo session at ${target}: ${errorMessage(error)}`);
  }
}

function withSessionLock<T>(root: string, operation: () => T): T {
  const stateDirectory = ensureStateDirectory(root);
  const lockPath = join(stateDirectory, `${DYNAMO_SESSION_FILENAME}.lock`);
  assertNotSymlink(lockPath, "Dynamo session lock");
  let descriptor: number | null = null;
  try {
    descriptor = openSync(lockPath, "wx", 0o600);
    writeFileSync(descriptor, `${process.pid}\n`, "utf8");
  } catch (error) {
    if (descriptor !== null) {
      closeSync(descriptor);
      rmSync(lockPath, { force: true });
    }
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new SessionStateError(
        `Dynamo session is locked by another process (${lockPath}); remove the lock only if no Dynamo process is running`,
      );
    }
    throw new SessionStateError(`Cannot lock Dynamo session at ${lockPath}: ${errorMessage(error)}`);
  }

  try {
    return operation();
  } finally {
    try {
      closeSync(descriptor);
    } finally {
      rmSync(lockPath, { force: true });
    }
  }
}

function assertNotSymlink(path: string, label: string): void {
  try {
    if (lstatSync(path).isSymbolicLink()) {
      throw new SessionStateError(`Refusing to use a symlinked ${label} at ${path}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function ensureStateDirectory(root: string): string {
  const stateDirectory = join(resolve(root), DYNAMO_STATE_DIRECTORY);
  if (existsSync(stateDirectory)) {
    const stat = lstatSync(stateDirectory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new SessionStateError(`Dynamo state path must be a real directory: ${stateDirectory}`);
    }
  } else {
    try {
      mkdirSync(stateDirectory, { recursive: false, mode: 0o700 });
    } catch (error) {
      throw new SessionStateError(`Cannot create Dynamo state directory at ${stateDirectory}: ${errorMessage(error)}`);
    }
  }
  return stateDirectory;
}

function assertPhaseTransition(previous: SessionPhase, next: SessionPhase): void {
  const previousIndex = SESSION_PHASES.indexOf(previous);
  const nextIndex = SESSION_PHASES.indexOf(next);
  if (nextIndex > previousIndex + 1) {
    throw new SessionStateError(`Invalid Dynamo session transition from ${previous} to ${next}`);
  }
}

function assertSession(value: unknown): asserts value is DynamoSession {
  const session = object(value, "session");
  if (session.schemaVersion !== DYNAMO_SESSION_SCHEMA_VERSION) {
    throw new SessionStateError(
      `Unsupported Dynamo session schema version ${String(session.schemaVersion)}; expected ${DYNAMO_SESSION_SCHEMA_VERSION}`,
    );
  }
  nonNegativeInteger(session.revision, "revision");
  oneOf(session.phase, SESSION_PHASES, "phase");
  isoDate(session.createdAt, "createdAt");
  isoDate(session.updatedAt, "updatedAt");

  const discovery = object(session.discovery, "discovery");
  stringArray(discovery.projectStructure, "discovery.projectStructure");
  stringArray(discovery.testCommands, "discovery.testCommands");
  stringArray(discovery.existing2119Artifacts, "discovery.existing2119Artifacts");
  boolean(discovery.confirmed, "discovery.confirmed");

  if (session.focus !== null) {
    const focus = object(session.focus, "focus");
    nonEmptyString(focus.area, "focus.area");
    if (focus.boundary !== null) nonEmptyString(focus.boundary, "focus.boundary");
  }

  const requirements = array(session.requirements, "requirements");
  const requirementIds = new Set<string>();
  for (const [index, item] of requirements.entries()) {
    const requirement = object(item, `requirements[${index}]`);
    const id = nonEmptyString(requirement.id, `requirements[${index}].id`);
    if (requirementIds.has(id)) throw new SessionStateError(`Duplicate session requirement ID: ${id}`);
    requirementIds.add(id);
    nonEmptyString(requirement.text, `requirements[${index}].text`);
    oneOf(requirement.approval, ["pending", "approved", "rejected"] as const, `requirements[${index}].approval`);
  }

  const mappings = array(session.testMappings, "testMappings");
  for (const [index, item] of mappings.entries()) {
    const mapping = object(item, `testMappings[${index}]`);
    nonEmptyString(mapping.requirementId, `testMappings[${index}].requirementId`);
    stringArray(mapping.testFiles, `testMappings[${index}].testFiles`);
    oneOf(mapping.status, ["suggested", "confirmed", "unresolved"] as const, `testMappings[${index}].status`);
  }

  const handoffs = array(session.handoffs, "handoffs");
  for (const [index, item] of handoffs.entries()) {
    const handoff = object(item, `handoffs[${index}]`);
    oneOf(handoff.kind, ["draft-requirements", "map-tests", "update-tests"] as const, `handoffs[${index}].kind`);
    nonEmptyString(handoff.path, `handoffs[${index}].path`);
    oneOf(handoff.status, ["ready", "returned"] as const, `handoffs[${index}].status`);
  }

  const runs = array(session.runs, "runs");
  for (const [index, item] of runs.entries()) {
    const run = object(item, `runs[${index}]`);
    oneOf(run.kind, ["project-tests", "2119-check"] as const, `runs[${index}].kind`);
    nonEmptyString(run.command, `runs[${index}].command`);
    integer(run.exitCode, `runs[${index}].exitCode`);
    isoDate(run.completedAt, `runs[${index}].completedAt`);
  }
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SessionStateError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw new SessionStateError(`${field} must be an array`);
  return value;
}

function stringArray(value: unknown, field: string): void {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new SessionStateError(`${field} must be an array of strings`);
  }
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new SessionStateError(`${field} must be a non-empty string`);
  }
  return value;
}

function boolean(value: unknown, field: string): void {
  if (typeof value !== "boolean") throw new SessionStateError(`${field} must be a boolean`);
}

function integer(value: unknown, field: string): void {
  if (!Number.isInteger(value)) throw new SessionStateError(`${field} must be an integer`);
}

function nonNegativeInteger(value: unknown, field: string): void {
  integer(value, field);
  if ((value as number) < 0) throw new SessionStateError(`${field} must be non-negative`);
}

function isoDate(value: unknown, field: string): void {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new SessionStateError(`${field} must be an ISO date string`);
  }
}

function oneOf<const T extends readonly string[]>(value: unknown, options: T, field: string): asserts value is T[number] {
  if (typeof value !== "string" || !options.includes(value)) {
    throw new SessionStateError(`${field} must be one of: ${options.join(", ")}`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
