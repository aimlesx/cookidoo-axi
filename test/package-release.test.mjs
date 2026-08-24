import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  ReleasePackageValidationError,
  validateReleasePackage,
} from "../scripts/check-release-package.mjs";
import { assertNoUnexpectedDistPaths } from "../scripts/dist-layout.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROJECT_PACKAGE = JSON.parse(await readFile(path.join(PROJECT_ROOT, "package.json"), "utf8"));
const VERSION = PROJECT_PACKAGE.version;
const REQUIRED_FILES = [
  ["LICENSE", 10, 0o644],
  ["NOTICE", 10, 0o644],
  ["README.md", 10, 0o644],
  ["SECURITY.md", 10, 0o644],
  ["THIRD_PARTY_NOTICES.md", 10, 0o644],
  ["bin/cookidoo-axi.mjs", 10, 0o755],
  ["dist/cli.js", 10, 0o644],
  ["dist/cli.js.map", 10, 0o644],
  ["dist/generated/openapi-manifest.json", 10, 0o644],
  ["homebrew-package-lock.json", 10, 0o644],
  ["package.json", 10, 0o644],
  ["skills/cookidoo-axi/SKILL.md", 10, 0o644],
];

function metadata(overrides = {}) {
  const { files: fileOverrides = REQUIRED_FILES, ...entryOverrides } = overrides;
  const files = fileOverrides.map(([filePath, size, mode]) => ({
    path: filePath,
    size,
    mode,
  }));
  return [
    {
      name: "cookidoo-axi",
      version: VERSION,
      filename: `cookidoo-axi-${VERSION}.tgz`,
      entryCount: files.length,
      files,
      ...entryOverrides,
    },
  ];
}

function contents(overrides = {}) {
  return new Map([
    [
      "package.json",
      JSON.stringify({
        name: "cookidoo-axi",
        version: VERSION,
        dependencies: { ajv: "8.20.0" },
        overrides: { "fast-deep-equal": "3.1.3", "fast-uri": "3.1.5" },
        devDependencies: { "dev-only": "1.0.0" },
      }),
    ],
    [
      "dist/cli.js.map",
      JSON.stringify({ version: 3, file: "cli.js", sourceRoot: "", sources: ["../src/cli.ts"], names: [], mappings: "" }),
    ],
    ["homebrew-package-lock.json", JSON.stringify(projectLock())],
    ...Object.entries(overrides),
  ]);
}

function projectLock() {
  const integrity = `sha512-${Buffer.alloc(64, 1).toString("base64")}`;
  const runtimePackage = (name, version, extra = {}) => ({
    version,
    resolved: `https://registry.npmjs.org/${name}/-/${name.split("/").at(-1)}-${version}.tgz`,
    integrity,
    ...extra,
  });
  return {
    name: "cookidoo-axi",
    version: VERSION,
    lockfileVersion: 3,
    packages: {
      "": {
        name: "cookidoo-axi",
        version: VERSION,
        dependencies: { ajv: "8.20.0" },
        devDependencies: { "dev-only": "1.0.0" },
      },
      "node_modules/ajv": runtimePackage("ajv", "8.20.0", {
        dependencies: {
          "fast-deep-equal": "^3.1.3",
          "fast-uri": "^3.0.1",
        },
        optionalDependencies: {
          "exact-optional": "1.0.0",
        },
      }),
      "node_modules/fast-deep-equal": runtimePackage("fast-deep-equal", "3.1.3"),
      "node_modules/fast-uri": runtimePackage("fast-uri", "3.1.5"),
      "node_modules/exact-optional": runtimePackage("exact-optional", "1.0.0", { optional: true }),
      "node_modules/dev-only": runtimePackage("dev-only", "1.0.0", {
        dev: true,
        dependencies: { "unreachable-range": "^9.0.0" },
      }),
      "node_modules/unreachable-range": runtimePackage("unreachable-range", "9.1.0", { dev: true }),
    },
  };
}

function validationIssues(packMetadata, options = {}) {
  assert.throws(
    () =>
      validateReleasePackage(packMetadata, {
        expectedVersion: VERSION,
        fileContents: contents(),
        ...options,
      }),
    (error) => {
      assert.ok(error instanceof ReleasePackageValidationError);
      options.inspect?.(error.issues);
      return true;
    },
  );
}

