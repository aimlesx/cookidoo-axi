#!/usr/bin/env node

import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const EXPECTED_PACKAGE_NAME = "cookidoo-axi";

export const REQUIRED_RELEASE_PATHS = Object.freeze([
  "LICENSE",
  "NOTICE",
  "README.md",
  "SECURITY.md",
  "THIRD_PARTY_NOTICES.md",
  "bin/cookidoo-axi.mjs",
  "dist/generated/openapi-manifest.json",
  "homebrew-package-lock.json",
  "package.json",
  "skills/cookidoo-axi/SKILL.md",
]);

const ROOT_FILES = new Set([
  "LICENSE",
  "NOTICE",
  "README.md",
  "SECURITY.md",
  "THIRD_PARTY_NOTICES.md",
  "homebrew-package-lock.json",
  "package.json",
]);
const FORBIDDEN_DIRECTORY_SEGMENTS = new Set([
  "node_modules",
  "script",
  "scripts",
  "src",
  "test",
  "tests",
]);
const SOURCE_MAP_CONTENT_KEYS = new Set(["sourceContent", "sourcesContent"]);

export class ReleasePackageValidationError extends Error {
  constructor(issues) {
    super(`Release package validation failed:\n${issues.map((issue) => `- ${issue}`).join("\n")}`);
    this.name = "ReleasePackageValidationError";
    this.issues = Object.freeze([...issues]);
  }
}

/**
 * Validate one parsed `npm pack --json` result without performing I/O.
 *
 * Source-map text must be supplied through `fileContents` for every `.map`
 * entry. `fileContents` may be a Map or a plain object keyed by archive path.
 */
export function validateReleasePackage(metadata, options = {}) {
  const issues = [];
  const entry = unpackSingleMetadataEntry(metadata, issues);
  const expectedName = options.expectedName ?? EXPECTED_PACKAGE_NAME;
  const expectedVersion = options.expectedVersion;
  const fileContents = options.fileContents ?? new Map();

  if (typeof expectedName !== "string" || expectedName.length === 0) {
    issues.push("expectedName must be a non-empty string");
  }
  if (typeof expectedVersion !== "string" || expectedVersion.length === 0) {
    issues.push("expectedVersion must be a non-empty string");
  }

  if (entry === undefined) {
    throw new ReleasePackageValidationError(issues);
  }

  if (entry.name !== expectedName) {
    issues.push(`package name must be ${JSON.stringify(expectedName)}, got ${JSON.stringify(entry.name)}`);
  }
  if (entry.version !== expectedVersion) {
    issues.push(
      `package version must be ${JSON.stringify(expectedVersion)}, got ${JSON.stringify(entry.version)}`,
    );
  }
  if (
    typeof expectedName === "string" &&
    typeof expectedVersion === "string" &&
    entry.filename !== `${expectedName}-${expectedVersion}.tgz`
  ) {
    issues.push(
      `package filename must be ${JSON.stringify(`${expectedName}-${expectedVersion}.tgz`)}, got ${JSON.stringify(entry.filename)}`,
    );
  }

  if (!Array.isArray(entry.files)) {
    issues.push("npm pack metadata must contain a files array");
    throw new ReleasePackageValidationError(issues);
  }

  if (entry.entryCount !== undefined && entry.entryCount !== entry.files.length) {
    issues.push(`entryCount ${JSON.stringify(entry.entryCount)} does not match files length ${entry.files.length}`);
  }

  const paths = new Map();
  for (const [index, file] of entry.files.entries()) {
    if (file === null || typeof file !== "object" || Array.isArray(file)) {
      issues.push(`files[${index}] must be an object`);
      continue;
    }

    const archivePath = file.path;
    if (!isSafeArchivePath(archivePath)) {
      issues.push(`files[${index}].path is not a safe npm archive path: ${JSON.stringify(archivePath)}`);
      continue;
    }
    if (paths.has(archivePath)) {
      issues.push(`duplicate archive path: ${archivePath}`);
      continue;
    }
    paths.set(archivePath, file);

    if (!Number.isInteger(file.size) || file.size < 0) {
      issues.push(`${archivePath} has an invalid size: ${JSON.stringify(file.size)}`);
    }

    const forbiddenReason = forbiddenPathReason(archivePath);
    if (forbiddenReason !== undefined) {
      issues.push(`${archivePath} is forbidden: ${forbiddenReason}`);
      continue;
    }

    if (!isAllowedReleasePath(archivePath)) {
      issues.push(`${archivePath} is outside the release allowlist`);
    }
  }

  for (const requiredPath of REQUIRED_RELEASE_PATHS) {
    const file = paths.get(requiredPath);
    if (file === undefined) {
      issues.push(`required release file is missing: ${requiredPath}`);
    } else if (file.size === 0) {
      issues.push(`required release file is empty: ${requiredPath}`);
    }
  }

  const executable = paths.get("bin/cookidoo-axi.mjs");
  if (executable !== undefined && executable.mode !== 0o755) {
    issues.push(
      `bin/cookidoo-axi.mjs must have npm pack mode 0755, got ${formatMode(executable.mode)}`,
    );
  }

  const packageManifest = inspectManifest(
    "package.json",
    paths,
    fileContents,
    expectedName,
    expectedVersion,
    issues,
  );
  inspectDistLayout(paths, options.expectedDistPaths, issues);
  const releaseLockfile = inspectReleaseLock(
    paths,
    fileContents,
    options.projectLockfile,
    issues,
  );
  if (releaseLockfile !== undefined && packageManifest !== undefined) {
    inspectRuntimeClosure(releaseLockfile, packageManifest, expectedName, expectedVersion, issues);
  }

  let sourceMapCount = 0;
  for (const archivePath of paths.keys()) {
    if (!archivePath.endsWith(".map")) continue;
    sourceMapCount += 1;
    inspectSourceMap(archivePath, fileContents, issues);
  }

  if (issues.length > 0) {
    throw new ReleasePackageValidationError(issues);
  }

  return Object.freeze({
    ok: true,
    name: entry.name,
    version: entry.version,
    filename: entry.filename,
    fileCount: paths.size,
    sourceMapCount,
  });
}

