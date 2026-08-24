import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CANONICAL_SKILL_DIRECTORY = path.join(PROJECT_ROOT, "skills", "cookidoo-axi");
const CANONICAL_SKILL = path.join(CANONICAL_SKILL_DIRECTORY, "SKILL.md");

function firstShellBlock(skill) {
  const match = skill.match(/```sh\n([\s\S]*?)\n```/u);
  assert.ok(match, "canonical skill must contain a shell bootstrap block");
  return match[1];
}

function installGuidance(skill) {
  const match = skill.match(/installation guidance: `([^`]+)`/u);
  assert.ok(match, "canonical skill must contain exact missing-Formula guidance");
  return match[1];
}

async function readLog(logPath) {
  try {
    const content = await readFile(logPath, "utf8");
    return content.split("\n").filter(Boolean);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function writeExecutable(filePath, source) {
  await writeFile(filePath, source, "utf8");
  await chmod(filePath, 0o755);
}

async function makeRuntime(t, skillRoot, { formulaMissing = false } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "cookidoo-axi-skill-behavior-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const discoveredSkill = path.join(root, skillRoot, "skills", "cookidoo-axi");
  const fakeBin = path.join(root, "fake-bin");
  const checkoutBin = path.join(root, "checkout", "bin");
  const formulaPrefix = path.join(root, "formula");
  const formulaBin = path.join(formulaPrefix, "bin");
  await Promise.all([
    mkdir(path.dirname(discoveredSkill), { recursive: true }),
    mkdir(fakeBin, { recursive: true }),
    mkdir(checkoutBin, { recursive: true }),
    mkdir(formulaBin, { recursive: true }),
  ]);
  await symlink(CANONICAL_SKILL_DIRECTORY, discoveredSkill, "dir");

  const brewLog = path.join(root, "brew.log");
  const formulaLog = path.join(root, "formula.log");
  const shadowLog = path.join(root, "checkout-shadow.log");
  const checkoutExecutable = path.join(checkoutBin, "cookidoo-axi.mjs");
  await writeExecutable(
    checkoutExecutable,
    "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$SHADOW_LOG\"\nexit 97\n",
  );
  await symlink(checkoutExecutable, path.join(fakeBin, "cookidoo-axi"), "file");

  await writeExecutable(
    path.join(fakeBin, "brew"),
    [
      "#!/bin/sh",
      "printf '%s\\n' \"$*\" >> \"$BREW_LOG\"",
      "if [ \"$#\" -ne 2 ] || [ \"$1\" != \"--prefix\" ] || [ \"$2\" != \"cookidoo-axi\" ]; then",
      "  exit 64",
      "fi",
      "if [ \"$FORMULA_MISSING\" = \"1\" ]; then",
      "  printf '%s\\n' 'fake Formula is missing' >&2",
      "  exit 1",
      "fi",
      "printf '%s\\n' \"$FAKE_FORMULA_PREFIX\"",
      "",
    ].join("\n"),
  );

  if (!formulaMissing) {
    await writeExecutable(
      path.join(formulaBin, "cookidoo-axi"),
      [
        "#!/bin/sh",
        "printf '%s\\n' \"$*\" >> \"$FORMULA_LOG\"",
        "if [ \"$#\" -eq 1 ] && [ \"$1\" = \"--version\" ]; then",
        "  printf '%s\\n' '0.1.0-test'",
        "  exit 0",
        "fi",
        "if [ \"$#\" -eq 4 ] && [ \"$1\" = \"auth\" ] && [ \"$2\" = \"doctor\" ] && [ \"$3\" = \"--output\" ] && [ \"$4\" = \"json\" ]; then",
        "  printf '%s\\n' '{\"data\":{\"platform\":\"darwin\",\"architecture\":\"arm64\",\"keychainBinding\":\"loaded\",\"keychainAccess\":\"not-requested\",\"keychainRecordsRead\":0,\"keychainRecordsWritten\":0,\"networkRequests\":0}}'",
        "  exit 0",
        "fi",
        "exit 65",
        "",
      ].join("\n"),
    );
  }

  const skill = await readFile(path.join(discoveredSkill, "SKILL.md"), "utf8");
  const execution = spawnSync("/bin/sh", ["-c", firstShellBlock(skill)], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      BREW_LOG: brewLog,
      FAKE_FORMULA_PREFIX: formulaPrefix,
      FORMULA_LOG: formulaLog,
      FORMULA_MISSING: formulaMissing ? "1" : "0",
      PATH: `${fakeBin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      SHADOW_LOG: shadowLog,
    },
  });

  return {
    brewLog,
    execution,
    formulaLog,
    shadowLog,
    skill,
  };
}