test("release package validator accepts only the intended runtime payload", () => {
  const result = validateReleasePackage(metadata(), {
    expectedVersion: VERSION,
    fileContents: contents(),
  });

  assert.deepEqual(result, {
    ok: true,
    name: "cookidoo-axi",
    version: VERSION,
    filename: `cookidoo-axi-${VERSION}.tgz`,
    fileCount: REQUIRED_FILES.length,
    sourceMapCount: 1,
  });
});

test("shipped notice preserves source provenance and third-party rights boundary", async () => {
  const notice = await readFile(path.join(PROJECT_ROOT, "NOTICE"), "utf8");
  const noticeLines = notice.split("\n");
  const sourceMarker = noticeLines.indexOf("`cookidoo-openapi` project at");
  assert.ok(sourceMarker >= 0);
  assert.equal(noticeLines[sourceMarker + 1], "https://github.com/aimlesx/cookidoo-openapi, commit");
  assert.match(notice, /69bb43119b162ad8fea48ddb6a436d2074013972/u);
  assert.match(notice, /MIT License in `LICENSE` applies only to the `cookidoo-axi` software/u);
  assert.match(notice, /grants no rights to Cookidoo, Thermomix, or Vorwerk trademarks/u);
  assert.match(notice, /does not\s+license Cookidoo responses, recipes, media, user content, or databases/u);
});

test("release package validator rejects missing and orphaned compiled outputs", () => {
  const expectedDistPaths = [
    "dist/cli.js",
    "dist/cli.js.map",
    "dist/generated/openapi-manifest.json",
  ];
  const files = [...REQUIRED_FILES, ["dist/stale-orphan.js", 10, 0o644]];
  validationIssues(metadata({ files }), {
    expectedDistPaths,
    inspect(issues) {
      assert.ok(issues.includes("compiled output is unexpected: dist/stale-orphan.js"));
    },
  });

  validationIssues(
    metadata({ files: REQUIRED_FILES.filter(([archivePath]) => archivePath !== "dist/cli.js.map") }),
    {
      expectedDistPaths,
      inspect(issues) {
        assert.ok(issues.includes("compiled output is missing: dist/cli.js.map"));
      },
    },
  );
});

test("build preflight rejects an unexpected dist file without deleting it", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "cookidoo-axi-dist-layout-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(root, "dist"), { recursive: true });
  await writeFile(path.join(root, "src/example.ts"), "export const example = true;\n");
  const orphan = path.join(root, "dist/private-debug.json");
  await writeFile(orphan, "private fixture\n");

  assert.throws(
    () => assertNoUnexpectedDistPaths(root),
    /Refusing to build with unexpected files in dist: dist\/private-debug\.json/u,
  );
  assert.equal(await readFile(orphan, "utf8"), "private fixture\n");
});

test("build preflight rejects dist symlinks without touching their targets", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "cookidoo-axi-dist-symlink-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src/example.ts"), "export const example = true;\n");

  const outsideDirectory = path.join(root, "outside");
  await mkdir(outsideDirectory);
  const sentinel = path.join(outsideDirectory, "sentinel.txt");
  await writeFile(sentinel, "unchanged\n");
  await symlink(outsideDirectory, path.join(root, "dist"));
  assert.throws(() => assertNoUnexpectedDistPaths(root), /must be a real directory/u);
  assert.equal(await readFile(sentinel, "utf8"), "unchanged\n");

  await rm(path.join(root, "dist"));
  await mkdir(path.join(root, "dist"));
  const outsideFile = path.join(outsideDirectory, "compiled.js");
  await writeFile(outsideFile, "outside target\n");
  await symlink(outsideFile, path.join(root, "dist/example.js"));
  assert.throws(() => assertNoUnexpectedDistPaths(root), /must be a regular file or directory/u);
  assert.equal(await readFile(outsideFile, "utf8"), "outside target\n");
});

test("release package validator rejects identity, filename, and manifest drift", () => {
  const packMetadata = metadata({
    name: "wrong-name",
    version: "9.9.9",
    filename: "unrelated.tgz",
  });

  validationIssues(packMetadata, {
    fileContents: contents({
      "package.json": JSON.stringify({
        name: "wrong-name",
        version: "9.9.9",
        dependencies: { ajv: "8.20.0" },
        overrides: { "fast-uri": "3.1.5" },
      }),
    }),
    inspect(issues) {
      assert.ok(issues.some((issue) => issue.includes("package name must be")));
      assert.ok(issues.some((issue) => issue.includes("package version must be")));
      assert.ok(issues.some((issue) => issue.includes("package filename must be")));
      assert.ok(issues.some((issue) => issue.includes("package.json name must be")));
      assert.ok(issues.some((issue) => issue.includes("package.json version must be")));
    },
  });
});

