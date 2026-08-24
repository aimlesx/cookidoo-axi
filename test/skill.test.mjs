import assert from "node:assert/strict";
import { lstat, readFile, readdir, readlink, realpath } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import YAML from "yaml";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKILL_DIRECTORY = path.join(PROJECT_ROOT, "skills", "cookidoo-axi");
const SKILL_PATH = path.join(SKILL_DIRECTORY, "SKILL.md");
const README_PATH = path.join(PROJECT_ROOT, "README.md");

test("one portable skill is discoverable by Codex and Claude Code", async () => {
  assert.deepEqual(await readdir(SKILL_DIRECTORY), ["SKILL.md"]);
  const canonicalDirectory = await realpath(SKILL_DIRECTORY);

  for (const relative of [
    ".agents/skills/cookidoo-axi",
    ".claude/skills/cookidoo-axi",
  ]) {
    const discoveryPath = path.join(PROJECT_ROOT, relative);
    assert.equal((await lstat(discoveryPath)).isSymbolicLink(), true, relative);
    assert.equal(await readlink(discoveryPath), "../../skills/cookidoo-axi", relative);
    assert.equal(await realpath(discoveryPath), canonicalDirectory, relative);
  }
});

test("skill metadata is portable and release execution fails closed", async () => {
  const source = await readFile(SKILL_PATH, "utf8");
  const frontmatter = source.match(/^---\n([\s\S]*?)\n---\n/u);
  assert.ok(frontmatter, "SKILL.md must begin with YAML frontmatter");
  const metadata = YAML.parse(frontmatter[1]);
  assert.deepEqual(Object.keys(metadata).sort(), [
    "compatibility",
    "description",
    "license",
    "name",
  ]);
  assert.equal(metadata.name, "cookidoo-axi");
  assert.equal(metadata.license, "MIT");
  assert.equal(typeof metadata.description, "string");
  assert.ok(metadata.description.length > 0);
  assert.ok(metadata.description.length <= 1_024);
  assert.doesNotMatch(metadata.description, /[<>]/u);
  assert.equal(typeof metadata.compatibility, "string");
  assert.ok(metadata.compatibility.length > 0);
  assert.ok(metadata.compatibility.length <= 500);

  assert.match(source, /command -v cookidoo-axi/u);
  assert.match(source, /brew --prefix cookidoo-axi/u);
  assert.match(source, /realpath "\$cookidoo_axi_path"/u);
  assert.match(source, /realpath "\$cookidoo_axi_bin"/u);
  assert.match(source, /\$cookidoo_axi_prefix\/bin\/cookidoo-axi/u);
  assert.match(source, /"\$cookidoo_axi_bin" auth doctor --output json/u);
  assert.match(source, /PATH shadows the Formula/u);
  assert.match(source, /keychainAccess: not-requested/u);
  assert.match(source, /Never invoke\s+`bin\/cookidoo-axi\.mjs`/u);
  assert.match(source, /If Homebrew or the Formula is missing, stop/u);
  assert.match(source, /brew install aimlesx\/tap\/cookidoo-axi/u);
  assert.match(source, /brew upgrade aimlesx\/tap\/cookidoo-axi/u);
  assert.match(source, /CLI\/skill version mismatch/u);
  assert.doesNotMatch(source, /generated-by: cookidoo-axi/u);
});

test("README documents source aliases, release installation, and beta migration", async () => {
  const readme = await readFile(README_PATH, "utf8");
  assert.match(readme, /skills\/cookidoo-axi\/SKILL\.md/u);
  assert.match(readme, /\.agents\/skills\/cookidoo-axi/u);
  assert.match(readme, /\.claude\/skills\/cookidoo-axi/u);
  assert.match(readme, /cookidoo-axi skill install[\s\S]*--skills-directory/u);
  assert.match(readme, /cookidoo-axi skill remove[\s\S]*--confirm/u);
  assert.match(readme, /trusted checkout pinned to a release tag or[\s]+commit/u);
  assert.match(readme, /will not fetch a mutable branch/u);
  assert.match(readme, /retained[\s]+`0\.1\.0-beta\.1` executable/u);
  assert.match(readme, /LEGACY_SKILL_CONFLICT/u);
  assert.match(readme, /including `\.codex\/hooks\.json`/u);
});
