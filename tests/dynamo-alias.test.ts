import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Dynamo CLI alias", () => {
  it("publishes dynamo and 2119 entry points", () => {
    const packageJson = JSON.parse(readFileSync(resolve(import.meta.dirname, "../package.json"), "utf8"));
    expect(packageJson.bin).toEqual({
      "2119": "dist/cli.js",
      dynamo: "dist/dynamo.js",
    });
    expect(readFileSync(resolve(import.meta.dirname, "../src/dynamo.ts"), "utf8")).toContain(
      'process.env.DYNAMO_CLI_NAME = "dynamo"',
    );
  });
});
