import { lstatSync, readdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

function walkFiles(directory) {
  const rootStat = lstatSync(directory);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`Refusing unsafe build path: ${directory} must be a real directory`);
  }
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(path));
    else if (entry.isFile()) files.push(path);
    else throw new Error(`Refusing unsafe build entry: ${path} must be a regular file or directory`);
  }
  return files;
}

function portableRelative(root, path) {
  return relative(root, path).split(sep).join("/");
}

export function expectedDistPaths(projectRoot) {
  const root = resolve(projectRoot);
  const sourceRoot = join(root, "src");
  const expected = new Set();

  for (const sourcePath of walkFiles(sourceRoot)) {
    const sourceRelative = portableRelative(sourceRoot, sourcePath);
    if (sourceRelative.endsWith(".ts")) {
      const stem = sourceRelative.slice(0, -3);
      expected.add(`dist/${stem}.js`);
      continue;
    }
    if (sourceRelative === "generated/openapi-manifest.json") {
      expected.add(`dist/${sourceRelative}`);
    }
  }

  return Object.freeze([...expected].sort());
}

export function actualDistPaths(projectRoot) {
  const root = resolve(projectRoot);
  const distRoot = join(root, "dist");
  try {
    lstatSync(distRoot);
  } catch (error) {
    if (error.code === "ENOENT") return Object.freeze([]);
    throw error;
  }
  return Object.freeze(
    walkFiles(distRoot)
      .map((path) => `dist/${portableRelative(distRoot, path)}`)
      .sort(),
  );
}

export function assertNoUnexpectedDistPaths(projectRoot) {
  const expected = new Set(expectedDistPaths(projectRoot));
  const unexpected = actualDistPaths(projectRoot).filter((path) => !expected.has(path));
  if (unexpected.length > 0) {
    throw new Error(
      `Refusing to build with unexpected files in dist: ${unexpected.join(", ")}. ` +
        "Review and remove only files you have confirmed are stale.",
    );
  }
}

export function assertExactDistLayout(projectRoot) {
  const expected = expectedDistPaths(projectRoot);
  const actual = actualDistPaths(projectRoot);
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  const missing = expected.filter((path) => !actualSet.has(path));
  const unexpected = actual.filter((path) => !expectedSet.has(path));

  if (missing.length > 0 || unexpected.length > 0) {
    const details = [
      ...missing.map((path) => `missing ${path}`),
      ...unexpected.map((path) => `unexpected ${path}`),
    ];
    throw new Error(`Compiled dist layout does not match src: ${details.join(", ")}`);
  }
  return actual;
}