test("release package validator requires every release artifact and executable bin mode", () => {
  const files = REQUIRED_FILES
    .filter(([filePath]) => filePath !== "THIRD_PARTY_NOTICES.md")
    .map(([filePath, size, mode]) => [filePath, size, filePath === "bin/cookidoo-axi.mjs" ? 0o644 : mode]);

  validationIssues(metadata({ files }), {
    inspect(issues) {
      assert.ok(issues.includes("required release file is missing: THIRD_PARTY_NOTICES.md"));
      assert.ok(issues.some((issue) => issue.includes("must have npm pack mode 0755")));
    },
  });
});

test("release package validator requires a nonempty canonical agent skill", () => {
  validationIssues(metadata({
    files: REQUIRED_FILES.filter(([filePath]) => filePath !== "skills/cookidoo-axi/SKILL.md"),
  }), {
    inspect(issues) {
      assert.ok(issues.includes(
        "required release file is missing: skills/cookidoo-axi/SKILL.md",
      ));
    },
  });

  validationIssues(metadata({
    files: REQUIRED_FILES.map(([filePath, size, mode]) => [
      filePath,
      filePath === "skills/cookidoo-axi/SKILL.md" ? 0 : size,
      mode,
    ]),
  }), {
    inspect(issues) {
      assert.ok(issues.includes(
        "required release file is empty: skills/cookidoo-axi/SKILL.md",
      ));
    },
  });
});

test("release package validator rejects every noncanonical skill path", () => {
  const extraSkillPaths = [
    "skills/cookidoo-axi/README.md",
    "skills/other/SKILL.md",
  ];
  validationIssues(metadata({
    files: [
      ...REQUIRED_FILES,
      ...extraSkillPaths.map((filePath) => [filePath, 10, 0o644]),
    ],
  }), {
    inspect(issues) {
      for (const filePath of extraSkillPaths) {
        assert.ok(issues.includes(`${filePath} is outside the release allowlist`));
      }
    },
  });
});

test("release package validator rejects code, dependency, and credential leakage", () => {
  const leakedPaths = [
    "src/auth/login.ts",
    "test/auth.test.mjs",
    "scripts/release.mjs",
    "node_modules/example/index.js",
    ".env",
    "dist/credentials.json",
    "dist/signing-key.pem",
    "package-lock.json",
    "npm-shrinkwrap.json",
    "notes.txt",
  ];
  const files = [
    ...REQUIRED_FILES,
    ...leakedPaths.map((archivePath) => [archivePath, 10, 0o644]),
  ];

  validationIssues(metadata({ files }), {
    inspect(issues) {
      for (const archivePath of leakedPaths) {
        assert.ok(issues.some((issue) => issue.startsWith(archivePath)), archivePath);
      }
    },
  });
});

test("release package validator requires exact runtime dependency and override pins", () => {
  validationIssues(metadata(), {
    fileContents: contents({
      "package.json": JSON.stringify({
        name: "cookidoo-axi",
        version: VERSION,
        dependencies: {
          ajv: "^8.20.0",
          example: "workspace:*",
        },
        overrides: {
          "fast-uri": "~3.1.5",
          nested: { child: "https://example.invalid/child.tgz" },
        },
      }),
    }),
    inspect(issues) {
      assert.ok(issues.some((issue) => issue.includes('dependencies["ajv"]')));
      assert.ok(issues.some((issue) => issue.includes('dependencies["example"]')));
      assert.ok(issues.some((issue) => issue.includes('overrides["fast-uri"]')));
      assert.ok(issues.some((issue) => issue.includes('overrides["nested"]["child"]')));
    },
  });
});

test("release package validator checks every reachable runtime range against the lock", () => {
  const result = validateReleasePackage(metadata(), {
    expectedVersion: VERSION,
    fileContents: contents(),
    projectLockfile: projectLock(),
  });
  assert.equal(result.ok, true);
});

