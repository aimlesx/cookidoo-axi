import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const releaseScript = join(projectRoot, "scripts/prepare-homebrew-release.mjs");
const projectPackage = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8"));

function makeWorkspace(t) {
  const workspace = mkdtempSync(join(tmpdir(), "cookidoo-axi-homebrew-test-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  return workspace;
}

function writeFixturePackage(root, overrides = {}, extraFiles = {}) {
  const packageRoot = join(root, "fixture");
  const metadata = {
    name: projectPackage.name,
    version: projectPackage.version,
    description: "Fixture package for Homebrew release tests",
    private: true,
    license: "MIT",
    os: ["darwin"],
    dependencies: projectPackage.dependencies,
    overrides: projectPackage.overrides,
    bin: { "cookidoo-axi": "bin/cookidoo-axi.mjs" },
    files: [
      "bin",
      "dist",
      "LICENSE",
      "NOTICE",
      "README.md",
      "SECURITY.md",
      "THIRD_PARTY_NOTICES.md",
      ...Object.keys(extraFiles),
    ],
    ...overrides,
  };

  mkdirSync(join(packageRoot, "bin"), { recursive: true });
  mkdirSync(join(packageRoot, "dist/generated"), { recursive: true });
  writeFileSync(join(packageRoot, "package.json"), `${JSON.stringify(metadata, null, 2)}\n`);
  writeFileSync(join(packageRoot, "bin/cookidoo-axi.mjs"), "#!/usr/bin/env node\n");
  chmodSync(join(packageRoot, "bin/cookidoo-axi.mjs"), 0o755);
  writeFileSync(join(packageRoot, "dist/cli.js"), "export const run = () => {};\n");
  writeFileSync(join(packageRoot, "dist/generated/openapi-manifest.json"), "{}\n");
  writeFileSync(join(packageRoot, "LICENSE"), "MIT\n");
  writeFileSync(join(packageRoot, "NOTICE"), "Notice\n");
  writeFileSync(join(packageRoot, "README.md"), "# Fixture\n");
  writeFileSync(join(packageRoot, "SECURITY.md"), "# Security policy\n");
  writeFileSync(join(packageRoot, "THIRD_PARTY_NOTICES.md"), "# Third-party notices\n");

  for (const [relativePath, contents] of Object.entries(extraFiles)) {
    const target = join(packageRoot, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents);
  }
  return packageRoot;
}

function npmPack(workspace, packageRoot) {
  const destination = join(workspace, "artifacts");
  const cache = join(workspace, "npm-cache");
  mkdirSync(destination, { recursive: true });
  const stdout = execFileSync(
    "npm",
    ["pack", "--ignore-scripts", "--json", "--pack-destination", destination, packageRoot],
    {
      cwd: workspace,
      encoding: "utf8",
      env: {
        ...process.env,
        npm_config_cache: cache,
        npm_config_update_notifier: "false",
      },
    },
  );
  const metadata = JSON.parse(stdout);
  const [{ filename }] = metadata;
  const metadataPath = join(workspace, "npm-pack.json");
  writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
  return { artifact: join(destination, filename), metadataPath };
}

function runGenerator(arguments_, options = {}) {
  return spawnSync(process.execPath, [options.script ?? releaseScript, ...arguments_], {
    cwd: options.cwd ?? projectRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function copyReleaseProject(workspace) {
  const copyRoot = join(workspace, "project");
  mkdirSync(copyRoot, { recursive: true });
  for (const relativePath of [
    "bin",
    "dist",
    "scripts",
    "src",
    "LICENSE",
    "NOTICE",
    "README.md",
    "SECURITY.md",
    "THIRD_PARTY_NOTICES.md",
    "homebrew-package-lock.json",
    "package-lock.json",
    "package.json",
  ]) {
    cpSync(join(projectRoot, relativePath), join(copyRoot, relativePath), { recursive: true });
  }
  return copyRoot;
}

test("creates a complete, idempotent release bundle in one command", (t) => {
  const workspace = makeWorkspace(t);
  const artifact = join(workspace, `cookidoo-axi-${projectPackage.version}.tgz`);
  const output = join(workspace, "homebrew-tap/Formula/cookidoo-axi.rb");
  const arguments_ = [
    "--repository", "example/cookidoo-axi",
    "--artifact", artifact,
    "--output", output,
  ];

  const first = runGenerator(arguments_);
  assert.equal(first.status, 0, first.stderr);
  const report = JSON.parse(first.stdout);
  assert.equal(report.artifactStatus, "created");
  assert.equal(report.metadata, join(workspace, "npm-pack.json"));
  assert.equal(report.checksums, join(workspace, "SHA256SUMS"));
  assert.equal(report.formula, output);
  assert.doesNotThrow(() => JSON.parse(readFileSync(report.metadata, "utf8")));
  assert.match(
    readFileSync(report.checksums, "utf8"),
    /^[a-f0-9]{64}  cookidoo-axi-\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\.tgz\n$/u,
  );

  const second = runGenerator(arguments_);
  assert.equal(second.status, 0, second.stderr);
  const secondReport = JSON.parse(second.stdout);
  assert.equal(secondReport.artifactStatus, "unchanged");
  assert.equal(secondReport.metadataStatus, "unchanged");
  assert.equal(secondReport.checksumsStatus, "unchanged");
  assert.equal(secondReport.status, "unchanged");
});

test("refuses a stale same-version bundle without overwriting it", (t) => {
  const workspace = makeWorkspace(t);
  const copyRoot = copyReleaseProject(workspace);
  const copiedScript = join(copyRoot, "scripts/prepare-homebrew-release.mjs");
  const arguments_ = ["--repository", "example/cookidoo-axi"];

  const first = runGenerator(arguments_, { cwd: copyRoot, script: copiedScript });
  assert.equal(first.status, 0, first.stderr);
  const firstReport = JSON.parse(first.stdout);
  const artifactBefore = readFileSync(firstReport.artifact);
  const metadataBefore = readFileSync(firstReport.metadata);
  const formulaBefore = readFileSync(firstReport.formula);

  writeFileSync(join(copyRoot, "README.md"), "# Current source changed without a version bump\n");
  const second = runGenerator(arguments_, { cwd: copyRoot, script: copiedScript });
  assert.equal(second.status, 1);
  assert.match(second.stderr, /Existing release artifact does not match the current package/u);
  assert.deepEqual(readFileSync(firstReport.artifact), artifactBefore);
  assert.deepEqual(readFileSync(firstReport.metadata), metadataBefore);
  assert.deepEqual(readFileSync(firstReport.formula), formulaBefore);
});

test("generates an immutable, macOS-only Homebrew Formula from an npm pack artifact", (t) => {
  const workspace = makeWorkspace(t);
  const { artifact, metadataPath } = npmPack(workspace, projectRoot);
  const output = join(workspace, "tap/Formula/cookidoo-axi.rb");
  const result = runGenerator([
    "--repository", "example/cookidoo-axi",
    "--artifact", artifact,
    "--metadata", metadataPath,
    "--output", output,
  ]);

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  const sha256 = createHash("sha256").update(readFileSync(artifact)).digest("hex");
  const checksums = join(dirname(artifact), "SHA256SUMS");
  assert.deepEqual(report, {
    artifact,
    artifactStatus: "provided",
    checksums,
    checksumsStatus: "created",
    formula: output,
    metadata: metadataPath,
    metadataStatus: "provided",
    repository: "example/cookidoo-axi",
    sha256,
    status: "created",
    version: projectPackage.version,
  });

  const formula = readFileSync(output, "utf8");
  assert.match(
    formula,
    new RegExp(`url "https://github\\.com/example/cookidoo-axi/releases/download/v${projectPackage.version}/cookidoo-axi-${projectPackage.version}\\.tgz"`, "u"),
  );
  assert.match(formula, new RegExp(`sha256 "${sha256}"`, "u"));
  assert.match(formula, /depends_on :macos/u);
  assert.match(formula, /depends_on arch: :arm64/u);
  assert.match(formula, /depends_on "node"/u);
  assert.match(formula, /ENV\["NODE_USE_SYSTEM_CA"\] = "1"/u);
  assert.match(formula, /cp "homebrew-package-lock\.json", "package-lock\.json"/u);
  assert.match(formula, /system "npm", "ci", \*std_npm_args\(prefix: false\), "--omit=dev"/u);
  assert.match(formula, /libexec\.install "bin", "dist", "node_modules"/u);
  assert.match(formula, /libexec\.install "LICENSE", "NOTICE", "README\.md", "SECURITY\.md"/u);
  assert.match(formula, /#!#\{formula_opt_bin\("node"\)\}\/node --use-system-ca/u);
  assert.match(formula, /assert_equal "#\{version\}\\n", shell_output/u);
  assert.match(formula, /auth doctor --output json/u);
  assert.match(formula, /assert_equal 0, doctor\.fetch\("keychainRecordsRead"\)/u);
  assert.match(formula, /assert_equal expected_arch, doctor\.fetch\("architecture"\)/u);
  assert.match(formula, /operation describe getRecipe --output json/u);
  assert.equal(readFileSync(checksums, "utf8"), `${sha256}  ${basename(artifact)}\n`);
  const rubySyntax = spawnSync("ruby", ["-c", output], { encoding: "utf8" });
  assert.equal(rubySyntax.status, 0, rubySyntax.stderr);
  assert.match(rubySyntax.stdout, /Syntax OK/u);
});

test("is idempotent but refuses to replace a different Formula", (t) => {
  const workspace = makeWorkspace(t);
  const { artifact, metadataPath } = npmPack(workspace, projectRoot);
  const output = join(workspace, "Formula/cookidoo-axi.rb");
  const arguments_ = [
    "--repository=example/cookidoo-axi",
    `--artifact=${artifact}`,
    `--metadata=${metadataPath}`,
    `--output=${output}`,
  ];

  const first = runGenerator(arguments_);
  assert.equal(first.status, 0, first.stderr);
  const second = runGenerator(arguments_);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(JSON.parse(second.stdout).status, "unchanged");

  writeFileSync(output, "user-owned formula\n");
  const refused = runGenerator(arguments_);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /Refusing to overwrite a different Formula/u);
  assert.equal(readFileSync(output, "utf8"), "user-owned formula\n");
});

test("rejects invalid GitHub repository coordinates before writing", (t) => {
  const workspace = makeWorkspace(t);
  const output = join(workspace, "cookidoo-axi.rb");
  const result = runGenerator([
    "--repository", "https://github.com/example/project",
    "--artifact", join(workspace, "missing.tgz"),
    "--output", output,
  ]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /must be a GitHub OWNER\/REPO pair/u);
});

test("rejects artifacts that include environment credential files", (t) => {
  const workspace = makeWorkspace(t);
  const packageRoot = writeFixturePackage(workspace, {}, { ".env.production": "TOKEN=secret\n" });
  const { artifact, metadataPath } = npmPack(workspace, packageRoot);
  const result = runGenerator([
    "--repository", "example/cookidoo-axi",
    "--artifact", artifact,
    "--metadata", metadataPath,
    "--output", join(workspace, "cookidoo-axi.rb"),
  ]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /credential-bearing file/u);
});

test("rejects npm metadata that does not cryptographically match the artifact", (t) => {
  const workspace = makeWorkspace(t);
  const { artifact, metadataPath } = npmPack(workspace, writeFixturePackage(workspace));
  const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
  metadata[0].integrity = `sha512-${Buffer.alloc(64).toString("base64")}`;
  writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);

  const result = runGenerator([
    "--repository", "example/cookidoo-axi",
    "--artifact", artifact,
    "--metadata", metadataPath,
    "--output", join(workspace, "cookidoo-axi.rb"),
  ]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /metadata integrity does not match artifact bytes/u);
});

test("runs the release-package source-map gate against archive contents", (t) => {
  const workspace = makeWorkspace(t);
  const packageRoot = writeFixturePackage(workspace, {}, {
    "dist/leak.js.map": `${JSON.stringify({
      version: 3,
      sources: ["../../src/leak.ts"],
      sourcesContent: ["export const secret = true;"],
      names: [],
      mappings: "",
    })}\n`,
  });
  const { artifact, metadataPath } = npmPack(workspace, packageRoot);
  const result = runGenerator([
    "--repository", "example/cookidoo-axi",
    "--artifact", artifact,
    "--metadata", metadataPath,
    "--output", join(workspace, "cookidoo-axi.rb"),
  ]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /embeds source text through sourcesContent/u);
});

test("rejects artifacts without prebuilt CLI output", (t) => {
  const workspace = makeWorkspace(t);
  const packageRoot = writeFixturePackage(workspace, { files: ["bin", "LICENSE"] });
  const { artifact, metadataPath } = npmPack(workspace, packageRoot);
  const result = runGenerator([
    "--repository", "example/cookidoo-axi",
    "--artifact", artifact,
    "--metadata", metadataPath,
    "--output", join(workspace, "cookidoo-axi.rb"),
  ]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /expected exactly one package\/dist\/cli\.js entry/u);
});