function inspectReleaseLock(paths, fileContents, projectLockfile, issues) {
  const archivePath = "homebrew-package-lock.json";
  if (!paths.has(archivePath)) return undefined;
  const content = getFileContent(fileContents, archivePath);
  if (content === undefined) {
    issues.push(`${archivePath} content was not supplied for dependency-lock inspection`);
    return undefined;
  }

  let releaseLockfile;
  try {
    releaseLockfile = JSON.parse(String(content));
  } catch (error) {
    issues.push(`${archivePath} is not valid JSON: ${error.message}`);
    return undefined;
  }
  if (releaseLockfile === null || typeof releaseLockfile !== "object" || Array.isArray(releaseLockfile)) {
    issues.push(`${archivePath} must contain a JSON object`);
    return undefined;
  }
  if (
    projectLockfile !== undefined &&
    JSON.stringify(releaseLockfile) !== JSON.stringify(projectLockfile)
  ) {
    issues.push(`${archivePath} must be structurally identical to the project package-lock.json`);
  }
  inspectLockProvenance(releaseLockfile, issues);
  return releaseLockfile;
}

function inspectLockProvenance(lockfile, issues) {
  const packages = plainRecord(lockfile.packages);
  if (packages !== undefined) {
    for (const [packagePath, packageEntry] of Object.entries(packages)) {
      if (packagePath === "") continue;
      if (packageEntry === null || typeof packageEntry !== "object" || Array.isArray(packageEntry)) {
        issues.push(`release lock package entry is invalid: ${packagePath}`);
        continue;
      }
      const expectedUrl = canonicalRegistryUrl(packagePath, packageEntry.version);
      if (expectedUrl === undefined || packageEntry.resolved !== expectedUrl) {
        issues.push(
          `release lock package ${packagePath} must use its canonical credential-free npm registry HTTPS URL`,
        );
      }
      if (!isSha512Integrity(packageEntry.integrity)) {
        issues.push(`release lock package ${packagePath} must have a valid sha512 integrity`);
      }
    }
  }
  inspectCredentialBearingLockValues(lockfile, "$", undefined, issues);
}

