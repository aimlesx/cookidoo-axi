import { createHash } from "node:crypto";

import { UsageError } from "../errors.js";
import {
  OPENAPI_MANIFEST,
  canonicalOperation,
  type CoercedParameters,
  type ManifestOperation,
  type OpenApiManifest,
  type RiskEffect,
} from "../api/spec.js";

export type SafetyLevel =
  | "read"
  | "private-write"
  | "unverified"
  | "destructive"
  | "external"
  | "device";

export interface SafetyClassification {
  readonly operationId: string;
  readonly command: readonly string[];
  readonly mutation: boolean;
  readonly level: SafetyLevel;
  readonly effect: RiskEffect;
  readonly destructive: boolean;
  readonly externallyVisible: boolean;
  readonly deviceAction: boolean;
  readonly advertisedOnlyMutation: boolean;
  readonly requiresConfirmation: boolean;
  readonly semanticOverrides: readonly string[];
}

export interface ReconciliationGuidance {
  readonly operationId: string;
  readonly automaticRetry: false;
  readonly authoritativeRead: readonly string[] | null;
  readonly strategy: string;
  readonly ambiguity: string;
}

export interface SafetyContext {
  /** Coerced operation parameters, or a flat parameter map. */
  readonly parameters?: CoercedParameters | Readonly<Record<string, unknown>>;
  readonly body?: unknown;
  /** Required only when the policy cannot derive a target from the request. */
  readonly target?: string;
  /** Value supplied by `--confirm`; equality is byte-for-byte and case-sensitive. */
  readonly confirm?: string;
  readonly allowUnverified?: boolean;
  readonly dryRun?: boolean;
}

export interface SafetyRequirement {
  readonly code: "allow-unverified" | "confirmation";
  readonly flag: string;
  readonly satisfied: boolean;
  readonly message: string;
  readonly expectedTarget?: string;
}

export interface SafetyDecision {
  readonly operation: ManifestOperation;
  readonly classification: SafetyClassification;
  readonly dryRun: boolean;
  readonly allowed: boolean;
  readonly execute: boolean;
  /** False for every dry-run, ensuring callers can render the plan before auth. */
  readonly requiresAuthentication: boolean;
  readonly confirmationTarget: string | null;
  readonly requirements: readonly SafetyRequirement[];
  readonly reconciliation: ReconciliationGuidance | null;
}

/**
 * The upstream risk flag calls these private writes, but both operations remove
 * user state. The CLI deliberately applies the stronger classification.
 */
export const SEMANTIC_DESTRUCTIVE_OPERATIONS: ReadonlySet<string> = new Set([
  "removeRecipesFromShoppingList",
  "removeAdditionalShoppingItems",
]);

function isMutation(operation: ManifestOperation): boolean {
  return operation.method !== "GET";
}

export function classifySafety(
  operationValue: string | ManifestOperation,
  manifest: OpenApiManifest = OPENAPI_MANIFEST,
): SafetyClassification {
  const operation = canonicalOperation(operationValue, manifest);
  const mutation = isMutation(operation);
  const semanticOverrides: string[] = [];
  const semanticallyDestructive = SEMANTIC_DESTRUCTIVE_OPERATIONS.has(operation.operationId);
  if (semanticallyDestructive) {
    semanticOverrides.push("shopping removal deletes user state despite upstream destructive=false");
  }
  const destructive = operation.risk.destructive || semanticallyDestructive;
  const deviceAction = operation.risk.effect === "device-link" && mutation;
  const externallyVisible = operation.risk.externallyVisible ||
    operation.risk.effect === "public-share" || operation.risk.effect === "public-rating";
  const advertisedOnlyMutation = operation.status === "advertised-only" && mutation;
  const requiresConfirmation = destructive || externallyVisible || deviceAction;

  let level: SafetyLevel;
  if (deviceAction) level = "device";
  else if (externallyVisible) level = "external";
  else if (destructive) level = "destructive";
  else if (advertisedOnlyMutation) level = "unverified";
  else if (mutation) level = "private-write";
  else level = "read";

  return {
    operationId: operation.operationId,
    command: operation.command,
    mutation,
    level,
    effect: operation.risk.effect,
    destructive,
    externallyVisible,
    deviceAction,
    advertisedOnlyMutation,
    requiresConfirmation,
    semanticOverrides,
  };
}

