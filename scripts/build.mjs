#!/usr/bin/env node

import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertExactDistLayout, assertNoUnexpectedDistPaths } from "./dist-layout.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const defaultProjectRoot = resolve(scriptDirectory, "..");

export function build(projectRoot = defaultProjectRoot) {
  const root = resolve(projectRoot);
  assertNoUnexpectedDistPaths(root);
  const compiler = join(root, "node_modules/typescript/bin/tsc");
  const result = spawnSync(process.execPath, [compiler, "-p", join(root, "tsconfig.json")], {
    cwd: root,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status ?? 1;
  else assertExactDistLayout(root);
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    build();
  } catch (error) {
    process.stderr.write(`build: ${error.message}\n`);
    process.exitCode = 1;
  }
}
