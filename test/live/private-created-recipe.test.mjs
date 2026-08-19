import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const bin = resolve(root, "bin/cookidoo-axi.mjs");
const enabled = process.env.COOKIDOO_AXI_LIVE === "1";
const profile = process.env.COOKIDOO_AXI_LIVE_PROFILE ?? "default";

async function cli(args) {
  try {
    const result = await execFileAsync(process.execPath, [bin, ...args, "--output", "json", "--profile", profile], {
      cwd: root,
      timeout: 120_000,
      maxBuffer: 2 * 1024 * 1024,
      env: process.env,
    });
    return JSON.parse(result.stdout);
  } catch (error) {
    const structured = typeof error?.stdout === "string" && error.stdout.length > 0
      ? JSON.parse(error.stdout) : undefined;
    const detail = structured?.data?.error;
    error.structured = structured;
    error.message = [
      `cookidoo-axi ${args.slice(0, 2).join(" ")} failed`,
      typeof detail?.code === "string" ? `code=${detail.code}` : undefined,
      Number.isInteger(detail?.details?.status) ? `status=${detail.details.status}` : undefined,
      typeof detail?.details?.contentType === "string"
        ? `contentType=${detail.details.contentType}` : undefined,
      typeof detail?.outcome === "string" ? `outcome=${detail.outcome}` : undefined,
    ].filter(Boolean).join("; ");
    throw error;
  }
}

async function createdIds() {
  const listed = await cli([
    "created", "list",
    "--fields", "recipeId",
    "--full",
    "--timeout-ms", "60000",
  ]);
  assert.ok(Array.isArray(listed?.data), "created list must return an ID-bearing array for safe reconciliation");
  return new Set(listed.data
    .map((item) => item?.recipeId)
    .filter((value) => typeof value === "string"));
}

async function resourceExists(recipeId) {
  try {
    await cli(["created", "get", recipeId, "--timeout-ms", "60000"]);
    return true;
  } catch (error) {
    const structured = error?.structured ?? (
      typeof error?.stdout === "string" && error.stdout.length > 0
        ? JSON.parse(error.stdout) : undefined
    );
    const status = structured?.data?.error?.details?.status;
    if (status === 404 || status === 410) return false;
    throw error;
  }
}

test("create, read, privately edit, and delete only this test's recipe ID", {
  skip: !enabled,
  timeout: 300_000,
}, async () => {
  const uniqueName = `cookidoo-axi-live-${new Date().toISOString()}-${randomUUID()}`;
  let recipeId;
  let deleted = false;
  let deleteAttempted = false;
  let primaryError;
  let unresolvedCreate;
  const beforeIds = await createdIds();

  try {
    const created = await cli([
      "created", "create",
      "--recipe-name", uniqueName,
      "--timeout-ms", "60000",
    ]);
    recipeId = created?.data?.recipeId;
    assert.match(recipeId, /^[0-9A-HJKMNP-TV-Z]{26}$/u, "create must return the exact customer-recipe ULID");

    const fetched = await cli(["created", "get", recipeId, "--timeout-ms", "60000"]);
    assert.equal(fetched?.data?.recipeId, recipeId);

    const updatedName = `${uniqueName}-edited`;
    const updated = await cli([
      "created", "update", recipeId,
      "--name", updatedName,
      "--timeout-ms", "60000",
    ]);
    assert.equal(updated?.data?.recipeId, recipeId);

    const verified = await cli(["created", "get", recipeId, "--timeout-ms", "60000"]);
    assert.equal(verified?.data?.recipeId, recipeId);
    assert.equal(verified?.data?.recipeContent?.name, updatedName);

    deleteAttempted = true;
    await cli([
      "created", "delete", recipeId,
      "--confirm", `created-recipe:${recipeId}:delete`,
      "--timeout-ms", "60000",
    ]);
    deleted = !(await resourceExists(recipeId));
    assert.equal(deleted, true, "the exact test recipe must be absent after delete");
  } catch (error) {
    primaryError = error;
    if (recipeId === undefined) {
      const afterIds = await createdIds();
      const candidates = [...afterIds].filter((id) => !beforeIds.has(id));
      const matches = [];
      for (const candidate of candidates) {
        const fetched = await cli(["created", "get", candidate, "--timeout-ms", "60000"]);
        if (fetched?.data?.recipeContent?.name === uniqueName) matches.push(candidate);
      }
      if (matches.length === 1) {
        recipeId = matches[0];
      } else {
        unresolvedCreate = new Error(
          `Ambiguous create reconciliation found ${candidates.length} new IDs and ${matches.length} exact markers; no cleanup target was guessed`,
        );
      }
    }
  } finally {
    if (recipeId !== undefined && !deleted) {
      assert.match(recipeId, /^[0-9A-HJKMNP-TV-Z]{26}$/u, "cleanup ID must be the exact returned ULID");
      try {
        if (deleteAttempted && !(await resourceExists(recipeId))) {
          deleted = true;
        }
        if (!deleted) {
          deleteAttempted = true;
          await cli([
            "created", "delete", recipeId,
            "--confirm", `created-recipe:${recipeId}:delete`,
            "--timeout-ms", "60000",
          ]);
          deleted = !(await resourceExists(recipeId));
          assert.equal(deleted, true, "cleanup must verify absence of the exact test recipe ID");
        }
      } catch (cleanupError) {
        throw new AggregateError(
          [primaryError, cleanupError].filter(Boolean),
          `Live test could not confirm cleanup of its exact recipe ID ${recipeId}; reconcile before any retry`,
        );
      }
    }
  }
  if (primaryError !== undefined) {
    if (unresolvedCreate !== undefined) {
      throw new AggregateError([primaryError, unresolvedCreate], "Live create outcome requires manual reconciliation");
    }
    throw primaryError;
  }
  assert.equal(deleted, true);
});