function flatParameter(context: SafetyContext, name: string): unknown {
  const parameters = context.parameters;
  if (parameters === undefined) return undefined;
  if (Object.hasOwn(parameters, name)) {
    return (parameters as Readonly<Record<string, unknown>>)[name];
  }
  for (const location of ["path", "query", "header", "cookie"] as const) {
    const values = (parameters as Partial<Record<typeof location, unknown>>)[location];
    if (typeof values === "object" && values !== null && !Array.isArray(values) &&
        Object.hasOwn(values, name)) {
      return (values as Readonly<Record<string, unknown>>)[name];
    }
  }
  return undefined;
}

function bodyRecord(context: SafetyContext): Readonly<Record<string, unknown>> | undefined {
  return typeof context.body === "object" && context.body !== null && !Array.isArray(context.body)
    ? context.body as Readonly<Record<string, unknown>> : undefined;
}

function scalar(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function stringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length === 0 ||
      value.some((entry) => typeof entry !== "string" || entry.length === 0)) {
    return undefined;
  }
  return value as string[];
}

function encoded(value: string): string {
  return encodeURIComponent(value);
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, entry]) => [key, canonicalJson(entry)]),
  );
}

function digest(value: unknown): string {
  const serialized = JSON.stringify(canonicalJson(value)) ?? "undefined";
  return createHash("sha256")
    .update(serialized)
    .digest("hex")
    .slice(0, 24);
}

/** Derive the exact confirmation target from the actual request when possible. */
export function deriveConfirmationTarget(
  operationValue: string | ManifestOperation,
  context: SafetyContext = {},
  manifest: OpenApiManifest = OPENAPI_MANIFEST,
): string | undefined {
  const operation = canonicalOperation(operationValue, manifest);
  const body = bodyRecord(context);
  const parameter = (name: string): string | undefined => scalar(flatParameter(context, name));
  const bodyValue = (name: string): string | undefined => scalar(body?.[name]);
  switch (operation.operationId) {
    case "listCreatedRecipes": {
      const recipeUrl = scalar(flatParameter(context, "recipeUrl"));
      const partnerId = scalar(flatParameter(context, "partnerId"));
      const addToCookidoo = flatParameter(context, "addToCookidoo");
      if (recipeUrl === undefined && partnerId === undefined && addToCookidoo === undefined) {
        return undefined;
      }
      return `created-import:${digest({ recipeUrl, partnerId, addToCookidoo })}`;
    }
    case "patchCreatedRecipe":
    {
      const id = parameter("customerRecipeId");
      const status = bodyValue("workStatus");
      const action = status === "PUBLIC" ? "publish" : status === "PRIVATE" ? "unpublish" : "edit";
      return id === undefined ? undefined : `created-recipe:${encoded(id)}:${action}`;
    }
    case "deleteCreatedRecipe": {
      const id = parameter("customerRecipeId");
      return id === undefined ? undefined : `created-recipe:${encoded(id)}:delete`;
    }
    case "removeBookmark": {
      const id = bodyValue("recipeId");
      return id === undefined ? undefined : `bookmark:${encoded(id)}:remove`;
    }
    case "deleteCustomList": {
      const id = parameter("listId");
      return id === undefined ? undefined : `custom-list:${encoded(id)}:delete`;
    }
    case "removeRecipeFromCustomList": {
      const listId = parameter("listId");
      const recipeId = parameter("recipeId");
      return listId === undefined || recipeId === undefined ? undefined :
        `custom-list:${encoded(listId)}:remove-recipe:${encoded(recipeId)}`;
    }
    case "removeManagedList": {
      const id = parameter("listId");
      return id === undefined ? undefined : `managed-list:${encoded(id)}:remove`;
    }
    case "shareCustomList": {
      const id = bodyValue("customListId");
      return id === undefined ? undefined : `custom-list:${encoded(id)}:share`;
    }
    case "revokeSharedList": {
      const id = parameter("sharedListId");
      return id === undefined ? undefined : `shared-list:${encoded(id)}:revoke`;
    }
    case "removePlanningDay": {
      const day = parameter("dayKey");
      return day === undefined ? undefined : `planning-day:${encoded(day)}:clear`;
    }
    case "removeRecipeFromDay": {
      const day = parameter("dayKey");
      const recipe = parameter("recipeId");
      return day === undefined || recipe === undefined ? undefined :
        `planning-day:${encoded(day)}:remove-recipe:${encoded(recipe)}`;
    }
    case "clearShoppingList":
      return "shopping-list:clear-all";
    case "removeRecipesFromShoppingList": {
      const ids = stringArray(body?.recipeIDs);
      return ids === undefined ? undefined : `shopping-recipes:remove:${digest(ids)}`;
    }
    case "removeAdditionalShoppingItems": {
      const ids = stringArray(body?.additionalItemIDs);
      return ids === undefined ? undefined : `shopping-items:remove:${digest(ids)}`;
    }
    case "deleteRecipeNote": {
      const id = parameter("recipeId");
      return id === undefined ? undefined : `recipe-note:${encoded(id)}:delete`;
    }
    case "setUserRecipeRating": {
      const id = parameter("recipeId");
      const rating = body?.rating;
      return id === undefined || rating === undefined
        ? undefined : `recipe-rating:${encoded(id)}:set:${digest(rating)}`;
    }
    case "linkConnectedDevice": {
      const id = bodyValue("deviceId") ?? bodyValue("id") ?? "unknown";
      return context.body === undefined ? undefined : `device:${encoded(id)}:link:${digest(context.body)}`;
    }
    case "unlinkConnectedDevice": {
      const id = parameter("deviceId");
      return id === undefined ? undefined : `device:${encoded(id)}:unlink`;
    }
    default:
      return undefined;
  }
}

