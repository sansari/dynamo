import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const GENERATOR = resolve(import.meta.dirname, "../scripts/create-example-repo.mjs");

function destination(): string {
  return join(mkdtempSync(join(tmpdir(), "dynamo-demo-parent-")), "promotion-shop");
}

describe("generated first-run example repository", () => {
  it("materializes a clean Git repository whose existing tests pass", () => {
    const root = destination();
    const output = execFileSync("node", [GENERATOR, root], { encoding: "utf8" });

    expect(output).toContain(`Created promotion-shop at ${root}`);
    expect(output).toContain("Promotion eligibility and discount limits worry me");
    expect(existsSync(join(root, ".git"))).toBe(true);
    expect(JSON.parse(readFileSync(join(root, "package.json"), "utf8"))).toMatchObject({
      scripts: { test: "node --test" },
    });
    expect(readdirSync(join(root, "test"))).toEqual(["discounts.test.js"]);
    expect(execFileSync("npm", ["test"], { cwd: root, encoding: "utf8" })).toContain("pass 2");
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" })).toBe("");
  });

  it("refuses to overwrite a non-empty destination", () => {
    const root = destination();
    mkdirSync(root);
    const marker = join(root, "user-owned.txt");
    writeFileSync(marker, "occupied");

    expect(() => execFileSync("node", [GENERATOR, root], { encoding: "utf8", stdio: "pipe" })).toThrow();
    expect(readFileSync(marker, "utf8")).toBe("occupied");
  });
});