const PACKAGE_NAME_MAP_KEYS = new Set([
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "packages",
  "peerDependencies",
]);

function inspectCredentialBearingLockValues(value, path, parentKey, issues) {
  if (typeof value === "string") {
    if (/^https?:\/\//iu.test(value)) {
      try {
        const parsed = new URL(value);
        const sensitiveQuery = [...parsed.searchParams.keys()].some((key) =>
          /^(?:access[_-]?token|api[_-]?key|auth|password|secret|token)$/iu.test(key),
        );
        if (parsed.username || parsed.password || sensitiveQuery || parsed.hash) {
          issues.push(`release lock contains a credential-bearing URL at ${path}`);
        }
      } catch {
        issues.push(`release lock contains an invalid HTTP URL at ${path}`);
      }
    }
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => inspectCredentialBearingLockValues(item, `${path}[${index}]`, undefined, issues));
    return;
  }
  const keysArePackageNames = PACKAGE_NAME_MAP_KEYS.has(parentKey);
  for (const [key, child] of Object.entries(value)) {
    if (
      !keysArePackageNames &&
      /^(?:_auth|authorization|credential|password|secret|session|token)(?:s|[_-].*)?$/iu.test(key)
    ) {
      issues.push(`release lock contains a credential-like field at ${path}.${key}`);
    }
    inspectCredentialBearingLockValues(child, `${path}.${key}`, key, issues);
  }
}

function inspectDistLayout(paths, expectedDistPaths, issues) {
  if (expectedDistPaths === undefined) return;
  if (!Array.isArray(expectedDistPaths)) {
    issues.push("expectedDistPaths must be an array");
    return;
  }

  const expected = new Set();
  for (const archivePath of expectedDistPaths) {
    if (typeof archivePath !== "string" || !archivePath.startsWith("dist/") || !isSafeArchivePath(archivePath)) {
      issues.push(`expectedDistPaths contains an invalid dist path: ${JSON.stringify(archivePath)}`);
      continue;
    }
    if (expected.has(archivePath)) {
      issues.push(`expectedDistPaths contains a duplicate: ${archivePath}`);
    }
    expected.add(archivePath);
  }

  const actual = [...paths.keys()].filter((archivePath) => archivePath.startsWith("dist/"));
  for (const archivePath of expected) {
    if (!paths.has(archivePath)) issues.push(`compiled output is missing: ${archivePath}`);
  }
  for (const archivePath of actual) {
    if (!expected.has(archivePath)) issues.push(`compiled output is unexpected: ${archivePath}`);
  }
}

function unpackSingleMetadataEntry(metadata, issues) {
  if (Array.isArray(metadata)) {
    if (metadata.length !== 1) {
      issues.push(`npm pack metadata must describe exactly one package, got ${metadata.length}`);
      return undefined;
    }
    const [entry] = metadata;
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      issues.push("npm pack metadata entry must be an object");
      return undefined;
    }
    return entry;
  }

  if (metadata === null || typeof metadata !== "object") {
    issues.push("npm pack metadata must be an object or a one-element array");
    return undefined;
  }
  return metadata;
}