function reconciliationForOperation(operation: ManifestOperation): ReconciliationGuidance | null {
  if (!isMutation(operation)) return null;
  const base = {
    operationId: operation.operationId,
    automaticRetry: false as const,
  };
  if ([
    "createCreatedRecipe",
    "patchCreatedRecipe",
    "deleteCreatedRecipe",
  ].includes(operation.operationId)) {
    return {
      ...base,
      authoritativeRead: ["created", "get"],
      strategy: "Read the returned recipe ID, or list created recipes and match the exact ID.",
      ambiguity: "Recipe names are not unique; never infer identity or cleanup ownership from a title.",
    };
  }
  if ([
    "createCustomList",
    "updateCustomList",
    "deleteCustomList",
    "removeRecipeFromCustomList",
    "moveRecipe",
  ].includes(operation.operationId)) {
    return {
      ...base,
      authoritativeRead: ["organize", "custom-list", "get"],
      strategy: "Re-read the exact list and compare its chapters, recipe IDs, title, and ordering.",
      ambiguity: "Preserve unrelated concurrent edits; stop if the unknown detail shape is insufficient.",
    };
  }
  if (["saveManagedList", "removeManagedList"].includes(operation.operationId)) {
    return {
      ...base,
      authoritativeRead: ["organize", "managed-list", "list"],
      strategy: "List saved collections and compare the exact returned managed-list ID.",
      ambiguity: "Collection titles are not authoritative resource identities.",
    };
  }
  if (["shareCustomList", "revokeSharedList"].includes(operation.operationId)) {
    return {
      ...base,
      authoritativeRead: ["organize", "shared-list", "get"],
      strategy: "Read the exact shared-list ID before considering the externally visible state reconciled.",
      ambiguity: "If sharing did not return an ID, stop; do not repeat the mutation to discover one.",
    };
  }
  if (["addRecipesToDay", "removePlanningDay", "removeRecipeFromDay", "movePlannedRecipe"]
    .includes(operation.operationId)) {
    return {
      ...base,
      authoritativeRead: ["planning", "week"],
      strategy: "Read the affected week and compare the day key and recipe ID together.",
      ambiguity: "A concurrent move makes a simple recipe-presence check insufficient.",
    };
  }
  if (operation.tag === "Shopping") {
    return {
      ...base,
      authoritativeRead: ["shopping", "show"],
      strategy: "Read the shopping list and inspect the exact recipe, ingredient, or additional-item ID.",
      ambiguity: "Adds may duplicate entries and ownership state does not prove request identity.",
    };
  }
  if (["createRecipeNote", "updateRecipeNote", "deleteRecipeNote"].includes(operation.operationId)) {
    return {
      ...base,
      authoritativeRead: ["note", "get"],
      strategy: "Read the note for the exact recipe ID and compare its full text.",
      ambiguity: "The note GET response is untyped; stop if it cannot establish the resulting state.",
    };
  }
  if (["addBookmark", "removeBookmark"].includes(operation.operationId)) {
    return {
      ...base,
      authoritativeRead: null,
      strategy: "Stop and report an ambiguous outcome.",
      ambiguity: "The manifest has no authoritative bookmark-status read, so retry cannot be reconciled.",
    };
  }
  if (operation.operationId === "setUserRecipeRating") {
    return {
      ...base,
      authoritativeRead: null,
      strategy: "Stop and report an ambiguous outcome.",
      ambiguity: "Aggregated ratings do not establish the current user's rating.",
    };
  }
  if (operation.operationId === "updateCommunityProfile") {
    return {
      ...base,
      authoritativeRead: null,
      strategy: "Stop and report an ambiguous outcome.",
      ambiguity: "The modeled profile read does not project preferences or accessories authoritatively.",
    };
  }
  if (["linkConnectedDevice", "unlinkConnectedDevice"].includes(operation.operationId)) {
    return {
      ...base,
      authoritativeRead: null,
      strategy: "Stop and report an ambiguous outcome; never repeat a device action automatically.",
      ambiguity: "Device versions are not an authoritative linked-device state read.",
    };
  }
  return {
    ...base,
    authoritativeRead: null,
    strategy: "Read the smallest authoritative parent resource; otherwise stop and report ambiguity.",
    ambiguity: "No operation-specific authoritative reconciliation read is modeled.",
  };
}

