import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import test from "node:test";

import { run } from "../dist/cli.js";
import { installSkill, readBundledSkill, removeSkill } from "../dist/setup.js";
import { VERSION } from "../dist/version.js";

const bundledSkillUrl = new URL("../skills/cookidoo-axi/SKILL.md", import.meta.url);
const managedFile = ".cookidoo-axi-managed.json";

function errorCode(code) {
  return (error) => {
    assert.equal(error?.code, code);
    return true;
  };
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function fixture(t, suffix = "") {
  const created = await mkdtemp(join(tmpdir(), `cookidoo-axi-skill-test-${suffix}`));
  const root = await realpath(created);
  t.after(() => rm(root, { recursive: true, force: true }));
  const skillsDirectory = join(root, "skills root's");
  await mkdir(skillsDirectory);
  return { root, skillsDirectory, skillDirectory: join(skillsDirectory, "cookidoo-axi") };
}

function shellArgv(command) {
  const output = execFileSync("/bin/sh", ["-c", `set -- ${command}\nprintf '%s\\0' "$@"`], {
    encoding: "utf8",
  });
  return output.slice(0, -1).split("\0");
}

function outputBuffer() {
  let value = "";
  return { stream: { write(chunk) { value += String(chunk); } }, read: () => value };
}

test("skill install copies exact bundled bytes, records ownership, and is idempotent", async (t) => {
  const { skillsDirectory, skillDirectory } = await fixture(t, "install-");
  const bundled = await readFile(bundledSkillUrl);

  const first = await installSkill({ skillsDirectory });
  assert.equal(first.result, "installed");
  assert.equal(first.skillsDirectory, skillsDirectory);
  assert.equal(first.skillDirectory, skillDirectory);
  assert.deepEqual(first.files, ["SKILL.md", managedFile]);
  assert.deepEqual(first.hash, { algorithm: "sha256", value: sha256(bundled) });
  assert.deepEqual(first.installer, { name: "cookidoo-axi", version: VERSION });
  assert.deepEqual(await readFile(join(skillDirectory, "SKILL.md")), bundled);

  const manifest = JSON.parse(await readFile(join(skillDirectory, managedFile), "utf8"));
  assert.deepEqual(manifest, {
    schemaVersion: 1,
    name: "cookidoo-axi",
    hash: { algorithm: "sha256", value: sha256(bundled) },
    installer: { name: "cookidoo-axi", version: VERSION },
  });
  assert.deepEqual(shellArgv(first.removeCommand), [
    "cookidoo-axi",
    "skill",
    "remove",
    "--skills-directory",
    skillsDirectory,
    "--confirm",
    skillDirectory,
  ]);

  const second = await installSkill({ skillsDirectory });
  assert.equal(second.result, "already_current");
  assert.deepEqual(await readdir(skillDirectory).then((entries) => entries.sort()), [
    managedFile,
    "SKILL.md",
  ]);
  assert.deepEqual(await readFile(join(skillDirectory, "SKILL.md")), bundled);
});

test("skill install safely updates an unmodified older managed version", async (t) => {
  const { skillsDirectory, skillDirectory } = await fixture(t, "update-");
  await installSkill({ skillsDirectory });
  const oldSkill = Buffer.from("---\nname: cookidoo-axi\ndescription: old fixture\n---\n", "utf8");
  await writeFile(join(skillDirectory, "SKILL.md"), oldSkill);
  await writeFile(join(skillDirectory, managedFile), `${JSON.stringify({
    schemaVersion: 1,
    name: "cookidoo-axi",
    hash: { algorithm: "sha256", value: sha256(oldSkill) },
    installer: { name: "cookidoo-axi", version: "0.0.1" },
  }, null, 2)}\n`);

  const result = await installSkill({ skillsDirectory });
  assert.equal(result.result, "updated");
  assert.deepEqual(
    await readFile(join(skillDirectory, "SKILL.md")),
    await readFile(bundledSkillUrl),
  );
  const manifest = JSON.parse(await readFile(join(skillDirectory, managedFile), "utf8"));
  assert.equal(manifest.installer.version, VERSION);
  assert.equal(manifest.hash.value, sha256(await readFile(bundledSkillUrl)));
});

test("skill removal requires the exact child path and never removes the skills root", async (t) => {
  const { skillsDirectory, skillDirectory } = await fixture(t, "remove-");
  const siblingFile = join(skillsDirectory, "user-owned.txt");
  const siblingDirectory = join(skillsDirectory, "another-skill");
  await writeFile(siblingFile, "preserve me\n");
  await mkdir(siblingDirectory);
  await installSkill({ skillsDirectory });

  await assert.rejects(
    removeSkill({ skillsDirectory, confirm: `${skillDirectory}/` }),
    errorCode("CONFIRMATION_REQUIRED"),
  );
  assert.equal(await exists(join(skillDirectory, "SKILL.md")), true);

  const removed = await removeSkill({ skillsDirectory, confirm: skillDirectory });
  assert.equal(removed.result, "removed");
  assert.equal(removed.skillDirectory, skillDirectory);
  assert.deepEqual(removed.files, ["SKILL.md", managedFile]);
  assert.equal(await exists(skillDirectory), false);
  assert.equal(await exists(skillsDirectory), true);
  assert.equal(await readFile(siblingFile, "utf8"), "preserve me\n");
  assert.equal(await exists(siblingDirectory), true);

  await assert.rejects(
    removeSkill({ skillsDirectory }),
    errorCode("CONFIRMATION_REQUIRED"),
  );
  const absent = await removeSkill({ skillsDirectory, confirm: skillDirectory });
  assert.equal(absent.result, "already_absent");
  assert.deepEqual(absent.files, []);
  assert.equal(await exists(skillsDirectory), true);
});

test("skill lifecycle rejects unmanaged, legacy, modified, extra, and invalid targets without writes", async (t) => {
  const empty = await fixture(t, "empty-unmanaged-");
  await mkdir(empty.skillDirectory);
  await assert.rejects(
    installSkill({ skillsDirectory: empty.skillsDirectory }),
    errorCode("SKILL_UNMANAGED"),
  );
  assert.deepEqual(await readdir(empty.skillDirectory), []);

  const unmanaged = await fixture(t, "unmanaged-");
  await mkdir(unmanaged.skillDirectory);
  await writeFile(join(unmanaged.skillDirectory, "SKILL.md"), "# user-owned\n");
  await assert.rejects(
    installSkill({ skillsDirectory: unmanaged.skillsDirectory }),
    errorCode("SKILL_UNMANAGED"),
  );
  assert.equal(await readFile(join(unmanaged.skillDirectory, "SKILL.md"), "utf8"), "# user-owned\n");
  assert.equal(await exists(join(unmanaged.skillDirectory, managedFile)), false);

  const legacy = await fixture(t, "legacy-");
  await mkdir(legacy.skillDirectory);
  const legacyContent = "<!-- generated-by: cookidoo-axi -->\n# old\n";
  await writeFile(join(legacy.skillDirectory, "SKILL.md"), legacyContent);
  await assert.rejects(
    installSkill({ skillsDirectory: legacy.skillsDirectory }),
    errorCode("LEGACY_SKILL_CONFLICT"),
  );
  assert.equal(await readFile(join(legacy.skillDirectory, "SKILL.md"), "utf8"), legacyContent);

  const modified = await fixture(t, "modified-");
  await installSkill({ skillsDirectory: modified.skillsDirectory });
  await writeFile(join(modified.skillDirectory, "SKILL.md"), "# local edit\n");
  await assert.rejects(
    installSkill({ skillsDirectory: modified.skillsDirectory }),
    errorCode("SKILL_MODIFIED"),
  );
  await assert.rejects(
    removeSkill({ skillsDirectory: modified.skillsDirectory, confirm: modified.skillDirectory }),
    errorCode("SKILL_MODIFIED"),
  );
  assert.equal(await readFile(join(modified.skillDirectory, "SKILL.md"), "utf8"), "# local edit\n");

  const extra = await fixture(t, "extra-");
  await installSkill({ skillsDirectory: extra.skillsDirectory });
  await writeFile(join(extra.skillDirectory, "notes.md"), "user-owned\n");
  await assert.rejects(
    removeSkill({ skillsDirectory: extra.skillsDirectory, confirm: extra.skillDirectory }),
    errorCode("SKILL_EXTRA_FILES"),
  );
  assert.equal(await readFile(join(extra.skillDirectory, "notes.md"), "utf8"), "user-owned\n");
  assert.equal(await exists(join(extra.skillDirectory, "SKILL.md")), true);

  const invalid = await fixture(t, "invalid-");
  await installSkill({ skillsDirectory: invalid.skillsDirectory });
  await writeFile(join(invalid.skillDirectory, managedFile), "{}\n");
  await assert.rejects(
    installSkill({ skillsDirectory: invalid.skillsDirectory }),
    errorCode("SKILL_MANIFEST_INVALID"),
  );
  assert.equal(await readFile(join(invalid.skillDirectory, managedFile), "utf8"), "{}\n");
});

test("skill lifecycle refuses symlinked target and parent components", async (t) => {
  const target = await fixture(t, "target-link-");
  const outside = join(target.root, "outside");
  await mkdir(outside);
  await symlink(outside, target.skillDirectory);
  await assert.rejects(
    installSkill({ skillsDirectory: target.skillsDirectory }),
    errorCode("UNSAFE_SKILL_PATH"),
  );
  assert.deepEqual(await readdir(outside), []);

  const parent = await fixture(t, "parent-link-");
  const actual = join(parent.root, "actual");
  const actualSkills = join(actual, "skills");
  await mkdir(actualSkills, { recursive: true });
  const linked = join(parent.root, "linked");
  await symlink(actual, linked);
  await assert.rejects(
    installSkill({ skillsDirectory: join(linked, "skills") }),
    errorCode("UNSAFE_SKILL_PATH"),
  );
  assert.deepEqual(await readdir(actualSkills), []);
});

test("skill lifecycle requires an existing explicit skills root", async (t) => {
  const { root } = await fixture(t, "missing-root-");
  const missing = join(root, "does-not-exist");
  await assert.rejects(
    installSkill({ skillsDirectory: missing }),
    errorCode("SKILLS_DIRECTORY_UNAVAILABLE"),
  );
  assert.equal(await exists(missing), false);
});

test("skill lifecycle resolves a relative root and rejects an empty bundled source", async (t) => {
  const { skillsDirectory, skillDirectory } = await fixture(t, "relative-");
  const relativeSkillsDirectory = relative(process.cwd(), skillsDirectory);
  const installed = await installSkill({ skillsDirectory: relativeSkillsDirectory });
  assert.equal(installed.skillsDirectory, skillsDirectory);
  assert.equal(installed.skillDirectory, skillDirectory);
  assert.equal(isAbsolute(installed.skillsDirectory), true);
  assert.equal(isAbsolute(installed.skillDirectory), true);
  await removeSkill({
    skillsDirectory: relativeSkillsDirectory,
    confirm: skillDirectory,
  });

  const emptySkill = join(skillsDirectory, "empty-SKILL.md");
  await writeFile(emptySkill, "");
  await assert.rejects(
    readBundledSkill(emptySkill),
    errorCode("BUNDLED_SKILL_UNAVAILABLE"),
  );
});

test("CLI emits structured lifecycle results and legacy commands fail before side effects", async (t) => {
  const { root, skillsDirectory, skillDirectory } = await fixture(t, "cli-");
  const stdout = outputBuffer();
  const stderr = outputBuffer();
  const installedCode = await run([
    "skill", "install", "--skills-directory", skillsDirectory, "--output", "json",
  ], { platform: "darwin", stdout: stdout.stream, stderr: stderr.stream });
  process.exitCode = undefined;
  assert.equal(installedCode, 0, stderr.read());
  const installed = JSON.parse(stdout.read());
  assert.equal(installed.data.result, "installed");
  assert.equal(installed.data.skillDirectory, skillDirectory);
  assert.match(installed.data.removeCommand, /^cookidoo-axi skill remove /u);
  assert.equal(stderr.read(), "");

  const missingConfirmOut = outputBuffer();
  const missingConfirmCode = await run([
    "skill", "remove", "--skills-directory", skillsDirectory, "--output", "json",
  ], { platform: "darwin", stdout: missingConfirmOut.stream });
  process.exitCode = undefined;
  assert.equal(missingConfirmCode, 2);
  const missingConfirm = JSON.parse(missingConfirmOut.read()).data.error;
  assert.equal(missingConfirm.code, "CONFIRMATION_REQUIRED");
  assert.equal(missingConfirm.details.expected, skillDirectory);
  assert.equal(await exists(join(skillDirectory, "SKILL.md")), true);

  const unsupportedDryRunOut = outputBuffer();
  const unsupportedDryRunCode = await run([
    "skill", "remove", "--skills-directory", skillsDirectory,
    "--confirm", skillDirectory, "--dry-run", "--output", "json",
  ], { platform: "darwin", stdout: unsupportedDryRunOut.stream });
  process.exitCode = undefined;
  assert.equal(unsupportedDryRunCode, 2);
  const unsupportedDryRun = JSON.parse(unsupportedDryRunOut.read()).data.error;
  assert.equal(unsupportedDryRun.code, "INVALID_OPTION");
  assert.equal(unsupportedDryRun.details.flag, "--dry-run");
  assert.equal(await exists(join(skillDirectory, "SKILL.md")), true);

  const removedOut = outputBuffer();
  const removedCode = await run([
    "skill", "remove", "--skills-directory", skillsDirectory,
    "--confirm", skillDirectory, "--output", "json",
  ], { platform: "darwin", stdout: removedOut.stream });
  process.exitCode = undefined;
  assert.equal(removedCode, 0);
  assert.equal(JSON.parse(removedOut.read()).data.result, "removed");
  assert.equal(await exists(skillDirectory), false);

  const legacyRoot = join(root, "legacy untouched");
  await mkdir(legacyRoot);
  for (const argv of [
    ["setup", "codex", "--directory", legacyRoot, "--output", "json"],
    ["setup", "remove", "--directory", legacyRoot, "--confirm", legacyRoot, "--output", "json"],
    ["hook", "session-start", "--output", "json"],
  ]) {
    const legacyOut = outputBuffer();
    const code = await run(argv, { platform: "darwin", stdout: legacyOut.stream });
    process.exitCode = undefined;
    assert.equal(code, 2);
    const error = JSON.parse(legacyOut.read()).data.error;
    assert.equal(error.code, "LEGACY_COMMAND_REMOVED");
    assert.match(error.suggestions[0], /^cookidoo-axi skill install|^cookidoo-axi skill remove/u);
    assert.deepEqual(await readdir(legacyRoot), []);
  }

  const missingRootOut = outputBuffer();
  const missingRootCode = await run([
    "skill", "install", "--skills-directory", join(root, "missing"), "--output", "json",
  ], { platform: "darwin", stdout: missingRootOut.stream });
  process.exitCode = undefined;
  assert.equal(missingRootCode, 1);
  const missingRootError = JSON.parse(missingRootOut.read()).data.error;
  assert.equal(missingRootError.code, "SKILLS_DIRECTORY_UNAVAILABLE");
  assert.equal(missingRootError.category, "operational");
});