function isSafeArchivePath(value) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\\") || value.includes("\0")) {
    return false;
  }
  if (value.startsWith("/") || /^[A-Za-z]:\//u.test(value)) return false;
  const segments = value.split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function forbiddenPathReason(archivePath) {
  const segments = archivePath.toLowerCase().split("/");
  const basename = segments.at(-1);

  const forbiddenDirectory = segments.slice(0, -1).find((segment) =>
    FORBIDDEN_DIRECTORY_SEGMENTS.has(segment),
  );
  if (forbiddenDirectory !== undefined) return `${forbiddenDirectory}/ is not runtime payload`;
  if (segments.includes("node_modules")) return "bundled node_modules are not allowed";
  if (basename === ".env" || basename.startsWith(".env.")) return "environment files may contain secrets";
  if ([".npmrc", ".netrc", "id_rsa", "id_ed25519"].includes(basename)) {
    return "credential configuration or private keys are not allowed";
  }
  if (["package-lock.json", "npm-shrinkwrap.json"].includes(basename)) {
    return "development lockfiles are intentionally excluded from the runtime archive";
  }
  if (/\.(?:key|p12|pfx|pem)$/u.test(basename)) return "private-key material is not allowed";
  if (/^(?:cookies?|credentials?|passwords?|secrets?|sessions?|tokens?)(?:[._-].*)?\.(?:bak|db|json|sqlite3?|toml|txt|ya?ml)$/u.test(basename)) {
    return "credential or session data is not allowed";
  }
  if (/(?:\.bak|\.orig|\.swp|~)$/u.test(basename)) return "editor or backup artifacts are not allowed";
  return undefined;
}

function isAllowedReleasePath(archivePath) {
  if (
    ROOT_FILES.has(archivePath)
    || archivePath === "bin/cookidoo-axi.mjs"
    || archivePath === "skills/cookidoo-axi/SKILL.md"
  ) return true;
  if (!archivePath.startsWith("dist/")) return false;
  return [".cjs", ".cjs.map", ".d.ts", ".d.ts.map", ".js", ".js.map", ".json", ".mjs", ".mjs.map"].some(
    (suffix) => archivePath.endsWith(suffix),
  );
}

function formatMode(mode) {
  return Number.isInteger(mode) && mode >= 0 ? `0${mode.toString(8)}` : JSON.stringify(mode);
}

function getFileContent(fileContents, archivePath) {
  if (fileContents instanceof Map) {
    return fileContents.has(archivePath) ? fileContents.get(archivePath) : undefined;
  }
  if (fileContents !== null && typeof fileContents === "object") {
    return Object.prototype.hasOwnProperty.call(fileContents, archivePath)
      ? fileContents[archivePath]
      : undefined;
  }
  return undefined;
}

function inspectManifest(archivePath, paths, fileContents, expectedName, expectedVersion, issues) {
  if (!paths.has(archivePath)) return undefined;
  const content = getFileContent(fileContents, archivePath);
  if (content === undefined) {
    issues.push(`${archivePath} content was not supplied for dependency-pin inspection`);
    return undefined;
  }

  let manifest;
  try {
    manifest = JSON.parse(String(content));
  } catch (error) {
    issues.push(`${archivePath} is not valid JSON: ${error.message}`);
    return undefined;
  }

  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
    issues.push(`${archivePath} must contain a JSON object`);
    return undefined;
  }
  if (manifest.name !== expectedName) {
    issues.push(`${archivePath} name must be ${JSON.stringify(expectedName)}, got ${JSON.stringify(manifest.name)}`);
  }
  if (manifest.version !== expectedVersion) {
    issues.push(
      `${archivePath} version must be ${JSON.stringify(expectedVersion)}, got ${JSON.stringify(manifest.version)}`,
    );
  }
  inspectExactVersionRecord(manifest.dependencies, "package.json dependencies", issues, {
    requireEntries: true,
  });
  inspectExactVersionRecord(manifest.overrides, "package.json overrides", issues, {
    recursive: true,
    requireEntries: true,
  });
  if (Array.isArray(manifest.bundleDependencies) && manifest.bundleDependencies.length > 0) {
    issues.push("package.json bundleDependencies must be empty or absent");
  }
  if (Array.isArray(manifest.bundledDependencies) && manifest.bundledDependencies.length > 0) {
    issues.push("package.json bundledDependencies must be empty or absent");
  }
  return manifest;
}