export function reconciliationSuggestion(
  operationValue: string | ManifestOperation,
  manifest: OpenApiManifest = OPENAPI_MANIFEST,
): ReconciliationGuidance | null {
  return reconciliationForOperation(canonicalOperation(operationValue, manifest));
}

function validExplicitTarget(target: string | undefined): target is string {
  return target !== undefined && target.length > 0 && target === target.trim() && target.length <= 512;
}

/**
 * Evaluate every gate without authenticating or mutating. In dry-run mode this
 * always returns a plan, including unsatisfied requirements, instead of
 * throwing for missing confirmation.
 */
export function evaluateSafety(
  operationValue: string | ManifestOperation,
  context: SafetyContext = {},
  manifest: OpenApiManifest = OPENAPI_MANIFEST,
): SafetyDecision {
  const operation = canonicalOperation(operationValue, manifest);
  let classification = classifySafety(operation, manifest);
  const importLikeCreatedRead = operation.operationId === "listCreatedRecipes" && [
    "recipeUrl", "partnerId", "addToCookidoo",
  ].some((name) => flatParameter(context, name) !== undefined);
  if (importLikeCreatedRead) {
    classification = {
      ...classification,
      mutation: true,
      level: "unverified",
      effect: "private-write",
      advertisedOnlyMutation: true,
      requiresConfirmation: true,
      semanticOverrides: [
        ...classification.semanticOverrides,
        "created-recipe GET query has unverified import-like side effects",
      ],
    };
  }
  const patchBody = bodyRecord(context);
  if (operation.operationId === "patchCreatedRecipe" &&
      patchBody !== undefined && !Object.hasOwn(patchBody, "workStatus")) {
    classification = {
      ...classification,
      level: "private-write",
      externallyVisible: false,
      requiresConfirmation: false,
      semanticOverrides: [
        ...classification.semanticOverrides,
        "created-recipe content edit does not change publication state",
      ],
    };
  }
  const dryRun = context.dryRun === true;
  const derivedTarget = deriveConfirmationTarget(operation, context, manifest);
  const explicitTargetValid = validExplicitTarget(context.target);
  const explicitTarget = explicitTargetValid ? context.target : undefined;
  const targetConflict = derivedTarget !== undefined && explicitTarget !== undefined &&
    derivedTarget !== explicitTarget;
  const target = targetConflict ? derivedTarget : derivedTarget ?? explicitTarget;
  const requirements: SafetyRequirement[] = [];

  if (classification.advertisedOnlyMutation) {
    requirements.push({
      code: "allow-unverified",
      flag: "--allow-unverified",
      satisfied: context.allowUnverified === true,
      message: context.allowUnverified === true
        ? "The caller explicitly allowed this advertised-only mutation."
        : "Advertised-only mutations are blocked unless explicitly allowed.",
    });
  }
  if (classification.requiresConfirmation) {
    let message: string;
    let satisfied = false;
    if (targetConflict) {
      message = `The explicit target does not match the request target ${derivedTarget}.`;
    } else if (target === undefined) {
      message = "An exact confirmation target could not be derived; supply a non-empty --target first.";
    } else if (context.confirm === target) {
      message = `Confirmation exactly matches ${target}.`;
      satisfied = true;
    } else if (context.confirm === undefined) {
      message = `Confirmation is required: --confirm ${target}`;
    } else {
      message = `Confirmation does not exactly match ${target}.`;
    }
    requirements.push({
      code: "confirmation",
      flag: target === undefined ? "--confirm <exact-target>" : `--confirm ${target}`,
      satisfied,
      message,
      ...(target === undefined ? {} : { expectedTarget: target }),
    });
  }

  const allowed = requirements.every((requirement) => requirement.satisfied);
  const execute = !dryRun && allowed;
  return {
    operation,
    classification,
    dryRun,
    allowed,
    execute,
    requiresAuthentication: execute && operation.security !== "public" &&
      operation.security !== "none",
    confirmationTarget: target ?? null,
    requirements,
    reconciliation: importLikeCreatedRead ? {
      operationId: operation.operationId,
      automaticRetry: false,
      authoritativeRead: ["created", "list"],
      strategy: "List created recipes once and identify only an exact newly returned recipe ID.",
      ambiguity: "Never repeat this import-like request or infer ownership from a recipe title.",
    } : reconciliationForOperation(operation),
  };
}

