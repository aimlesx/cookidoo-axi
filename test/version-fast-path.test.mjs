import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(PROJECT_ROOT, "bin/cookidoo-axi.mjs");

function elapsed(arguments_) {
  const started = performance.now();
  const result = spawnSync(process.execPath, arguments_, {
    cwd: PROJECT_ROOT,
    encoding: "utf8",
  });
  const duration = performance.now() - started;
  assert.equal(result.status, 0, result.stderr);
  return duration;
}

function median(values) {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.floor(ordered.length / 2)];
}

test("version remains a process-start-relative fast path", () => {
  const commands = {
    baseline: ["--input-type=module", "--eval", ""],
    version: [CLI, "--version"],
    help: [CLI, "--help"],
  };
  for (const arguments_ of Object.values(commands)) elapsed(arguments_);

  const samples = { baseline: [], version: [], help: [] };
  const names = Object.keys(commands);
  for (let round = 0; round < 7; round += 1) {
    for (let offset = 0; offset < names.length; offset += 1) {
      const name = names[(round + offset) % names.length];
      samples[name].push(elapsed(commands[name]));
    }
  }

  const baseline = median(samples.baseline);
  const version = median(samples.version);
  const help = median(samples.help);
  const versionOverhead = Math.max(0, version - baseline);
  const commandGraphOverhead = Math.max(0.001, help - baseline);
  const evidence = `baseline=${baseline.toFixed(2)}ms version=${version.toFixed(2)}ms help=${help.toFixed(2)}ms`;

  assert.ok(version <= baseline * 2, `version exceeded twice process-start cost: ${evidence}`);
  assert.ok(
    versionOverhead <= commandGraphOverhead * 0.75,
    `version approached full command-graph overhead: ${evidence}`,
  );
});