function inspectExactVersionRecord(value, label, issues, options = {}) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    issues.push(`${label} must be an object of exact semantic versions`);
    return;
  }
  const entries = Object.entries(value);
  if (options.requireEntries && entries.length === 0) {
    issues.push(`${label} must not be empty`);
    return;
  }

  for (const [packageName, specification] of entries) {
    const itemLabel = `${label}[${JSON.stringify(packageName)}]`;
    if (typeof specification === "string") {
      if (!isExactSemanticVersion(specification)) {
        issues.push(`${itemLabel} must be an exact semantic version, got ${JSON.stringify(specification)}`);
      }
      continue;
    }
    if (options.recursive && specification !== null && typeof specification === "object" && !Array.isArray(specification)) {
      inspectExactVersionRecord(specification, itemLabel, issues, { recursive: true, requireEntries: true });
      continue;
    }
    issues.push(`${itemLabel} must be an exact semantic version`);
  }
}

function isExactSemanticVersion(value) {
  return /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u.test(
    value,
  );
}

function inspectRuntimeClosure(lockfile, manifest, expectedName, expectedVersion, issues) {
  if (lockfile === null || typeof lockfile !== "object" || Array.isArray(lockfile)) {
    issues.push("project package-lock.json must contain a JSON object");
    return;
  }
  if (lockfile.lockfileVersion !== 3) {
    issues.push(`project package-lock.json lockfileVersion must be 3, got ${JSON.stringify(lockfile.lockfileVersion)}`);
  }
  if (lockfile.name !== expectedName || lockfile.version !== expectedVersion) {
    issues.push("project package-lock.json identity must match the release package");
  }

  const packages = lockfile.packages;
  if (packages === null || typeof packages !== "object" || Array.isArray(packages)) {
    issues.push("project package-lock.json must contain a packages object");
    return;
  }
  const root = packages[""];
  if (root === null || typeof root !== "object" || Array.isArray(root)) {
    issues.push("project package-lock.json must contain its root packages entry");
    return;
  }
  if (root.name !== expectedName || root.version !== expectedVersion) {
    issues.push("project package-lock.json root identity must match the release package");
  }

  const manifestDependencies = plainRecord(manifest.dependencies);
  const lockedRootDependencies = plainRecord(root.dependencies);
  if (manifestDependencies === undefined || lockedRootDependencies === undefined) {
    issues.push("package.json and package-lock.json must both describe root runtime dependencies");
    return;
  }
  if (!recordsEqual(manifestDependencies, lockedRootDependencies)) {
    issues.push("project package-lock.json root dependencies do not match package.json");
  }
  for (const field of [
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
    "peerDependenciesMeta",
  ]) {
    const manifestValue = plainRecord(manifest[field]) ?? {};
    const lockedValue = plainRecord(root[field]) ?? {};
    if (JSON.stringify(manifestValue) !== JSON.stringify(lockedValue)) {
      issues.push(`project package-lock.json root ${field} do not match package.json`);
    }
  }
  inspectDarwinKeyringTargets(packages, manifestDependencies, issues);

  const overrides = plainRecord(manifest.overrides) ?? {};
  const queue = [""];
  const visited = new Set();
  const reportedEdges = new Set();

  while (queue.length > 0) {
    const packagePath = queue.shift();
    if (visited.has(packagePath)) continue;
    visited.add(packagePath);
    const packageEntry = packages[packagePath];
    if (packageEntry === null || typeof packageEntry !== "object" || Array.isArray(packageEntry)) {
      issues.push(`runtime package-lock entry is missing or invalid: ${packagePath || "<root>"}`);
      continue;
    }

    for (const edge of runtimeEdges(packageEntry)) {
      const targetPath = resolveLockedDependencyPath(packages, packagePath, edge.name);
      if (targetPath === undefined) {
        if (!edge.optional) {
          issues.push(
            `runtime dependency ${displayPackagePath(packagePath, expectedName)} -> ${edge.name} is not resolved in package-lock.json`,
          );
        }
        continue;
      }
      const target = packages[targetPath];
      const targetVersion = target?.version;
      if (!isExactSemanticVersion(targetVersion)) {
        issues.push(`locked runtime package ${targetPath} has an invalid exact version: ${JSON.stringify(targetVersion)}`);
        continue;
      }
      if (target.resolved !== canonicalRegistryUrl(targetPath, targetVersion)) {
        issues.push(`locked runtime package ${targetPath} must use a credential-free npm registry HTTPS URL`);
      }
      if (!isSha512Integrity(target.integrity)) {
        issues.push(`locked runtime package ${targetPath} must have a valid sha512 integrity`);
      }

      if (isExactSemanticVersion(edge.specification)) {
        if (edge.specification !== targetVersion) {
          issues.push(
            `runtime edge ${displayPackagePath(packagePath, expectedName)} -> ${edge.name} requires exact version ${JSON.stringify(edge.specification)}, ` +
              `but package-lock.json resolves ${JSON.stringify(targetVersion)}`,
          );
        }
      } else {
        const override = globalOverrideVersion(overrides, edge.name);
        if (override !== targetVersion) {
          const reportKey = `${packagePath}\0${edge.name}\0${edge.specification}\0${targetVersion}`;
          if (!reportedEdges.has(reportKey)) {
            reportedEdges.add(reportKey);
            issues.push(
              `runtime edge ${displayPackagePath(packagePath, expectedName)} -> ${edge.name} uses ${JSON.stringify(edge.specification)}; ` +
                `package.json overrides[${JSON.stringify(edge.name)}] must equal locked version ${JSON.stringify(targetVersion)}, got ${JSON.stringify(override)}`,
            );
          }
        }
      }
      queue.push(targetPath);
    }
  }
}

