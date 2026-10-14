#!/usr/bin/env node

process.env.DYNAMO_CLI_NAME = "dynamo";
await import("./cli.js");
