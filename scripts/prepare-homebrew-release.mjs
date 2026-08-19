#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  constants as fsConstants,
  accessSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { validateReleasePackage } from "./check-release-package.mjs";
import { expectedDistPaths } from "./dist-layout.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDirectory, "..");
const projectPackage = readJsonFile(join(projectRoot, "package.json"), "project package.json");

const HELP = `Usage:
  node scripts/prepare-homebrew-release.mjs --repository OWNER/REPO [options]

Required:
  --repository OWNER/REPO  GitHub repository that will host the release asset

Options:
  --artifact PATH         Prebuilt npm pack artifact
                          (default: ./release/v<version>/cookidoo-axi-<version>.tgz)
  --metadata PATH         Saved npm pack --json output for an existing artifact
  --output PATH           Formula destination
                          (default: ./release/v<version>/homebrew-tap/Formula/cookidoo-axi.rb)
  -h, --help              Show this help

When the default artifact does not exist, the command creates a complete local
release bundle with npm pack metadata, SHA256SUMS, and the tap Formula. Existing
files are accepted only when byte-identical to a fresh pack of the current
workspace. A custom existing artifact requires matching --metadata and is never
overwritten. The command performs no network access. Upload the exact validated
.tgz file to the GitHub release tag v<version>,
then copy the generated Formula into a Homebrew tap.
`;

function fail(message) {
  throw new Error(message);
}

function readJsonFile(path, label) {
  let source;
  try {
    source = readFileSync(path, "utf8");
  } catch (error) {
    fail(`Could not read ${label}: ${error.message}`);
  }

  try {
    return JSON.parse(source);
  } catch {
    fail(`Could not parse ${label} as JSON`);
  }
}

function parseArguments(argv) {
  const options = {};

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "-h" || argument === "--help") {
      options.help = true;
      continue;
    }

    const equals = argument.match(/^--(repository|artifact|metadata|output)=(.*)$/u);
    if (equals) {
      if (!equals[2]) fail(`--${equals[1]} requires a value`);
      if (options[equals[1]] !== undefined) fail(`--${equals[1]} may only be specified once`);
      options[equals[1]] = equals[2];
      continue;
    }

    const name = argument.match(/^--(repository|artifact|metadata|output)$/u)?.[1];
    if (name) {
      if (options[name] !== undefined) fail(`--${name} may only be specified once`);
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) fail(`--${name} requires a value`);
      options[name] = value;
      index += 1;
      continue;
    }

    fail(`Unknown argument: ${argument}`);
  }

  return options;
}

function validateRepository(repository) {
  if (!repository) fail("--repository OWNER/REPO is required");
  const component = "[A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9])?";
  if (!new RegExp(`^${component}/${component}$`, "u").test(repository)) {
    fail("--repository must be a GitHub OWNER/REPO pair using letters, digits, dots, underscores, or hyphens");
  }
  return repository;
}