/** Enforce safety for execution; dry-runs are returned before any auth is needed. */
export function assertSafety(
  operationValue: string | ManifestOperation,
  context: SafetyContext = {},
  manifest: OpenApiManifest = OPENAPI_MANIFEST,
): SafetyDecision {
  const decision = evaluateSafety(operationValue, context, manifest);
  if (decision.dryRun) return decision;
  const unverified = decision.requirements.find((requirement) =>
    requirement.code === "allow-unverified" && !requirement.satisfied);
  if (unverified !== undefined) {
    throw new UsageError({
      code: "UNVERIFIED_OPERATION_BLOCKED",
      message: `${decision.operation.operationId} is an advertised-only mutation and is blocked.`,
      suggestion: `Inspect the dry-run, then add ${unverified.flag} only if the risk is acceptable.`,
      details: {
        operationId: decision.operation.operationId,
        command: decision.operation.command,
      },
    });
  }
  const confirmation = decision.requirements.find((requirement) =>
    requirement.code === "confirmation" && !requirement.satisfied);
  if (confirmation !== undefined) {
    const missingTarget = decision.confirmationTarget === null;
    throw new UsageError({
      code: missingTarget ? "CONFIRMATION_TARGET_REQUIRED" : "CONFIRMATION_MISMATCH",
      message: confirmation.message,
      suggestion: missingTarget
        ? "Supply the exact request target, inspect --dry-run, then confirm that same value."
        : `Repeat with the exact value: ${confirmation.flag}`,
      details: {
        operationId: decision.operation.operationId,
        expectedTarget: decision.confirmationTarget,
      },
    });
  }
  return decision;
}