test("bootstrap selects the verified Formula and ignores checkout shadowing", async (t) => {
  for (const skillRoot of [".agents", ".claude"]) {
    await t.test(skillRoot, async (t) => {
      const runtime = await makeRuntime(t, skillRoot);

      assert.equal(runtime.execution.status, 0, runtime.execution.stderr);
      assert.match(runtime.execution.stderr, /PATH shadows the cookidoo-axi Formula/u);
      assert.deepEqual(await readLog(runtime.brewLog), ["--prefix cookidoo-axi"]);
      assert.deepEqual(await readLog(runtime.formulaLog), [
        "--version",
        "auth doctor --output json",
      ]);
      assert.deepEqual(await readLog(runtime.shadowLog), []);
    });
  }
});

test("missing Formula fails closed and surfaces the skill's install guidance", async (t) => {
  const runtime = await makeRuntime(t, ".agents", { formulaMissing: true });

  assert.equal(runtime.execution.status, 1);
  assert.match(runtime.execution.stderr, /fake Formula is missing/u);
  assert.deepEqual(await readLog(runtime.brewLog), ["--prefix cookidoo-axi"]);
  assert.deepEqual(await readLog(runtime.formulaLog), []);
  assert.deepEqual(await readLog(runtime.shadowLog), []);
  assert.equal(installGuidance(runtime.skill), "brew install aimlesx/tap/cookidoo-axi");
  assert.doesNotMatch((await readLog(runtime.brewLog)).join(" "), /install|upgrade|--dry-run|--confirm/u);
});

test("skill keeps discovery bounded and mutation recovery unambiguous", async () => {
  const skill = await readFile(CANONICAL_SKILL, "utf8");
  const compact = skill.replace(/\s+/gu, " ");

  assert.match(compact, /Filter discovery before it enters context with `operation list --group`, `--risk`, or `--query`/u);
  assert.match(compact, /Start with API-specific limits, `--max-items`, or `--fields` appropriate to the request/u);
  assert.match(compact, /Run that exact request once with `--dry-run --output json`/u);
  assert.match(compact, /copy `data\.safety\.confirmationTarget` verbatim into `--confirm`; never derive or reconstruct it/u);
  assert.match(compact, /add `--allow-unverified` only after the user explicitly accepts that its behavior is not verified/u);
  assert.match(compact, /The CLI does not automatically retry mutations/u);
  assert.match(compact, /ambiguous outcome occurs, do not repeat the mutation/u);
  assert.match(compact, /Execute the validated request exactly once/u);
});

test("skill crosses the Codex sandbox only for commands that access Keychain items", async () => {
  const skill = await readFile(CANONICAL_SKILL, "utf8");
  const compact = skill.replace(/\s+/gu, " ");

  assert.match(compact, /run any command that can read or write a Keychain record outside the Codex Seatbelt sandbox on its first attempt/u);
  assert.match(compact, /Never probe one of these commands inside the sandbox/u);
  assert.match(compact, /not evidence that credentials need importing/u);
  assert.match(compact, /Keep the Formula resolution, `--version`, `auth doctor`, bare `auth status`, help, operation discovery, and API operation dry runs sandboxed/u);
  assert.match(compact, /Use `--inspect all` only when the task specifically requires every record's state/u);
  assert.match(compact, /separate items and can each prompt once/u);
  assert.match(compact, /a Homebrew Node upgrade changes its identity/u);
});