function inspectDarwinKeyringTargets(packages, manifestDependencies, issues) {
  const keyringVersion = manifestDependencies?.["@napi-rs/keyring"];
  if (keyringVersion === undefined) return;
  const parent = packages["node_modules/@napi-rs/keyring"];
  const optionalDependencies = plainRecord(parent?.optionalDependencies);
  for (const architecture of ["arm64", "x64"]) {
    const packageName = `@napi-rs/keyring-darwin-${architecture}`;
    const packagePath = `node_modules/${packageName}`;
    const target = packages[packagePath];
    if (optionalDependencies?.[packageName] !== keyringVersion) {
      issues.push(`${packageName} must be an exact ${keyringVersion} optional dependency of @napi-rs/keyring`);
    }
    if (target === null || typeof target !== "object" || Array.isArray(target)) {
      issues.push(`required macOS native package is missing from the release lock: ${packagePath}`);
      continue;
    }
    if (target.version !== keyringVersion || target.optional !== true) {
      issues.push(`${packagePath} must be optional at exact version ${keyringVersion}`);
    }
    if (JSON.stringify(target.os) !== JSON.stringify(["darwin"])) {
      issues.push(`${packagePath} must declare os: ["darwin"]`);
    }
    if (JSON.stringify(target.cpu) !== JSON.stringify([architecture])) {
      issues.push(`${packagePath} must declare cpu: [${JSON.stringify(architecture)}]`);
    }
    if (target.resolved !== canonicalRegistryUrl(packagePath, target.version)) {
      issues.push(`${packagePath} must use a credential-free npm registry HTTPS URL`);
    }
    if (!isSha512Integrity(target.integrity)) {
      issues.push(`${packagePath} must have a valid sha512 integrity`);
    }
  }
}

function canonicalRegistryUrl(packagePath, version) {
  if (!isExactSemanticVersion(version)) return undefined;
  const marker = "node_modules/";
  const index = packagePath.lastIndexOf(marker);
  if (index === -1) return undefined;
  const packageName = packagePath.slice(index + marker.length);
  if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/iu.test(packageName)) return undefined;
  const basename = packageName.split("/").at(-1);
  return `https://registry.npmjs.org/${packageName}/-/${basename}-${version}.tgz`;
}

function isSha512Integrity(value) {
  if (typeof value !== "string" || !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(value)) return false;
  try {
    return Buffer.from(value.slice("sha512-".length), "base64").length === 64;
  } catch {
    return false;
  }
}

function plainRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

function recordsEqual(left, right) {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key])
  );
}

function runtimeEdges(packageEntry) {
  const edges = new Map();
  for (const [name, specification] of Object.entries(plainRecord(packageEntry.dependencies) ?? {})) {
    edges.set(name, { name, specification, optional: false });
  }
  for (const [name, specification] of Object.entries(plainRecord(packageEntry.optionalDependencies) ?? {})) {
    edges.set(name, { name, specification, optional: true });
  }
  const peerMeta = plainRecord(packageEntry.peerDependenciesMeta) ?? {};
  for (const [name, specification] of Object.entries(plainRecord(packageEntry.peerDependencies) ?? {})) {
    const optional = plainRecord(peerMeta[name])?.optional === true;
    if (!edges.has(name)) edges.set(name, { name, specification, optional });
  }
  return edges.values();
}

function resolveLockedDependencyPath(packages, parentPath, dependencyName) {
  let directory = parentPath;
  while (true) {
    const candidate = directory
      ? `${directory}/node_modules/${dependencyName}`
      : `node_modules/${dependencyName}`;
    if (Object.prototype.hasOwnProperty.call(packages, candidate)) return candidate;
    const nestedIndex = directory.lastIndexOf("/node_modules/");
    if (nestedIndex === -1) {
      if (directory === "") return undefined;
      directory = "";
    } else {
      directory = directory.slice(0, nestedIndex);
    }
  }
}

function globalOverrideVersion(overrides, dependencyName) {
  const override = overrides[dependencyName];
  if (typeof override === "string") return override;
  if (override !== null && typeof override === "object" && !Array.isArray(override)) {
    return typeof override["."] === "string" ? override["."] : undefined;
  }
  return undefined;
}

function displayPackagePath(packagePath, rootName) {
  if (packagePath === "") return rootName;
  const marker = "node_modules/";
  const index = packagePath.lastIndexOf(marker);
  return index === -1 ? packagePath : packagePath.slice(index + marker.length);
}

function inspectSourceMap(archivePath, fileContents, issues) {
  const content = getFileContent(fileContents, archivePath);
  if (content === undefined) {
    issues.push(`source map content was not supplied for inspection: ${archivePath}`);
    return;
  }

  let sourceMap;
  try {
    sourceMap = JSON.parse(String(content));
  } catch (error) {
    issues.push(`${archivePath} is not valid source-map JSON: ${error.message}`);
    return;
  }

  const contentKey = findObjectKey(sourceMap, SOURCE_MAP_CONTENT_KEYS);
  if (contentKey !== undefined) {
    issues.push(`${archivePath} embeds source text through ${contentKey}`);
  }

  for (const referencedPath of collectSourceMapPaths(sourceMap)) {
    if (isAbsoluteSourceReference(referencedPath)) {
      issues.push(`${archivePath} contains an absolute source path: ${JSON.stringify(referencedPath)}`);
    }
  }
}

