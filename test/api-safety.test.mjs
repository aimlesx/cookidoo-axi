import assert from "node:assert/strict";
import test from "node:test";

import {
  OPENAPI_MANIFEST,
  assertValidRequestBody,
  canonicalOperation,
  coerceAndValidateParameters,
  findOperationByCommand,
  getOperationById,
  parseManifest,
  validateParameters,
  validateRequestBody,
  validateResponse,
} from "../dist/api/spec.js";
import {
  SEMANTIC_DESTRUCTIVE_OPERATIONS,
  assertSafety,
  classifySafety,
  deriveConfirmationTarget,
  evaluateSafety,
  reconciliationSuggestion,
} from "../dist/safety/policy.js";

function hasCode(code) {
  return (error) => {
    assert.equal(error?.code, code);
    return true;
  };
}

test("generated manifest exposes every mapped operation exactly once", () => {
  assert.equal(OPENAPI_MANIFEST.operations.length, 58);
  assert.equal(new Set(OPENAPI_MANIFEST.operations.map(({ operationId }) => operationId)).size, 58);
  assert.equal(
    new Set(OPENAPI_MANIFEST.operations.map(({ command }) => JSON.stringify(command))).size,
    58,
  );
  assert.equal(OPENAPI_MANIFEST.server, "https://cookidoo.pl");
  assert.deepEqual(OPENAPI_MANIFEST.source, {
    repository: "https://github.com/aimlesx/cookidoo-openapi",
    commit: "69bb43119b162ad8fea48ddb6a436d2074013972",
    path: "openapi.yaml",
    sha256: "d04829c9140ccba4003e0f0ce39883158e73ac8f9e42ae2c8fc365a28b1fa5aa",
  });

  for (const operation of OPENAPI_MANIFEST.operations) {
    assert.match(operation.path, /^\//u);
    assert.ok(["GET", "POST", "PUT", "PATCH", "DELETE"].includes(operation.method));
    assert.ok(["public", "cookie", "basic", "none"].includes(operation.security));
    assert.ok(operation.command.length >= 2, operation.operationId);
    assert.equal(findOperationByCommand(operation.command)?.operationId, operation.operationId);
  }
});

test("live-observed created-recipe PATCH vendor media remains a narrow typed override", () => {
  const operation = getOperationById("patchCreatedRecipe");
  const response = operation.responses["200"];
  assert.ok(response.content["application/json"]);
  assert.ok(response.content["application/vnd.vorwerk.customer-recipe.full+json"]);
  assert.deepEqual(
    OPENAPI_MANIFEST.compatibilityOverrides.responses.patchCreatedRecipe["200"],
    {
      addMediaType: "application/vnd.vorwerk.customer-recipe.full+json",
      copySchemaFrom: "application/json",
      observedAt: "2026-08-18",
    },
  );
  const result = validateResponse(
    operation,
    200,
    { recipeId: "01ARZ3NDEKTSV4RRFFQ69G5FAV", recipeContent: { name: "offline" } },
    { contentType: "application/vnd.vorwerk.customer-recipe.full+json" },
  );
  assert.equal(result.ok, true);
});

test("manifest parser rejects duplicate identities and malformed risk metadata", () => {
  const duplicateId = structuredClone(OPENAPI_MANIFEST);
  duplicateId.operations[1].operationId = duplicateId.operations[0].operationId;
  assert.throws(() => parseManifest(duplicateId), hasCode("INVALID_OPENAPI_MANIFEST"));

  const duplicateCommand = structuredClone(OPENAPI_MANIFEST);
  duplicateCommand.operations[1].command = duplicateCommand.operations[0].command;
  assert.throws(() => parseManifest(duplicateCommand), hasCode("INVALID_OPENAPI_MANIFEST"));

  const badRisk = structuredClone(OPENAPI_MANIFEST);
  badRisk.operations[0].risk.effect = "harmless";
  assert.throws(() => parseManifest(badRisk), hasCode("INVALID_OPENAPI_MANIFEST"));

  const malformedCompatibilityRoot = structuredClone(OPENAPI_MANIFEST);
  malformedCompatibilityRoot.compatibilityOverrides = "trust me";
  assert.throws(
    () => parseManifest(malformedCompatibilityRoot),
    hasCode("INVALID_OPENAPI_MANIFEST"),
  );

  const malformedSource = structuredClone(OPENAPI_MANIFEST);
  malformedSource.source.commit = "main";
  assert.throws(() => parseManifest(malformedSource), hasCode("INVALID_OPENAPI_MANIFEST"));

  const malformedCompatibilityEntry = structuredClone(OPENAPI_MANIFEST);
  malformedCompatibilityEntry.compatibilityOverrides.responses.patchCreatedRecipe["200"].addMediaType = "text/html";
  assert.throws(
    () => parseManifest(malformedCompatibilityEntry),
    hasCode("INVALID_OPENAPI_MANIFEST"),
  );

  const missingBodyProperties = structuredClone(OPENAPI_MANIFEST);
  const bodyOperation = missingBodyProperties.operations.find((operation) => operation.requestBody !== null);
  const media = Object.values(bodyOperation.requestBody.content)[0];
  delete media.bodyProperties;
  assert.throws(() => parseManifest(missingBodyProperties), hasCode("INVALID_OPENAPI_MANIFEST"));

  const incompleteBodyProperties = structuredClone(OPENAPI_MANIFEST);
  const incompleteOperation = incompleteBodyProperties.operations.find((operation) =>
    operation.requestBody !== null &&
    Object.keys(Object.values(operation.requestBody.content)[0].bodyProperties).length > 1);
  const incompleteMedia = Object.values(incompleteOperation.requestBody.content)[0];
  delete incompleteMedia.bodyProperties[Object.keys(incompleteMedia.bodyProperties)[0]];
  assert.throws(() => parseManifest(incompleteBodyProperties), hasCode("INVALID_OPENAPI_MANIFEST"));

  const extraBodyProperties = structuredClone(OPENAPI_MANIFEST);
  const extraOperation = extraBodyProperties.operations.find((operation) => operation.requestBody !== null);
  Object.values(extraOperation.requestBody.content)[0].bodyProperties.notInSchema = { type: "string" };
  assert.throws(() => parseManifest(extraBodyProperties), hasCode("INVALID_OPENAPI_MANIFEST"));

  const impossibleObservedDate = structuredClone(OPENAPI_MANIFEST);
  impossibleObservedDate.compatibilityOverrides.responses.patchCreatedRecipe["200"].observedAt = "2026-99-99";
  assert.throws(() => parseManifest(impossibleObservedDate), hasCode("INVALID_OPENAPI_MANIFEST"));
});

test("canonical resolution ignores forged risk and rejects forged transport metadata", () => {
  const canonical = getOperationById("deleteCreatedRecipe");
  const forgedRisk = {
    ...canonical,
    risk: { effect: "read", destructive: false, externallyVisible: false, exercised: true },
  };
  assert.equal(canonicalOperation(forgedRisk), canonical);
  assert.equal(classifySafety(forgedRisk).level, "destructive");

  assert.throws(
    () => canonicalOperation({ ...canonical, method: "GET" }),
    hasCode("RAW_OPERATION_REJECTED"),
  );
  assert.throws(
    () => canonicalOperation({ ...canonical, path: "/elsewhere" }),
    hasCode("RAW_OPERATION_REJECTED"),
  );
});

test("body validation resolves component refs, oneOf branches, formats, and closed objects", () => {
  assert.equal(validateRequestBody("createCreatedRecipe", { recipeName: "Offline fixture" }).ok, true);
  assert.equal(validateRequestBody("patchCreatedRecipe", { name: "Updated fixture" }).ok, true);

  const emptyCreate = validateRequestBody("createCreatedRecipe", {});
  assert.equal(emptyCreate.ok, false);
  assert.ok(emptyCreate.issues.some(({ keyword }) => keyword === "oneOf"));

  const impossibleDate = validateRequestBody("addRecipesToDay", {
    recipeIds: ["r123"],
    dayKey: "2026-02-30",
  });
  assert.equal(impossibleDate.ok, false);
  assert.ok(impossibleDate.issues.some(({ path, keyword }) => path === "/dayKey" && keyword === "format"));

  const extraRatingField = validateRequestBody("setUserRecipeRating", { rating: 4, password: "no" });
  assert.equal(extraRatingField.ok, false);
  assert.ok(extraRatingField.issues.some(({ keyword }) => keyword === "additionalProperties"));

  assert.equal(validateRequestBody("getRecipe", undefined).ok, true);
  assert.equal(validateRequestBody("getRecipe", {}).ok, false);
  assert.throws(
    () => assertValidRequestBody("setUserRecipeRating", { rating: 99 }),
    hasCode("INVALID_REQUEST_BODY"),
  );
});

test("parameter validation applies safe defaults and coerces only schema-valid values", () => {
  assert.deepEqual(coerceAndValidateParameters("listCreatedRecipes", { addToCookidoo: "true" }), {
    path: { lang: "pl" },
    query: { addToCookidoo: true },
    header: {},
    cookie: {},
  });

  const invalidRecipe = validateParameters("getRecipe", { recipeId: "not-an-id" });
  assert.equal(invalidRecipe.ok, false);
  assert.ok(invalidRecipe.issues.some(({ path }) => path === "/path/recipeId"));

  const unknown = validateParameters("getRecipe", { recipeId: "r123", surprise: "x" });
  assert.equal(unknown.ok, false);
  assert.ok(unknown.issues.some(({ keyword }) => keyword === "unknownParameter"));

  const missingWithoutDefaults = validateParameters(
    "getRecipe",
    { recipeId: "r123" },
    { applyDefaults: false },
  );
  assert.equal(missingWithoutDefaults.ok, false);
  assert.ok(missingWithoutDefaults.issues.some(({ path }) => path === "/path/lang"));
});

test("shopping POST removals receive destructive semantic overrides", () => {
  assert.deepEqual(
    [...SEMANTIC_DESTRUCTIVE_OPERATIONS].sort(),
    ["removeAdditionalShoppingItems", "removeRecipesFromShoppingList"].sort(),
  );
  for (const operationId of SEMANTIC_DESTRUCTIVE_OPERATIONS) {
    const operation = getOperationById(operationId);
    assert.equal(operation.method, "POST");
    assert.equal(operation.risk.destructive, false);
    const classification = classifySafety(operationId);
    assert.equal(classification.destructive, true);
    assert.equal(classification.level, "destructive");
    assert.ok(classification.semanticOverrides.length > 0);
  }
});

test("exact confirmation is derived from the actual request and is byte-sensitive", () => {
  const id = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
  const parameters = { path: { customerRecipeId: id }, query: {}, header: {}, cookie: {} };
  const target = `created-recipe:${id}:delete`;
  assert.equal(deriveConfirmationTarget("deleteCreatedRecipe", { parameters }), target);

  const missing = evaluateSafety("deleteCreatedRecipe", { parameters });
  assert.equal(missing.allowed, false);
  assert.equal(missing.confirmationTarget, target);
  assert.equal(missing.requiresAuthentication, false);

  const wrongCase = evaluateSafety("deleteCreatedRecipe", {
    parameters,
    confirm: target.toLowerCase(),
  });
  assert.equal(wrongCase.allowed, false);
  assert.throws(
    () => assertSafety("deleteCreatedRecipe", { parameters, confirm: target.toLowerCase() }),
    hasCode("CONFIRMATION_MISMATCH"),
  );

  const exact = assertSafety("deleteCreatedRecipe", { parameters, confirm: target });
  assert.equal(exact.allowed, true);
  assert.equal(exact.execute, true);
  assert.equal(exact.requiresAuthentication, true);

  const conflict = evaluateSafety("deleteCreatedRecipe", {
    parameters,
    target: "created-recipe:someone-else:delete",
    confirm: target,
  });
  assert.equal(conflict.allowed, false);
});

test("advertised-only mutation gates compose with confirmation and dry-run stays auth-free", () => {
  const target = "shared-list:fixture-share:revoke";
  const context = { parameters: { sharedListId: "fixture-share" } };
  const planned = assertSafety("revokeSharedList", { ...context, dryRun: true });
  assert.equal(planned.dryRun, true);
  assert.equal(planned.execute, false);
  assert.equal(planned.requiresAuthentication, false);
  assert.deepEqual(planned.requirements.map(({ code }) => code), ["allow-unverified", "confirmation"]);

  assert.throws(
    () => assertSafety("revokeSharedList", { ...context, confirm: target }),
    hasCode("UNVERIFIED_OPERATION_BLOCKED"),
  );
  assert.throws(
    () => assertSafety("revokeSharedList", { ...context, allowUnverified: true }),
    hasCode("CONFIRMATION_MISMATCH"),
  );
  const allowed = assertSafety("revokeSharedList", {
    ...context,
    allowUnverified: true,
    confirm: target,
  });
  assert.equal(allowed.execute, true);

  assert.throws(
    () => assertSafety("movePlannedRecipe", { body: { opaque: true } }),
    hasCode("UNVERIFIED_OPERATION_BLOCKED"),
  );
  assert.equal(
    assertSafety("movePlannedRecipe", { body: { opaque: true }, allowUnverified: true }).execute,
    true,
  );
});

test("externally visible ratings and device actions cannot execute without target confirmation", () => {
  const ratingContext = { parameters: { recipeId: "r123" }, body: { rating: 5 } };
  const rating = evaluateSafety("setUserRecipeRating", ratingContext);
  assert.equal(rating.classification.level, "external");
  assert.match(rating.confirmationTarget, /^recipe-rating:r123:set:[a-f0-9]{24}$/u);
  assert.equal(rating.allowed, false);

  const deviceContext = {
    body: { deviceId: "offline-device" },
    allowUnverified: true,
  };
  const deviceTarget = deriveConfirmationTarget("linkConnectedDevice", deviceContext);
  const device = evaluateSafety("linkConnectedDevice", { ...deviceContext, confirm: deviceTarget });
  assert.equal(device.classification.level, "device");
  assert.equal(device.allowed, true);

  const noDeviceId = evaluateSafety("linkConnectedDevice", {
    body: { undocumented: true },
    allowUnverified: true,
  });
  assert.match(noDeviceId.confirmationTarget, /^device:unknown:link:[a-f0-9]{24}$/u);
  assert.throws(
    () => assertSafety("linkConnectedDevice", { body: {}, allowUnverified: true }),
    hasCode("CONFIRMATION_MISMATCH"),
  );
});

test("digest confirmations distinguish delimiter collisions and every effect-bearing import field", () => {
  const joined = deriveConfirmationTarget("removeRecipesFromShoppingList", {
    body: { recipeIDs: ["a,b"] },
  });
  const split = deriveConfirmationTarget("removeRecipesFromShoppingList", {
    body: { recipeIDs: ["a", "b"] },
  });
  assert.notEqual(joined, split);

  const base = deriveConfirmationTarget("listCreatedRecipes", {
    parameters: { recipeUrl: "https://example.invalid/r", partnerId: "one", addToCookidoo: true },
  });
  const changed = deriveConfirmationTarget("listCreatedRecipes", {
    parameters: { recipeUrl: "https://example.invalid/r", partnerId: "two", addToCookidoo: true },
  });
  assert.notEqual(base, changed);
});

test("mutation reconciliation never recommends automatic retry", () => {
  assert.equal(reconciliationSuggestion("getRecipe"), null);
  for (const operation of OPENAPI_MANIFEST.operations.filter(({ method }) => method !== "GET")) {
    const guidance = reconciliationSuggestion(operation);
    assert.ok(guidance, operation.operationId);
    assert.equal(guidance.automaticRetry, false, operation.operationId);
    assert.ok(guidance.strategy.length > 0);
    assert.ok(guidance.ambiguity.length > 0);
  }
});
