import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DYNAMO_STATE_DIRECTORY,
  SessionRevisionError,
  SessionStateError,
  createSession,
  loadSession,
  sessionPath,
  transitionSession,
} from "../src/session.js";

const COMPILED_SESSION_MODULE = pathToFileURL(resolve(import.meta.dirname, "../dist/session.js")).href;

function fixture(): string {
  return mkdtempSync(join(tmpdir(), "dynamo-session-"));
}

function loadFromFreshProcess(root: string): unknown {
  const script = `import { loadSession } from ${JSON.stringify(COMPILED_SESSION_MODULE)}; process.stdout.write(JSON.stringify(loadSession(process.argv[1])));`;
  return JSON.parse(execFileSync("node", ["--input-type=module", "--eval", script, root], { encoding: "utf8" }));
}

describe("repository-local Dynamo sessions", () => {
  it("resumes persisted progress and approvals from the repository after restart", () => {
    const root = fixture();
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    let session = createSession(root, new Date("2026-08-10T10:00:00.000Z"));
    session = transitionSession(
      root,
      session.revision,
      (draft) => {
        draft.discovery.projectStructure = ["src", "tests"];
        draft.discovery.testCommands = ["npm test"];
        draft.discovery.confirmed = true;
        draft.focus = { area: "session recovery", boundary: null };
        draft.phase = "concern-selected";
      },
      new Date("2026-08-10T10:01:00.000Z"),
    );
    session = transitionSession(root, session.revision, (draft) => {
      draft.focus!.boundary = "approved requirements survive restart";
      draft.phase = "boundary-confirmed";
    });
    session = transitionSession(root, session.revision, (draft) => {
      draft.requirements = [
        { id: "first-run-flow.1.2", text: "Progress survives restart", approval: "pending" },
      ];
      draft.phase = "requirements-drafted";
    });
    transitionSession(root, session.revision, (draft) => {
      draft.requirements[0].approval = "approved";
      draft.phase = "requirements-approved";
    });

    // A separate Node process has no in-memory state from the writer and
    // represents Dynamo starting again after the prior process exits.
    const resumed = loadFromFreshProcess(root);
    expect(resumed).toMatchObject({
      schemaVersion: 1,
      revision: 4,
      phase: "requirements-approved",
      discovery: { testCommands: ["npm test"], confirmed: true },
      focus: { area: "session recovery", boundary: "approved requirements survive restart" },
      requirements: [{ id: "first-run-flow.1.2", approval: "approved" }],
    });
    expect(JSON.parse(readFileSync(sessionPath(root), "utf8"))).toEqual(resumed);
  });

  it("rejects a stale writer without replacing newer progress", () => {
    const root = fixture();
    const initial = createSession(root);
    const current = transitionSession(root, initial.revision, (draft) => {
      draft.discovery.projectStructure = ["src"];
    });

    expect(() =>
      transitionSession(root, initial.revision, (draft) => {
        draft.discovery.projectStructure = ["stale"];
      }),
    ).toThrow(SessionRevisionError);
    expect(loadSession(root)).toEqual(current);
  });

  it("does not remove another process's lock or replace its snapshot", () => {
    const root = fixture();
    const initial = createSession(root);
    const lockPath = join(root, DYNAMO_STATE_DIRECTORY, "session.json.lock");
    writeFileSync(lockPath, "12345\n");

    expect(() =>
      transitionSession(root, initial.revision, (draft) => {
        draft.discovery.projectStructure = ["concurrent write"];
      }),
    ).toThrow("Dynamo session is locked by another process");
    expect(readFileSync(lockPath, "utf8")).toBe("12345\n");
    expect(loadSession(root)).toEqual(initial);
  });

  it("refuses a symlinked lock without writing through or removing it", () => {
    const root = fixture();
    const initial = createSession(root);
    const lockPath = join(root, DYNAMO_STATE_DIRECTORY, "session.json.lock");
    const outsideTarget = join(root, "outside-lock-target");
    symlinkSync(outsideTarget, lockPath);

    expect(() => transitionSession(root, initial.revision, () => {})).toThrow("symlinked Dynamo session lock");
    expect(lstatSync(lockPath).isSymbolicLink()).toBe(true);
    expect(existsSync(outsideTarget)).toBe(false);
    expect(loadSession(root)).toEqual(initial);
  });

  it("rejects skipped forward phases and leaves the prior snapshot intact", () => {
    const root = fixture();
    const initial = createSession(root);

    expect(() =>
      transitionSession(root, initial.revision, (draft) => {
        draft.phase = "requirements-drafted";
      }),
    ).toThrow("Invalid Dynamo session transition from discovering to requirements-drafted");
    expect(loadSession(root)).toEqual(initial);
  });

  it("rejects unsupported or malformed persisted state", () => {
    const root = fixture();
    createSession(root);
    const stored = JSON.parse(readFileSync(sessionPath(root), "utf8"));
    writeFileSync(sessionPath(root), `${JSON.stringify({ ...stored, schemaVersion: 2 })}\n`);
    expect(() => loadSession(root)).toThrow("Unsupported Dynamo session schema version 2");

    writeFileSync(sessionPath(root), "not json\n");
    expect(() => loadSession(root)).toThrow(SessionStateError);
  });

  it("publishes complete snapshots without leaving temporary files", () => {
    const root = fixture();
    const initial = createSession(root);
    transitionSession(root, initial.revision, (draft) => {
      draft.discovery.existing2119Artifacts = [".2119.yml"];
    });

    expect(readdirSync(join(root, DYNAMO_STATE_DIRECTORY))).toEqual(["session.json"]);
    expect(() => JSON.parse(readFileSync(sessionPath(root), "utf8"))).not.toThrow();
  });
});