test("release lock requires registry integrity and both macOS native targets", () => {
  const badIntegrity = projectLock();
  delete badIntegrity.packages["node_modules/fast-uri"].integrity;
  validationIssues(metadata(), {
    projectLockfile: badIntegrity,
    fileContents: contents({
      "homebrew-package-lock.json": JSON.stringify(badIntegrity),
    }),
    inspect(issues) {
      assert.ok(issues.includes("locked runtime package node_modules/fast-uri must have a valid sha512 integrity"));
    },
  });

  const credentialedDev = projectLock();
  credentialedDev.packages["node_modules/dev-only"].resolved =
    "https://fixture:secret@registry.npmjs.org/dev-only/-/dev-only-1.0.0.tgz";
  validationIssues(metadata(), {
    projectLockfile: credentialedDev,
    fileContents: contents({
      "homebrew-package-lock.json": JSON.stringify(credentialedDev),
    }),
    inspect(issues) {
      assert.ok(issues.includes("release lock contains a credential-bearing URL at $.packages.node_modules/dev-only.resolved"));
    },
  });

  const badResolved = projectLock();
  badResolved.packages["node_modules/fast-uri"].resolved = "file:../untrusted-fast-uri.tgz";
  validationIssues(metadata(), {
    projectLockfile: badResolved,
    fileContents: contents({
      "homebrew-package-lock.json": JSON.stringify(badResolved),
    }),
    inspect(issues) {
      assert.ok(
        issues.includes(
          "locked runtime package node_modules/fast-uri must use a credential-free npm registry HTTPS URL",
        ),
      );
    },
  });

  const missingNative = projectLock();
  missingNative.packages[""].dependencies["@napi-rs/keyring"] = "1.3.0";
  missingNative.packages["node_modules/@napi-rs/keyring"] = {
    version: "1.3.0",
    resolved: "https://registry.npmjs.org/@napi-rs/keyring/-/keyring-1.3.0.tgz",
    integrity: `sha512-${Buffer.alloc(64, 1).toString("base64")}`,
    optionalDependencies: {
      "@napi-rs/keyring-darwin-arm64": "1.3.0",
      "@napi-rs/keyring-darwin-x64": "1.3.0",
    },
  };
  missingNative.packages["node_modules/@napi-rs/keyring-darwin-arm64"] = {
    version: "1.3.0",
    resolved: "https://registry.npmjs.org/@napi-rs/keyring-darwin-arm64/-/keyring-darwin-arm64-1.3.0.tgz",
    integrity: `sha512-${Buffer.alloc(64, 1).toString("base64")}`,
    optional: true,
    os: ["darwin"],
    cpu: ["arm64"],
  };
  validationIssues(metadata(), {
    projectLockfile: missingNative,
    fileContents: contents({
      "package.json": JSON.stringify({
        name: "cookidoo-axi",
        version: VERSION,
        dependencies: { ajv: "8.20.0", "@napi-rs/keyring": "1.3.0" },
        overrides: { "fast-deep-equal": "3.1.3", "fast-uri": "3.1.5" },
      }),
      "homebrew-package-lock.json": JSON.stringify(missingNative),
    }),
    inspect(issues) {
      assert.ok(
        issues.includes(
          "required macOS native package is missing from the release lock: node_modules/@napi-rs/keyring-darwin-x64",
        ),
      );
    },
  });
});

test("release lock root metadata must remain compatible with npm ci", () => {
  validationIssues(metadata(), {
    projectLockfile: projectLock(),
    fileContents: contents({
      "package.json": JSON.stringify({
        name: "cookidoo-axi",
        version: VERSION,
        dependencies: { ajv: "8.20.0" },
        overrides: { "fast-deep-equal": "3.1.3", "fast-uri": "3.1.5" },
        devDependencies: { "different-dev-only": "2.0.0" },
      }),
    }),
    inspect(issues) {
      assert.ok(issues.includes("project package-lock.json root devDependencies do not match package.json"));
    },
  });
});

test("release package validator rejects a missing or drifted closure override", async (t) => {
  await t.test("omitted", () => {
    validationIssues(metadata(), {
      projectLockfile: projectLock(),
      fileContents: contents({
        "package.json": JSON.stringify({
          name: "cookidoo-axi",
          version: VERSION,
          dependencies: { ajv: "8.20.0" },
          overrides: { "fast-deep-equal": "3.1.3" },
        }),
      }),
      inspect(issues) {
        assert.ok(
          issues.some(
            (issue) =>
              issue.includes("ajv -> fast-uri") &&
              issue.includes('must equal locked version "3.1.5", got undefined'),
          ),
        );
      },
    });
  });

  await t.test("drifted", () => {
    validationIssues(metadata(), {
      projectLockfile: projectLock(),
      fileContents: contents({
        "package.json": JSON.stringify({
          name: "cookidoo-axi",
          version: VERSION,
          dependencies: { ajv: "8.20.0" },
          overrides: { "fast-deep-equal": "3.1.3", "fast-uri": "3.1.4" },
        }),
      }),
      inspect(issues) {
        assert.ok(
          issues.some(
            (issue) =>
              issue.includes("ajv -> fast-uri") &&
              issue.includes('must equal locked version "3.1.5", got "3.1.4"'),
          ),
        );
      },
    });
  });
});