function runTar(arguments_, label, maxBuffer = 2 * 1024 * 1024) {
  const result = spawnSync("tar", arguments_, {
    encoding: "utf8",
    maxBuffer,
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.error) fail(`Could not inspect ${label} with tar: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = result.stderr.trim();
    fail(`Invalid ${label}: tar exited with status ${result.status}${detail ? ` (${detail})` : ""}`);
  }
  return result.stdout;
}

function archiveEntries(artifactPath) {
  return runTar(["-tzf", artifactPath], "npm artifact", 8 * 1024 * 1024)
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((entry) => entry.replace(/\/$/u, ""));
}

function extractArchiveFile(artifactPath, archivePath, label) {
  return runTar(["-xOzf", artifactPath, archivePath], label);
}

function validateArchivePaths(entries) {
  if (entries.length === 0) fail("Invalid npm artifact: the archive is empty");

  for (const entry of entries) {
    if (entry.includes("\\")) fail(`Invalid npm artifact path: ${entry}`);
    if (entry.startsWith("/") || entry.split("/").includes("..")) {
      fail(`Unsafe npm artifact path: ${entry}`);
    }
    if (entry !== "package" && !entry.startsWith("package/")) {
      fail(`Invalid npm artifact path outside package/: ${entry}`);
    }

    const relative = entry.replace(/^package\/?/u, "");
    const segments = relative.split("/");
    if (segments.includes("node_modules")) {
      fail(`Invalid npm artifact: bundled node_modules entry ${entry}`);
    }
    if (segments.some((segment) => segment === ".npmrc" || segment === ".env" || segment.startsWith(".env."))) {
      fail(`Refusing npm artifact containing a credential-bearing file: ${entry}`);
    }
  }
}

function requireSingleEntry(entries, name) {
  const count = entries.filter((entry) => entry === name).length;
  if (count !== 1) fail(`Invalid npm artifact: expected exactly one ${name} entry`);
}

function metadataEntry(metadata) {
  if (!Array.isArray(metadata) || metadata.length !== 1) {
    fail("npm pack metadata must be a one-element JSON array");
  }
  const [entry] = metadata;
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    fail("npm pack metadata entry must be an object");
  }
  return entry;
}

function validateArtifactMatchesMetadata(artifactPath, artifactBuffer, entries, metadata, expectedCompiledPaths) {
  const entry = metadataEntry(metadata);
  if (entry.filename !== basename(artifactPath)) {
    fail(`npm pack metadata filename does not match artifact: ${JSON.stringify(entry.filename)}`);
  }
  if (entry.size !== artifactBuffer.length) {
    fail(`npm pack metadata size does not match artifact: ${JSON.stringify(entry.size)}`);
  }

  const sha1 = createHash("sha1").update(artifactBuffer).digest("hex");
  if (entry.shasum !== sha1) fail("npm pack metadata shasum does not match artifact bytes");
  const integrity = `sha512-${createHash("sha512").update(artifactBuffer).digest("base64")}`;
  if (entry.integrity !== integrity) fail("npm pack metadata integrity does not match artifact bytes");

  if (!Array.isArray(entry.files)) fail("npm pack metadata must contain a files array");
  const metadataPaths = entry.files.map((file) => file?.path);
  const archivePaths = entries
    .filter((archivePath) => archivePath !== "package")
    .map((archivePath) => archivePath.replace(/^package\//u, ""));
  const metadataCounts = new Map();
  for (const archivePath of metadataPaths) {
    metadataCounts.set(archivePath, (metadataCounts.get(archivePath) ?? 0) + 1);
  }
  const archiveCounts = new Map();
  for (const archivePath of archivePaths) {
    archiveCounts.set(archivePath, (archiveCounts.get(archivePath) ?? 0) + 1);
  }
  if (
    metadataCounts.size !== archiveCounts.size ||
    [...metadataCounts].some(([archivePath, count]) => archiveCounts.get(archivePath) !== count)
  ) {
    fail("npm pack metadata file list does not match artifact entries");
  }

  const fileContents = new Map();
  for (const archivePath of metadataPaths) {
    if (
      archivePath === "package.json" ||
      archivePath === "homebrew-package-lock.json" ||
      archivePath.endsWith(".map")
    ) {
      fileContents.set(
        archivePath,
        extractArchiveFile(artifactPath, `package/${archivePath}`, `artifact ${archivePath}`),
      );
    }
  }
  validateReleasePackage(metadata, {
    expectedName: projectPackage.name,
    expectedVersion: projectPackage.version,
    expectedDistPaths: expectedCompiledPaths,
    fileContents,
    projectLockfile: readJsonFile(join(projectRoot, "package-lock.json"), "project package-lock.json"),
  });
}

function pathExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function createNpmArtifact(artifactPath) {
  if (pathExists(artifactPath)) {
    fail(`Refusing to overwrite an existing artifact: ${artifactPath}`);
  }
  mkdirSync(dirname(artifactPath), { recursive: true });
  const npmCache = mkdtempSync(join(tmpdir(), "cookidoo-axi-npm-cache-"));
  let result;
  try {
    result = spawnSync(
      "npm",
      ["pack", "--ignore-scripts", "--json", "--pack-destination", dirname(artifactPath), "."],
      {
        cwd: projectRoot,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          npm_config_cache: npmCache,
          npm_config_update_notifier: "false",
        },
      },
    );
  } finally {
    rmSync(npmCache, { recursive: true, force: true });
  }

  if (result.error) fail(`Could not create npm artifact: ${result.error.message}`);
  if (result.status !== 0) {
    rmSync(artifactPath, { force: true });
    const detail = result.stderr.trim();
    fail(`npm pack exited with status ${result.status}${detail ? ` (${detail})` : ""}`);
  }

  let metadata;
  try {
    metadata = JSON.parse(result.stdout);
  } catch (error) {
    rmSync(artifactPath, { force: true });
    fail(`Could not parse npm pack JSON output: ${error.message}`);
  }
  const generatedFilename = metadataEntry(metadata).filename;
  const generatedPath = resolve(dirname(artifactPath), generatedFilename);
  if (generatedPath !== artifactPath) {
    if (generatedPath.startsWith(`${resolve(dirname(artifactPath))}/`)) rmSync(generatedPath, { force: true });
    fail(`npm pack generated ${JSON.stringify(generatedFilename)} instead of ${JSON.stringify(basename(artifactPath))}`);
  }
  return metadata;
}

function validatePackageMetadata(metadata, artifactFilename) {
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
    fail("Artifact package.json must contain a JSON object");
  }
  if (metadata.name !== projectPackage.name) {
    fail(`Artifact package name ${JSON.stringify(metadata.name)} does not match ${JSON.stringify(projectPackage.name)}`);
  }
  if (metadata.version !== projectPackage.version) {
    fail(`Artifact version ${JSON.stringify(metadata.version)} does not match project version ${JSON.stringify(projectPackage.version)}`);
  }
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(metadata.version)) {
    fail(`Artifact version is not a supported semantic version: ${JSON.stringify(metadata.version)}`);
  }
  if (metadata.license !== "MIT") fail("Artifact package.json must declare the MIT license");
  if (!Array.isArray(metadata.os) || !metadata.os.includes("darwin")) {
    fail("Artifact package.json must declare macOS support with os: [\"darwin\"]");
  }
  if (metadata.bin?.["cookidoo-axi"] !== "bin/cookidoo-axi.mjs") {
    fail("Artifact package.json must expose bin/cookidoo-axi.mjs as cookidoo-axi");
  }

  const expectedFilename = `${projectPackage.name}-${metadata.version}.tgz`;
  if (artifactFilename !== expectedFilename) {
    fail(`Artifact filename must be the npm pack filename ${expectedFilename}`);
  }
}

function validateArtifact(artifactPath, npmMetadata, expectedCompiledPaths) {
  if (!artifactPath.endsWith(".tgz")) fail("--artifact must point to a .tgz file");
  try {
    accessSync(artifactPath, fsConstants.R_OK);
  } catch {
    fail(`Artifact is not readable: ${artifactPath}`);
  }

  const entries = archiveEntries(artifactPath);
  validateArchivePaths(entries);
  for (const required of [
    "package/package.json",
    "package/bin/cookidoo-axi.mjs",
    "package/dist/cli.js",
    "package/LICENSE",
  ]) {
    requireSingleEntry(entries, required);
  }

  let metadata;
  try {
    metadata = JSON.parse(extractArchiveFile(artifactPath, "package/package.json", "artifact package.json"));
  } catch {
    fail("Invalid artifact package.json: expected a JSON object");
  }
  validatePackageMetadata(metadata, basename(artifactPath));

  const launcher = extractArchiveFile(
    artifactPath,
    "package/bin/cookidoo-axi.mjs",
    "artifact launcher",
  );
  if (!launcher.startsWith("#!/usr/bin/env node\n")) {
    fail("Artifact launcher must begin with #!/usr/bin/env node so the Formula can pin Homebrew Node");
  }

  const artifactBuffer = readFileSync(artifactPath);
  validateArtifactMatchesMetadata(
    artifactPath,
    artifactBuffer,
    entries,
    npmMetadata,
    expectedCompiledPaths,
  );
  const sha256 = createHash("sha256").update(artifactBuffer).digest("hex");
  return { metadata, sha256 };
}

function renderFormula({ repository, version, artifactFilename, sha256 }) {
  return `class CookidooAxi < Formula
  desc "Agent-friendly CLI for the unofficial Cookidoo API"
  homepage "https://github.com/${repository}"
  url "https://github.com/${repository}/releases/download/v${version}/${artifactFilename}"
  sha256 "${sha256}"
  license "MIT"

  depends_on arch: :arm64
  depends_on :macos
  depends_on "node"

  def install
    ENV["NODE_USE_SYSTEM_CA"] = "1"
    cp "homebrew-package-lock.json", "package-lock.json"
    system "npm", "ci", *std_npm_args(prefix: false), "--omit=dev"

    launcher = buildpath/"bin/cookidoo-axi.mjs"
    inreplace launcher, "#!/usr/bin/env node", "#!#{formula_opt_bin("node")}/node --use-system-ca"
    libexec.install "bin", "dist", "node_modules", "package.json"
    libexec.install "LICENSE", "NOTICE", "README.md", "SECURITY.md", "THIRD_PARTY_NOTICES.md"
    bin.install_symlink libexec/"bin/cookidoo-axi.mjs" => "cookidoo-axi"
  end

  test do
    assert_equal "#{version}\\n", shell_output("#{bin}/cookidoo-axi --version")

    doctor = JSON.parse(shell_output("#{bin}/cookidoo-axi auth doctor --output json")).fetch("data")
    expected_arch = Hardware::CPU.arm? ? "arm64" : "x64"
    assert_equal "loaded", doctor.fetch("keychainBinding")
    assert_equal "darwin", doctor.fetch("platform")
    assert_equal expected_arch, doctor.fetch("architecture")
    assert_equal "not-requested", doctor.fetch("keychainAccess")
    assert_equal 0, doctor.fetch("keychainRecordsRead")
    assert_equal 0, doctor.fetch("keychainRecordsWritten")
    assert_equal 0, doctor.fetch("networkRequests")

    operation = JSON.parse(shell_output("#{bin}/cookidoo-axi operation describe getRecipe --output json"))
    assert_equal "getRecipe", operation.fetch("data").fetch("operationId")
  end
end
`;
}

function writeCreateOrIdentical(outputPath, contents, label) {
  mkdirSync(dirname(outputPath), { recursive: true });

  try {
    writeFileSync(outputPath, contents, { encoding: "utf8", flag: "wx", mode: 0o644 });
    return "created";
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }

  const existing = readFileSync(outputPath, "utf8");
  if (existing !== contents) {
    fail(`Refusing to overwrite a different ${label}: ${outputPath}`);
  }
  return "unchanged";
}

function writeFormula(outputPath, formula) {
  return writeCreateOrIdentical(outputPath, formula, "Formula");
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function assertFreshRelease(existingPath, existingMetadata, candidatePath, candidateMetadata) {
  const existingBuffer = readFileSync(existingPath);
  const candidateBuffer = readFileSync(candidatePath);
  if (!existingBuffer.equals(candidateBuffer)) {
    fail(
      `Existing release artifact does not match the current package ` +
        `(existing sha256 ${sha256(existingBuffer)}, current sha256 ${sha256(candidateBuffer)}). ` +
        `Bump the package version or restore the workspace; no release files were overwritten.`,
    );
  }
  if (JSON.stringify(existingMetadata) !== JSON.stringify(candidateMetadata)) {
    fail(
      "Existing npm-pack.json does not match a fresh pack of the current package. " +
        "Bump the package version or restore the workspace; no release files were overwritten.",
    );
  }
}

function main(argv) {
  const options = parseArguments(argv);
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }

  const repository = validateRepository(options.repository);
  const defaultReleaseDirectory = join(projectRoot, `release/v${projectPackage.version}`);
  const defaultArtifact = join(
    defaultReleaseDirectory,
    `${projectPackage.name}-${projectPackage.version}.tgz`,
  );
  const defaultOutput = join(
    defaultReleaseDirectory,
    "homebrew-tap/Formula/cookidoo-axi.rb",
  );
  const artifactPath = resolve(projectRoot, options.artifact ?? defaultArtifact);
  const outputPath = resolve(projectRoot, options.output ?? defaultOutput);
  const siblingMetadataPath = join(dirname(artifactPath), "npm-pack.json");
  const checksumsPath = join(dirname(artifactPath), "SHA256SUMS");
  if (artifactPath === outputPath) fail("--output must not refer to the npm artifact");

  const compiledPaths = expectedDistPaths(projectRoot);
  const stagingRoot = mkdtempSync(join(tmpdir(), "cookidoo-axi-release-pack-"));
  const candidatePath = join(stagingRoot, basename(artifactPath));

  let npmMetadata;
  let artifactStatus;
  let metadataPath;
  let metadataStatus;
  let metadata;
  let sha256;
  let status;
  let checksumsStatus;
  try {
    const candidateMetadata = createNpmArtifact(candidatePath);
    const candidateValidation = validateArtifact(candidatePath, candidateMetadata, compiledPaths);

    if (pathExists(artifactPath)) {
      const canUseDefaultSibling = pathExists(siblingMetadataPath);
      if (!options.metadata && !canUseDefaultSibling) {
        fail("An existing --artifact requires matching npm pack --json data via --metadata");
      }
      metadataPath = options.metadata
        ? resolve(projectRoot, options.metadata)
        : siblingMetadataPath;
      npmMetadata = readJsonFile(metadataPath, "npm pack metadata");
      validateArtifact(artifactPath, npmMetadata, compiledPaths);
      assertFreshRelease(artifactPath, npmMetadata, candidatePath, candidateMetadata);
      artifactStatus = options.metadata ? "provided" : "unchanged";
      metadataStatus = options.metadata ? "provided" : "unchanged";
    } else {
      if (options.metadata) fail("--metadata cannot be used when the artifact does not exist");
      mkdirSync(dirname(artifactPath), { recursive: true });
      try {
        writeFileSync(artifactPath, readFileSync(candidatePath), { flag: "wx", mode: 0o644 });
      } catch (error) {
        if (error.code === "EEXIST") fail(`Refusing to overwrite an existing artifact: ${artifactPath}`);
        throw error;
      }
      npmMetadata = candidateMetadata;
      artifactStatus = "created";
      metadataPath = siblingMetadataPath;
      try {
        metadataStatus = writeCreateOrIdentical(
          metadataPath,
          `${JSON.stringify(npmMetadata, null, 2)}\n`,
          "npm-pack.json",
        );
      } catch (error) {
        rmSync(artifactPath, { force: true });
        throw error;
      }
    }

    ({ metadata, sha256 } = candidateValidation);
    checksumsStatus = writeCreateOrIdentical(
      checksumsPath,
      `${sha256}  ${basename(artifactPath)}\n`,
      "SHA256SUMS",
    );
    const formula = renderFormula({
      repository,
      version: metadata.version,
      artifactFilename: basename(artifactPath),
      sha256,
    });
    status = writeFormula(outputPath, formula);
  } catch (error) {
    if (checksumsStatus === "created") rmSync(checksumsPath, { force: true });
    if (artifactStatus === "created") {
      rmSync(artifactPath, { force: true });
      if (metadataStatus === "created") rmSync(metadataPath, { force: true });
    }
    throw error;
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true });
  }

  process.stdout.write(`${JSON.stringify({
    artifact: artifactPath,
    artifactStatus,
    checksums: checksumsPath,
    checksumsStatus,
    formula: outputPath,
    metadata: metadataPath,
    metadataStatus,
    repository,
    sha256,
    status,
    version: metadata.version,
  })}\n`);
}

try {
  main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`prepare-homebrew-release: ${error.message}\n`);
  process.exitCode = 1;
}
