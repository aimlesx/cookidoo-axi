import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import YAML from "yaml";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW_PATH = path.join(PROJECT_ROOT, ".github/workflows/release.yml");
const WORKFLOW_SOURCE = await readFile(WORKFLOW_PATH, "utf8");
const WORKFLOW = YAML.parse(WORKFLOW_SOURCE);
const PROJECT_PACKAGE = JSON.parse(await readFile(path.join(PROJECT_ROOT, "package.json"), "utf8"));

function step(job, name) {
  const result = job.steps.find((candidate) => candidate.name === name);
  assert.ok(result, `missing workflow step: ${name}`);
  return result;
}

function actionUses(job) {
  return job.steps.filter((candidate) => candidate.uses).map((candidate) => candidate.uses);
}

test("release workflow accepts only version tags and pins its release inputs", () => {
  assert.deepEqual(WORKFLOW.on, { push: { tags: ["v*"] } });
  assert.deepEqual(WORKFLOW.permissions, { contents: "read" });
  assert.equal(WORKFLOW.concurrency["cancel-in-progress"], false);
  assert.deepEqual(WORKFLOW.env, {
    NODE_VERSION: "24.19.0",
    NPM_VERSION: "11.17.0",
    OPENAPI_REPOSITORY: "aimlesx/cookidoo-openapi",
    OPENAPI_COMMIT: "69bb43119b162ad8fea48ddb6a436d2074013972",
  });
  assert.equal(PROJECT_PACKAGE.packageManager, `npm@${WORKFLOW.env.NPM_VERSION}`);

  for (const uses of [
    ...actionUses(WORKFLOW.jobs.build),
    ...actionUses(WORKFLOW.jobs.publish),
  ]) {
    assert.match(uses, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[0-9a-f]{40}$/u);
  }
});