test("release package validator rejects unsafe and duplicate archive paths", () => {
  const files = [
    ...REQUIRED_FILES,
    ["../.env", 10, 0o644],
    ["dist/cli.js", 10, 0o644],
  ];

  validationIssues(metadata({ files }), {
    inspect(issues) {
      assert.ok(issues.some((issue) => issue.includes("not a safe npm archive path")));
      assert.ok(issues.includes("duplicate archive path: dist/cli.js"));
    },
  });
});

test("release package validator inspects every source map", async (t) => {
  await t.test("rejects embedded source text", () => {
    validationIssues(metadata(), {
      fileContents: contents({
        "dist/cli.js.map": JSON.stringify({ version: 3, sources: ["../src/cli.ts"], sourcesContent: ["secret source"] }),
      }),
      inspect(issues) {
        assert.ok(issues.some((issue) => issue.includes("embeds source text through sourcesContent")));
      },
    });
  });

  for (const absolutePath of ["/Users/example/src/cli.ts", "C:\\Users\\example\\cli.ts", "file:///tmp/cli.ts", "\\\\server\\share\\cli.ts"]) {
    await t.test(`rejects absolute source path ${absolutePath}`, () => {
      validationIssues(metadata(), {
        fileContents: contents({
          "dist/cli.js.map": JSON.stringify({ version: 3, sources: [absolutePath] }),
        }),
        inspect(issues) {
          assert.ok(issues.some((issue) => issue.includes("absolute source path")));
        },
      });
    });
  }

  await t.test("fails closed when map content is unavailable", () => {
    const fileContents = contents();
    fileContents.delete("dist/cli.js.map");
    validationIssues(metadata(), {
      fileContents,
      inspect(issues) {
        assert.ok(issues.includes("source map content was not supplied for inspection: dist/cli.js.map"));
      },
    });
  });
});

test("release package validator CLI reads npm metadata and archive-root files", async () => {
  const scriptPath = path.join(PROJECT_ROOT, "scripts/check-release-package.mjs");
  const root = await mkdtemp(path.join(tmpdir(), "cookidoo-axi-release-test-"));
  try {
    for (const [archivePath] of REQUIRED_FILES) {
      await mkdir(path.dirname(path.join(root, archivePath)), { recursive: true });
      let content = "fixture\n";
      if (archivePath === "package.json") {
        content = JSON.stringify({
          name: "cookidoo-axi",
          version: VERSION,
          dependencies: { ajv: "8.20.0" },
          overrides: { "fast-deep-equal": "3.1.3", "fast-uri": "3.1.5" },
          devDependencies: { "dev-only": "1.0.0" },
        });
      } else if (archivePath === "homebrew-package-lock.json") {
        content = JSON.stringify(projectLock());
      } else if (archivePath.endsWith(".map")) {
        content = JSON.stringify({ version: 3, file: "cli.js", sources: ["../src/cli.ts"], mappings: "" });
      }
      await writeFile(path.join(root, archivePath), content);
    }
    const metadataPath = path.join(root, "pack.json");
    await writeFile(metadataPath, JSON.stringify(metadata()));
    await writeFile(path.join(root, "package-lock.json"), JSON.stringify(projectLock()));

    const completed = spawnSync(
      process.execPath,
      [scriptPath, "--metadata", metadataPath, "--root", root],
      { encoding: "utf8" },
    );

    assert.equal(completed.status, 0, completed.stderr);
    assert.deepEqual(JSON.parse(completed.stdout), {
      ok: true,
      name: "cookidoo-axi",
      version: VERSION,
      filename: `cookidoo-axi-${VERSION}.tgz`,
      fileCount: REQUIRED_FILES.length,
      sourceMapCount: 1,
    });

    const piped = spawnSync(
      process.execPath,
      [scriptPath, "--metadata", "-", "--root", root],
      { encoding: "utf8", input: JSON.stringify(metadata()) },
    );
    assert.equal(piped.status, 0, piped.stderr);
    assert.deepEqual(JSON.parse(piped.stdout), JSON.parse(completed.stdout));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
