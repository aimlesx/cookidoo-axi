import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { realpath } from "node:fs/promises";
import test from "node:test";

import {
  installCodexIntegration,
  removeCodexIntegration,
  sessionStartContext,
} from "../dist/setup.js";

function errorCode(code) {
  return (error) => {
    assert.equal(error?.code, code);
    return true;
  };
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

test("Codex setup is idempotent and preserves unrelated project hooks", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cookidoo-axi-setup-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const hooksPath = join(root, ".codex", "hooks.json");
  const skillPath = join(root, ".agents", "skills", "cookidoo-axi", "SKILL.md");
  await mkdir(join(root, ".codex"), { recursive: true });
  const original = {
    customTopLevel: { preserved: true },
    hooks: {
      SessionStart: [{
        matcher: "startup",
        customGroupField: "preserved",
        hooks: [{ type: "command", command: "user-owned-command", statusMessage: "User hook" }],
      }],
      PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "user-policy" }] }],
    },
  };
  await writeFile(hooksPath, `${JSON.stringify(original, null, 2)}\n`, "utf8");
  const executablePath = join(root, "bin", "cookidoo'axi");

  const first = await installCodexIntegration({ directory: root, executablePath });
  const second = await installCodexIntegration({ directory: root, executablePath });
  assert.equal(first.result, "installed");
  assert.equal(second.result, "installed");
  assert.deepEqual(first.files.sort(), [
    ".agents/skills/cookidoo-axi/SKILL.md",
    ".codex/hooks.json",
  ]);
  assert.deepEqual(first.codexUiActions, [
    { input: "/hooks", description: "Review the installed workspace hook in Codex." },
    { input: "$cookidoo-axi", description: "Invoke the installed Codex skill." },
  ]);
  assert.equal(Object.hasOwn(first, "nextCommands"), false);

  const hooks = JSON.parse(await readFile(hooksPath, "utf8"));
  assert.deepEqual(hooks.customTopLevel, original.customTopLevel);
  assert.deepEqual(hooks.hooks.PreToolUse, original.hooks.PreToolUse);
  const userHandlers = hooks.hooks.SessionStart.flatMap(({ hooks }) => hooks)
    .filter(({ statusMessage }) => statusMessage === "User hook");
  const generatedHandlers = hooks.hooks.SessionStart.flatMap(({ hooks }) => hooks)
    .filter(({ statusMessage }) => statusMessage === "Loading cookidoo-axi context [managed:v1]");
  assert.equal(userHandlers.length, 1);
  assert.equal(generatedHandlers.length, 1);
  assert.match(generatedHandlers[0].command, /hook session-start$/u);
  assert.match(generatedHandlers[0].command, /'"'"'/u);
  assert.equal(generatedHandlers[0].additionalContextLimit, 1000);
  assert.equal(generatedHandlers[0].timeout, 3);

  const skill = await readFile(skillPath, "utf8");
  assert.match(skill, /^---\nname: cookidoo-axi\n/u);
  assert.match(skill, /generated-by: cookidoo-axi/u);
  assert.match(skill, /Never retry a mutation after a timeout or transport failure/u);
  assert.match(skill, /Do not delete, clear, publish, rate, share, link, or unlink/u);
  assert.match(skill, /profile get-localized/u);
  assert.match(skill, /Bare `auth status` is prompt-free/u);
  assert.match(skill, /reports all record states as not-checked/u);
  assert.match(skill, /--inspect session\|market\|feed/u);
  assert.match(skill, /--inspect all.*all three sequentially/u);
  assert.match(skill, /Always Allow.*executable identified/u);
  assert.match(skill, /may prompt again if the executable changes/u);
  assert.match(skill, /trust applies to the exact Node binary, not only this CLI/u);
});

test("setup refuses to overwrite malformed hooks or an unowned skill", async (t) => {
  const malformedRoot = await mkdtemp(join(tmpdir(), "cookidoo-axi-setup-malformed-"));
  t.after(() => rm(malformedRoot, { recursive: true, force: true }));
  const malformedHooks = join(malformedRoot, ".codex", "hooks.json");
  await mkdir(join(malformedRoot, ".codex"), { recursive: true });
  await writeFile(malformedHooks, "{ definitely not json", "utf8");
  await assert.rejects(
    installCodexIntegration({ directory: malformedRoot, executablePath: "/opt/cookidoo-axi" }),
    errorCode("INVALID_HOOKS_FILE"),
  );
  assert.equal(await readFile(malformedHooks, "utf8"), "{ definitely not json");

  const unownedRoot = await mkdtemp(join(tmpdir(), "cookidoo-axi-setup-unowned-"));
  t.after(() => rm(unownedRoot, { recursive: true, force: true }));
  const skillPath = join(unownedRoot, ".agents", "skills", "cookidoo-axi", "SKILL.md");
  await mkdir(join(unownedRoot, ".agents", "skills", "cookidoo-axi"), { recursive: true });
  await writeFile(skillPath, "# User-owned Cookidoo instructions\n", "utf8");
  await assert.rejects(
    installCodexIntegration({ directory: unownedRoot, executablePath: "/opt/cookidoo-axi" }),
    errorCode("SKILL_EXISTS"),
  );
  assert.equal(await readFile(skillPath, "utf8"), "# User-owned Cookidoo instructions\n");
  assert.equal(await exists(join(unownedRoot, ".codex", "hooks.json")), false);
});