function findObjectKey(value, forbiddenKeys) {
  if (value === null || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findObjectKey(item, forbiddenKeys);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  for (const [key, child] of Object.entries(value)) {
    if (forbiddenKeys.has(key)) return key;
    const found = findObjectKey(child, forbiddenKeys);
    if (found !== undefined) return found;
  }
  return undefined;
}

function collectSourceMapPaths(sourceMap) {
  if (sourceMap === null || typeof sourceMap !== "object" || Array.isArray(sourceMap)) return [];
  const referencedPaths = [];
  if (typeof sourceMap.file === "string") referencedPaths.push(sourceMap.file);
  if (typeof sourceMap.sourceRoot === "string") referencedPaths.push(sourceMap.sourceRoot);
  if (Array.isArray(sourceMap.sources)) {
    referencedPaths.push(...sourceMap.sources.filter((source) => typeof source === "string"));
  }
  if (Array.isArray(sourceMap.sections)) {
    for (const section of sourceMap.sections) {
      if (section !== null && typeof section === "object" && !Array.isArray(section)) {
        if (typeof section.url === "string") referencedPaths.push(section.url);
        referencedPaths.push(...collectSourceMapPaths(section.map));
      }
    }
  }
  return referencedPaths;
}

function isAbsoluteSourceReference(value) {
  return (
    value.startsWith("/") ||
    value.startsWith("file:") ||
    /^[A-Za-z]:[\\/]/u.test(value) ||
    value.startsWith("\\\\")
  );
}

function usage() {
  return `Usage:
  node scripts/check-release-package.mjs --metadata <npm-pack.json|-> [options]

Options:
  --root <directory>          Package root or extracted archive root (default: cwd)
  --expected-name <name>      Expected npm package name (default: package.json)
  --expected-version <value>  Expected npm package version (default: package.json)
  -h, --help                  Show this help
`;
}

function parseArguments(argv) {
  const result = { root: process.cwd() };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "-h" || argument === "--help") {
      result.help = true;
      continue;
    }
    if (!["--metadata", "--root", "--expected-name", "--expected-version"].includes(argument)) {
      throw new Error(`Unknown argument: ${argument}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.length === 0) throw new Error(`${argument} requires a value`);
    index += 1;
    if (argument === "--metadata") result.metadataPath = value;
    if (argument === "--root") result.root = value;
    if (argument === "--expected-name") result.expectedName = value;
    if (argument === "--expected-version") result.expectedVersion = value;
  }
  return result;
}

async function readJsonFileOrStdin(filePath) {
  let text;
  if (filePath === "-") {
    process.stdin.setEncoding("utf8");
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    text = chunks.join("");
  } else {
    text = await readFile(filePath, "utf8");
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Could not parse npm pack metadata JSON: ${error.message}`);
  }
}

function metadataFiles(metadata) {
  const entry = Array.isArray(metadata) && metadata.length === 1 ? metadata[0] : metadata;
  if (entry === null || typeof entry !== "object" || !Array.isArray(entry.files)) return [];
  return entry.files
    .map((file) => file?.path)
    .filter((archivePath) => isSafeArchivePath(archivePath));
}

async function readInspectableFiles(root, metadata) {
  const contents = new Map();
  const canonicalRoot = await realpath(root);
  const requestedPaths = metadataFiles(metadata).filter(
    (archivePath) =>
      archivePath.endsWith(".map") ||
      archivePath === "homebrew-package-lock.json" ||
      archivePath === "package.json",
  );

  for (const archivePath of requestedPaths) {
    const candidate = path.resolve(canonicalRoot, archivePath);
    const canonicalCandidate = await realpath(candidate);
    const relative = path.relative(canonicalRoot, canonicalCandidate);
    if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
      throw new Error(`${archivePath} resolves outside --root`);
    }
    contents.set(archivePath, await readFile(canonicalCandidate, "utf8"));
  }
  return contents;
}

async function readProjectLockfile(root) {
  const lockfilePath = path.join(root, "package-lock.json");
  let text;
  try {
    text = await readFile(lockfilePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw new Error(`Could not read ${lockfilePath}: ${error.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Could not parse ${lockfilePath}: ${error.message}`);
  }
}

async function main(argv) {
  const options = parseArguments(argv);
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  if (options.metadataPath === undefined) {
    throw new Error("--metadata is required (use --metadata - for stdin)");
  }

  const root = path.resolve(options.root);
  const metadata = await readJsonFileOrStdin(options.metadataPath);
  let rootManifest;
  if (options.expectedName === undefined || options.expectedVersion === undefined) {
    try {
      rootManifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
    } catch (error) {
      throw new Error(`Could not read ${path.join(root, "package.json")}: ${error.message}`);
    }
  }

  const result = validateReleasePackage(metadata, {
    expectedName: options.expectedName ?? rootManifest?.name,
    expectedVersion: options.expectedVersion ?? rootManifest?.version,
    fileContents: await readInspectableFiles(root, metadata),
    projectLockfile: await readProjectLockfile(root),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] !== undefined && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
