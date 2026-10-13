#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const exampleRoot = join(repositoryRoot, "examples/first-run");
const templateRoot = join(exampleRoot, "templates");
const manifest = JSON.parse(readFileSync(join(exampleRoot, "manifest.json"), "utf8"));
const requestedDestination = process.argv[2];
const destination = requestedDestination
  ? resolve(requestedDestination)
  : mkdtempSync(join(tmpdir(), "dynamo-promotion-shop-"));

if (requestedDestination) {
  if (existsSync(destination)) refuseExistingDestination(destination);
  mkdirSync(dirname(destination), { recursive: true });
  try {
    mkdirSync(destination);
  } catch (error) {
    if (error.code === "EEXIST") refuseExistingDestination(destination);
    throw error;
  }
}

materialize(manifest.files, templateRoot, destination);
execFileSync("git", ["init", "--quiet", "--initial-branch=main"], { cwd: destination });
execFileSync("git", ["config", "user.name", "Dynamo Demo"], { cwd: destination });
execFileSync("git", ["config", "user.email", "demo@dynamo.local"], { cwd: destination });
execFileSync("git", ["add", "."], { cwd: destination });
execFileSync("git", ["commit", "--quiet", "-m", "Initial promotion shop"], { cwd: destination });

console.log(`Created ${manifest.name} at ${destination}`);
console.log(`Concern: ${manifest.suggestedConcern}`);
console.log(`Test command: ${manifest.expectedTestCommand}`);

function refuseExistingDestination(path) {
  console.error(`demo:create: destination already exists: ${path}`);
  process.exit(2);
}

function materialize(files, sourceDirectory, targetDirectory) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error("Demo manifest must declare at least one file");
  }
  const outputs = new Set();
  for (const entry of files) {
    if (!entry || typeof entry.template !== "string" || typeof entry.output !== "string") {
      throw new Error("Every demo manifest file needs template and output paths");
    }
    const source = resolve(sourceDirectory, entry.template);
    const target = resolve(targetDirectory, entry.output);
    if (!isContained(sourceDirectory, source) || !isContained(targetDirectory, target)) {
      throw new Error(`Demo manifest paths must stay inside their roots: ${entry.template} -> ${entry.output}`);
    }
    if (outputs.has(target)) throw new Error(`Duplicate demo output path: ${entry.output}`);
    outputs.add(target);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(source));
  }
}

function isContained(root, candidate) {
  const path = relative(resolve(root), candidate);
  return path !== ".." && !path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(path);
}