test("setup removal requires the exact resolved directory and removes only generated entries", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cookidoo-axi-setup-remove-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const hooksPath = join(root, ".codex", "hooks.json");
  const skillPath = join(root, ".agents", "skills", "cookidoo-axi", "SKILL.md");
  await mkdir(join(root, ".codex"), { recursive: true });
  await writeFile(hooksPath, JSON.stringify({
    hooks: {
      SessionStart: [{
        matcher: "startup",
        hooks: [{ type: "command", command: "user-owned-command", statusMessage: "User hook" }],
      }],
    },
  }), "utf8");
  await installCodexIntegration({ directory: root, executablePath: "/opt/cookidoo-axi" });

  await assert.rejects(
    removeCodexIntegration({ directory: root, confirm: `${resolve(root)}/` }),
    errorCode("CONFIRMATION_REQUIRED"),
  );
  assert.equal(await exists(skillPath), true);

  const canonicalRoot = await realpath(root);
  const removed = await removeCodexIntegration({ directory: root, confirm: canonicalRoot });
  assert.equal(removed.result, "removed");
  assert.deepEqual(removed.files.sort(), [
    ".agents/skills/cookidoo-axi/SKILL.md",
    ".codex/hooks.json",
  ]);
  assert.equal(await exists(skillPath), false);
  const remainingHooks = JSON.parse(await readFile(hooksPath, "utf8"));
  const remainingHandlers = remainingHooks.hooks.SessionStart.flatMap(({ hooks }) => hooks);
  assert.deepEqual(remainingHandlers, [
    { type: "command", command: "user-owned-command", statusMessage: "User hook" },
  ]);

  const again = await removeCodexIntegration({ directory: root, confirm: canonicalRoot });
  assert.equal(again.result, "already_absent");
  assert.deepEqual(again.files, []);
});

test("session-start hook output uses the current hook protocol and contains no credentials", () => {
  const context = sessionStartContext("/opt/tools/cookidoo-axi");
  assert.deepEqual(Object.keys(context).sort(), ["continue", "hookSpecificOutput"]);
  assert.equal(context.continue, true);
  assert.equal(context.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(context.hookSpecificOutput.additionalContext, /macOS Keychain/u);
  assert.match(context.hookSpecificOutput.additionalContext, /Keychain-free scope/u);
  assert.match(context.hookSpecificOutput.additionalContext, /profile get-localized/u);
  assert.match(context.hookSpecificOutput.additionalContext, /Bare `auth status` is prompt-free/u);
  assert.match(context.hookSpecificOutput.additionalContext, /reports not-checked/u);
  assert.match(context.hookSpecificOutput.additionalContext, /--inspect all.*all three sequentially/u);
  assert.match(context.hookSpecificOutput.additionalContext, /Always Allow.*identified/u);
  assert.match(context.hookSpecificOutput.additionalContext, /trust applies to the exact Node binary/u);
  assert.doesNotMatch(context.hookSpecificOutput.additionalContext, /password|COOKIDOO_EMAIL/u);
});

test("setup rejects nonexistent scope directories", async () => {
  const missing = join(tmpdir(), `cookidoo-axi-does-not-exist-${process.pid}`);
  await assert.rejects(
    installCodexIntegration({ directory: missing, executablePath: "/opt/cookidoo-axi" }),
    errorCode("INVALID_DIRECTORY"),
  );
});

test("setup refuses symlinked generated parents and cannot write outside scope", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cookidoo-axi-setup-symlink-"));
  const outside = await mkdtemp(join(tmpdir(), "cookidoo-axi-setup-outside-"));
  t.after(() => Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(outside, { recursive: true, force: true }),
  ]));
  await symlink(outside, join(root, ".codex"));
  await assert.rejects(
    installCodexIntegration({ directory: root, executablePath: "/opt/cookidoo-axi" }),
    errorCode("UNSAFE_SETUP_PATH"),
  );
  assert.equal(await exists(join(outside, "hooks.json")), false);
});