test("release build proves signed canonical main provenance before packing once", () => {
  const build = WORKFLOW.jobs.build;
  assert.equal(build.if, "github.repository == 'aimlesx/cookidoo-axi'");
  assert.equal(build["runs-on"], "macos-15");
  assert.deepEqual(build.permissions, { contents: "read" });

  const checkout = step(build, "Check out the tagged source");
  assert.equal(checkout.with["fetch-depth"], 0);
  assert.equal(checkout.with["persist-credentials"], false);

  const openapi = step(build, "Check out the pinned OpenAPI source");
  assert.equal(openapi.with.repository, "${{ env.OPENAPI_REPOSITORY }}");
  assert.equal(openapi.with.ref, "${{ env.OPENAPI_COMMIT }}");
  assert.equal(openapi.with["persist-credentials"], false);

  const identity = step(build, "Verify canonical repository, signed tag, version, and main commit").run;
  assert.match(identity, /GITHUB_REPOSITORY.*aimlesx\/cookidoo-axi/u);
  assert.match(identity, /\.visibility.*public/u);
  assert.match(identity, /git -C \.\.\/cookidoo-openapi rev-parse HEAD.*OPENAPI_COMMIT/u);
  assert.match(identity, /GITHUB_REF_NAME.*v\$\{version\}/u);
  assert.match(identity, /\.verification\.verified/u);
  assert.match(identity, /\.object\.type/u);
  assert.match(identity, /git rev-parse origin\/main/u);
  assert.match(identity, /README\.md/u);
  assert.match(identity, /SECURITY\.md/u);
  assert.match(identity, /metadata\.private, true/u);
  assert.match(identity, /metadata\.os, \["darwin"\]/u);
  assert.match(identity, /git\+https:\/\/github\.com\/aimlesx\/cookidoo-axi\.git/u);
  assert.match(identity, /https:\/\/github\.com\/aimlesx\/cookidoo-axi#readme/u);
  const bugsAssertion = identity.match(/assert\.equal\(metadata\.bugs\?\.url, "([^"]+)"\);/u);
  assert.equal(bugsAssertion?.[1], "https://github.com/aimlesx/cookidoo-axi/issues");

  const requiredGates = [
    "Verify pinned toolchain",
    "Install exact dependencies",
    "Run the offline suite",
    "Verify the generated OpenAPI manifest",
    "Audit dependencies",
    "Verify the native binding without Keychain or network access",
    "Pack the release assets once",
    "Upload the exact release assets",
  ];
  for (const name of requiredGates) step(build, name);

  assert.equal(
    [...WORKFLOW_SOURCE.matchAll(/node scripts\/prepare-homebrew-release\.mjs/gu)].length,
    1,
  );
  const doctor = step(build, "Verify the native binding without Keychain or network access").run;
  assert.match(doctor, /keychainRecordsRead, 0/u);
  assert.match(doctor, /keychainRecordsWritten, 0/u);
  assert.match(doctor, /networkRequests, 0/u);
  assert.doesNotMatch(WORKFLOW_SOURCE, /npm run test:live|test\/live\//u);
  assert.doesNotMatch(
    WORKFLOW_SOURCE,
    /COOKIDOO_(?:EMAIL|PASSWORD|FEED_USERNAME|FEED_PASSWORD)|auth import-(?:env|feed-env)/u,
  );
});

test("release publication is an isolated protected least-privilege job", () => {
  const publish = WORKFLOW.jobs.publish;
  assert.equal(publish.needs, "build");
  assert.equal(publish.if, "github.repository == 'aimlesx/cookidoo-axi'");
  assert.deepEqual(publish.environment, {
    name: "release",
    url: "https://github.com/aimlesx/cookidoo-axi/releases/tag/${{ github.ref_name }}",
  });
  assert.deepEqual(publish.permissions, { contents: "write" });
  assert.deepEqual(actionUses(publish), [
    "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c",
  ]);

  const publishRuns = publish.steps.map((candidate) => candidate.run ?? "").join("\n");
  assert.doesNotMatch(publishRuns, /(?:^|\s)npm(?:\s|$)/u);
  assert.doesNotMatch(publishRuns, /node scripts\//u);
  assert.match(publishRuns, /sha256sum --check SHA256SUMS/u);
  assert.match(publishRuns, /gh release create/u);
  assert.match(publishRuns, /--draft/u);
  assert.match(publishRuns, /gh release edit/u);
  assert.match(publishRuns, /--draft=false/u);
  assert.match(publishRuns, /--prerelease/u);
  assert.match(publishRuns, /--latest=false/u);
  assert.match(publishRuns, /CLI source commit.*GITHUB_SHA/u);
  assert.match(publishRuns, /OpenAPI source.*OPENAPI_REPOSITORY.*OPENAPI_COMMIT/u);

  const publishRelease = step(
    publish,
    "Create a draft with every asset, then publish the prerelease",
  ).run;
  assert.match(publishRelease, /GITHUB_REPOSITORY.*aimlesx\/cookidoo-axi/u);
  assert.match(publishRelease, /\.visibility.*public/u);
  assert.match(publishRelease, /GITHUB_REF_TYPE.*tag/u);
  assert.match(publishRelease, /git\/ref\/tags\/\$\{GITHUB_REF_NAME\}/u);
  assert.match(publishRelease, /\.verification\.verified/u);
  assert.match(publishRelease, /\.object\.type.*commit/u);
  assert.match(publishRelease, /\.object\.sha.*GITHUB_SHA/u);
  assert.ok(
    publishRelease.indexOf(".verification.verified") <
      publishRelease.indexOf("gh release create"),
    "signed-tag revalidation must happen immediately before release creation",
  );
});

test("release documentation exposes the supported Homebrew and security paths", async () => {
  const [readme, security, bugForm, securityForm] = await Promise.all([
    readFile(path.join(PROJECT_ROOT, "README.md"), "utf8"),
    readFile(path.join(PROJECT_ROOT, "SECURITY.md"), "utf8"),
    readFile(path.join(PROJECT_ROOT, ".github/ISSUE_TEMPLATE/cli-bug.yml"), "utf8"),
    readFile(path.join(PROJECT_ROOT, ".github/ISSUE_TEMPLATE/security-contact.yml"), "utf8"),
  ]);

  assert.match(readme, /Apple\s+Silicon \(arm64\)/u);
  assert.match(readme, /macOS 15/u);
  assert.match(readme, /brew install aimlesx\/tap\/cookidoo-axi/u);
  assert.match(readme, /brew upgrade aimlesx\/tap\/cookidoo-axi/u);
  assert.match(readme, /brew uninstall cookidoo-axi/u);
  assert.match(readme, /auth remove --profile default --confirm default/u);
  assert.match(security, new RegExp(PROJECT_PACKAGE.version.replaceAll(".", "\\."), "u"));
  assert.match(security, /Security contact request/u);
  assert.doesNotMatch(bugForm, /\bx64\b/u);
  assert.match(securityForm, /withheld all vulnerability details and sensitive data/u);
});

test("the opt-in live acceptance test can exercise an exact installed executable", async () => {
  const liveTest = await readFile(
    path.join(PROJECT_ROOT, "test/live/private-created-recipe.test.mjs"),
    "utf8",
  );
  assert.match(liveTest, /process\.env\.COOKIDOO_AXI_LIVE_BIN/u);
  assert.match(liveTest, /COOKIDOO_AXI_LIVE_BIN must be an absolute executable path/u);
  assert.match(liveTest, /execFileAsync\(executable/u);
  assert.doesNotMatch(liveTest, /shell:\s*true|execSync|spawnSync/u);
});
