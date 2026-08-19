import type { JsonArray, JsonValue } from "@toon-format/toon";

import type { FieldSelectionInput } from "./fields.js";
import { selectFields } from "./fields.js";
import { assertValidUnicode, replaceInvalidUnicode, toJsonValue } from "./json-value.js";
import type { SecretRedactionOptions } from "./redact.js";
import {
  DEFAULT_REDACTION_REPLACEMENT,
  containsCredentialLikeText,
  redactSecrets,
} from "./redact.js";
import { truncateJsonStrings } from "./truncate.js";
import { truncateJsonStructures } from "./truncate-objects.js";
import type {
  CollectionEnvelope,
  CompletenessMetadata,
  DetailEnvelope,
  FieldSelectionMetadata,
  NextCommand,
  NextCommandInput,
  RedactionMetadata,
  TruncationMetadata,
  TruncationMode,
} from "./types.js";
import { OutputBoundaryError } from "./types.js";

export const DEFAULT_COLLECTION_LIMIT = 20;
export const DEFAULT_STRING_PREVIEW_CHARACTERS = 500;
export const DEFAULT_MAX_NEXT_COMMANDS = 3;

export interface CommonNormalizationOptions {
  /** Current reproducible command, used to construct the --full escape hatch. */
  readonly command: string;
  readonly full?: boolean;
  readonly fields?: FieldSelectionInput;
  readonly maxStringCharacters?: number;
  readonly context?: unknown;
  readonly next?: readonly NextCommandInput[];
  readonly maxNextCommands?: number;
  readonly redaction?: SecretRedactionOptions;
  /** Disable a rerun-style --full escape hatch for mutations or non-reproducible input. */
  readonly allowFullCommand?: boolean;
  /** Bound every response array, including arrays nested inside detail objects. */
  readonly maxItems?: number;
  /** Bound every object/map. Defaults to the effective maxItems value. */
  readonly maxObjectKeys?: number;
}

export interface CollectionNormalizationOptions extends CommonNormalizationOptions {
  /** Upstream total, null/omitted when the service did not establish it. */
  readonly total?: number | null;
  /** Upstream pagination signal, null/omitted when unknown. */
  readonly hasMore?: boolean | null;
}

export interface DetailNormalizationOptions extends CommonNormalizationOptions {
  /** Contract certainty for the source value before local truncation. */
  readonly sourceCompleteness?: "complete" | "partial" | "unknown";
}

interface PreparedData {
  readonly value: JsonValue;
  readonly selection: FieldSelectionMetadata;
  readonly redactedPaths: readonly string[];
}

export function normalizeCollection(
  items: readonly unknown[],
  options: CollectionNormalizationOptions,
): CollectionEnvelope {
  const command = normalizeCommandText(options.command);
  const full = options.full === true;
  const itemLimit = validatePositiveInteger(
    options.maxItems ?? DEFAULT_COLLECTION_LIMIT,
    "Collection item limit",
  );
  const contentLimit = validatePositiveInteger(
    options.maxStringCharacters ?? DEFAULT_STRING_PREVIEW_CHARACTERS,
    "String preview limit",
  );
  const objectLimit = validatePositiveInteger(
    options.maxObjectKeys ?? itemLimit,
    "Object key limit",
  );

  const prepared = prepareData(items, options.fields, options.redaction, "$.data");
  if (!Array.isArray(prepared.value)) {
    throw new OutputBoundaryError(
      "OUTPUT_INVALID_VALUE",
      "Collection normalization requires an array",
    );
  }

  const availableItems = prepared.value.length;
  const total = normalizeTotal(options.total);
  if (total !== null && total < availableItems) {
    throw new OutputBoundaryError(
      "OUTPUT_INVALID_VALUE",
      `Collection total (${total}) cannot be smaller than returned items (${availableItems})`,
    );
  }
  const upstreamHasMore = normalizeOptionalBoolean(options.hasMore, "hasMore");
  if (total === 0 && upstreamHasMore === true) {
    throw new OutputBoundaryError(
      "OUTPUT_INVALID_VALUE",
      "A zero-total collection cannot report hasMore=true",
    );
  }

  const locallyBounded = full
    ? [...prepared.value]
    : prepared.value.slice(0, itemLimit);
  const rootOmittedItems = availableItems - locallyBounded.length;
  const boundedData = full
    ? { value: locallyBounded as JsonValue, objects: [], collections: [] }
    : truncateJsonStructures(locallyBounded, itemLimit, objectLimit, "$.data", false);
  const truncatedContent = full
    ? { value: boundedData.value, fields: [] }
    : truncateJsonStrings(
        boundedData.value,
        contentLimit,
        "$.data",
        [options.redaction?.replacement ?? DEFAULT_REDACTION_REPLACEMENT],
      );
  if (!Array.isArray(truncatedContent.value)) {
    throw new OutputBoundaryError(
      "OUTPUT_INVALID_VALUE",
      "Collection truncation unexpectedly changed the root data type",
    );
  }

  const context = prepareContext(options.context, options.redaction);
  const boundedContext = full
    ? { value: context.value, objects: [], collections: [] }
    : truncateJsonStructures(context.value, itemLimit, objectLimit, "$.context", true);
  const truncatedContext = full
    ? { value: boundedContext.value, fields: [] }
    : truncateJsonStrings(
        boundedContext.value,
        contentLimit,
        "$.context",
        [options.redaction?.replacement ?? DEFAULT_REDACTION_REPLACEMENT],
      );
  const collections = [...boundedData.collections, ...boundedContext.collections];
  const objects = [...boundedData.objects, ...boundedContext.objects];
  const fields = [...truncatedContent.fields, ...truncatedContext.fields];
  const nestedOmittedItems = collections.reduce(
    (total, item) => total + item.totalItems - item.shownItems,
    0,
  );
  const omittedItems = rootOmittedItems + nestedOmittedItems;
  const omittedProperties = objects.reduce(
    (total, item) => total + item.totalKeys - item.shownKeys,
    0,
  );
  const mode = truncationMode(omittedItems, fields.length, omittedProperties);
  const applied = mode !== "none";
  const fullCommand = applied && options.allowFullCommand !== false && !containsCredentialLikeText(command)
    ? ensureFullCommand(command) : null;
  const truncation: TruncationMetadata = {
    applied,
    mode,
    itemLimit: full ? null : itemLimit,
    availableItems,
    omittedItems,
    objectLimit: full ? null : objectLimit,
    omittedProperties,
    contentLimit: full ? null : contentLimit,
    fields,
    collections,
    objects,
    fullCommand,
  };

  const completeness = collectionCompleteness(
    truncatedContent.value.length,
    total,
    upstreamHasMore,
    rootOmittedItems,
    nestedOmittedItems > 0 || omittedProperties > 0 || fields.length > 0,
  );
  const next = normalizeNextCommands(options.next ?? [], {
    ...(fullCommand === null ? {} : { escapeHatch: fullCommand }),
    maxCommands: options.maxNextCommands ?? DEFAULT_MAX_NEXT_COMMANDS,
  });
  return {
    data: truncatedContent.value as JsonArray,
    kind: "collection",
    completeness,
    truncation,
    selection: prepared.selection,
    redaction: redactionMetadata(
      prepared.redactedPaths.length + context.redactedPaths.length,
    ),
    context: truncatedContext.value,
    next,
  };
}

export function normalizeDetail(
  value: unknown,
  options: DetailNormalizationOptions,
): DetailEnvelope {
  const command = normalizeCommandText(options.command);
  const full = options.full === true;
  const contentLimit = validatePositiveInteger(
    options.maxStringCharacters ?? DEFAULT_STRING_PREVIEW_CHARACTERS,
    "String preview limit",
  );
  const itemLimit = validatePositiveInteger(
    options.maxItems ?? DEFAULT_COLLECTION_LIMIT,
    "Detail array item limit",
  );
  const objectLimit = validatePositiveInteger(
    options.maxObjectKeys ?? itemLimit,
    "Object key limit",
  );
  const prepared = prepareData(value, options.fields, options.redaction, "$.data");
  const boundedData = full
    ? { value: prepared.value, objects: [], collections: [] }
    : truncateJsonStructures(prepared.value, itemLimit, objectLimit, "$.data", true);
  const truncatedContent = full
    ? { value: boundedData.value, fields: [] }
    : truncateJsonStrings(
        boundedData.value,
        contentLimit,
        "$.data",
        [options.redaction?.replacement ?? DEFAULT_REDACTION_REPLACEMENT],
      );
  const context = prepareContext(options.context, options.redaction);
  const boundedContext = full
    ? { value: context.value, objects: [], collections: [] }
    : truncateJsonStructures(context.value, itemLimit, objectLimit, "$.context", true);
  const truncatedContext = full
    ? { value: boundedContext.value, fields: [] }
    : truncateJsonStrings(
        boundedContext.value,
        contentLimit,
        "$.context",
        [options.redaction?.replacement ?? DEFAULT_REDACTION_REPLACEMENT],
      );
  const collections = [...boundedData.collections, ...boundedContext.collections];
  const objects = [...boundedData.objects, ...boundedContext.objects];
  const fields = [...truncatedContent.fields, ...truncatedContext.fields];
  const omittedItems = collections.reduce(
    (total, item) => total + item.totalItems - item.shownItems,
    0,
  );
  const omittedProperties = objects.reduce(
    (total, item) => total + item.totalKeys - item.shownKeys,
    0,
  );
  const applied = fields.length > 0 || omittedItems > 0 || omittedProperties > 0;
  const fullCommand = applied && options.allowFullCommand !== false && !containsCredentialLikeText(command)
    ? ensureFullCommand(command) : null;
  const truncation: TruncationMetadata = {
    applied,
    mode: truncationMode(omittedItems, fields.length, omittedProperties),
    itemLimit: full ? null : itemLimit,
    availableItems: null,
    omittedItems,
    objectLimit: full ? null : objectLimit,
    omittedProperties,
    contentLimit: full ? null : contentLimit,
    fields,
    collections,
    objects,
    fullCommand,
  };
  const next = normalizeNextCommands(options.next ?? [], {
    ...(fullCommand === null ? {} : { escapeHatch: fullCommand }),
    maxCommands: options.maxNextCommands ?? DEFAULT_MAX_NEXT_COMMANDS,
  });
  const sourceState = options.sourceCompleteness ?? "complete";
  const completenessState = applied ? "partial" : sourceState;

  return {
    data: truncatedContent.value,
    kind: "detail",
    completeness: {
      state: completenessState,
      shown: 1,
      total: completenessState === "complete" ? 1 : null,
      hasMore: completenessState === "complete" ? false : null,
    },
    truncation,
    selection: prepared.selection,
    redaction: redactionMetadata(
      prepared.redactedPaths.length + context.redactedPaths.length,
    ),
    context: truncatedContext.value,
    next,
  };
}

export interface NormalizeNextCommandOptions {
  readonly escapeHatch?: string;
  readonly maxCommands?: number;
}

export function normalizeNextCommands(
  inputs: readonly NextCommandInput[],
  options: NormalizeNextCommandOptions = {},
): readonly NextCommand[] {
  const maxCommands = validatePositiveInteger(
    options.maxCommands ?? DEFAULT_MAX_NEXT_COMMANDS,
    "Next-command limit",
  );
  const output: NextCommand[] = [];
  const seen = new Set<string>();

  if (options.escapeHatch !== undefined) {
    addNextCommand(
      output,
      seen,
      {
        command: options.escapeHatch,
        description: "Show the complete result without local truncation.",
      },
      maxCommands,
    );
  }

  for (const input of inputs) {
    const next =
      typeof input === "string"
        ? { command: input, description: "Suggested next action." }
        : input;
    addNextCommand(output, seen, next, maxCommands);
  }

  return output;
}

export function ensureFullCommand(command: string): string {
  const normalized = normalizeCommandText(command);
  if (containsCredentialLikeText(normalized)) {
    throw new OutputBoundaryError(
      "OUTPUT_INVALID_OPTION",
      "A full-result command cannot contain credential-like data",
    );
  }
  // Callers only request an escape hatch when the parsed invocation did not
  // contain --full. Do not inspect rendered shell text here: a quoted runtime
  // value may legitimately contain the words "--full".
  return `${normalized} --full`;
}

function prepareData(
  value: unknown,
  fields: FieldSelectionInput | undefined,
  redactionOptions: SecretRedactionOptions | undefined,
  rootPath: string,
): PreparedData {
  const jsonValue = toJsonValue(value, rootPath);
  const redacted = redactSecrets(jsonValue, redactionOptions, rootPath);
  if (fields === undefined) {
    return {
      value: redacted.value,
      selection: { applied: false, requested: [], missing: [] },
      redactedPaths: redacted.paths,
    };
  }

  const selected = selectFields(redacted.value, fields);
  return {
    value: selected.value,
    selection: {
      applied: true,
      requested: selected.requested,
      missing: selected.missing,
    },
    redactedPaths: redacted.paths,
  };
}

function prepareContext(
  value: unknown,
  redactionOptions: SecretRedactionOptions | undefined,
): { readonly value: JsonValue; readonly redactedPaths: readonly string[] } {
  if (value === undefined) {
    return { value: null, redactedPaths: [] };
  }
  const jsonValue = toJsonValue(value, "$.context");
  const redacted = redactSecrets(jsonValue, redactionOptions, "$.context");
  return { value: redacted.value, redactedPaths: redacted.paths };
}

function collectionCompleteness(
  shown: number,
  total: number | null,
  upstreamHasMore: boolean | null,
  omittedItems: number,
  locallyIncomplete: boolean,
): CompletenessMetadata {
  if (total === 0) {
    return { state: "empty", shown: 0, total: 0, hasMore: false };
  }

  if (total !== null) {
    const hasMore = omittedItems > 0
      ? true
      : upstreamHasMore;
    const sourceIncomplete = total > shown || upstreamHasMore === true;
    return {
      state: sourceIncomplete || locallyIncomplete ? "partial" : "complete",
      shown,
      total,
      hasMore,
    };
  }

  if (omittedItems > 0 || upstreamHasMore === true) {
    return { state: "partial", shown, total: null, hasMore: true };
  }

  if (locallyIncomplete) {
    return { state: "partial", shown, total: null, hasMore: upstreamHasMore };
  }

  return {
    state: "unknown",
    shown,
    total: null,
    hasMore: upstreamHasMore,
  };
}

function normalizeTotal(value: number | null | undefined): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new OutputBoundaryError(
      "OUTPUT_INVALID_VALUE",
      "Collection total must be a non-negative safe integer or null",
    );
  }
  return value;
}

function normalizeOptionalBoolean(
  value: boolean | null | undefined,
  label: string,
): boolean | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "boolean") {
    throw new OutputBoundaryError(
      "OUTPUT_INVALID_VALUE",
      `${label} must be a boolean or null`,
    );
  }
  return value;
}

function validatePositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new OutputBoundaryError(
      "OUTPUT_INVALID_OPTION",
      `${label} must be a positive safe integer`,
    );
  }
  return value;
}

function truncationMode(
  omittedItems: number,
  truncatedFieldCount: number,
  omittedProperties: number,
): TruncationMode {
  if (omittedProperties > 0 && (omittedItems > 0 || truncatedFieldCount > 0)) {
    return "mixed";
  }
  if (omittedProperties > 0) {
    return "object";
  }
  if (omittedItems > 0 && truncatedFieldCount > 0) {
    return "collection-and-content";
  }
  if (omittedItems > 0) {
    return "collection";
  }
  if (truncatedFieldCount > 0) {
    return "content";
  }
  return "none";
}

function redactionMetadata(count: number): RedactionMetadata {
  return { applied: count > 0, count };
}

function addNextCommand(
  output: NextCommand[],
  seen: Set<string>,
  input: NextCommand,
  maxCommands: number,
): void {
  if (output.length >= maxCommands) {
    return;
  }

  const command = normalizeCommandText(input.command);
  // Rendered shell text is an unsafe place to perform regex substitution:
  // changing bytes inside a quoted argument can alter shell tokenization. All
  // first-party commands are built from typed tokens; if a defensive scan still
  // finds credential-like content, omit the suggestion rather than rewrite it.
  if (containsCredentialLikeText(command)) {
    return;
  }
  if (seen.has(command)) {
    return;
  }

  const rawDescription = normalizeSingleLineText(
    input.description,
    "Next-command description",
  );
  const description = containsCredentialLikeText(rawDescription)
    ? DEFAULT_REDACTION_REPLACEMENT
    : redactCommandSecrets(rawDescription);
  seen.add(command);
  output.push({ command, description });
}

function normalizeCommandText(command: string): string {
  return normalizeSingleLineText(command, "Command suggestion");
}

function normalizeSingleLineText(value: string, label: string): string {
  if (typeof value !== "string") {
    throw new OutputBoundaryError(
      "OUTPUT_INVALID_OPTION",
      `${label} must be a string`,
    );
  }
  assertValidUnicode(value, label);
  if (/\p{Cc}/u.test(value)) {
    throw new OutputBoundaryError(
      "OUTPUT_INVALID_OPTION",
      `${label} cannot contain control characters or newlines`,
    );
  }
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new OutputBoundaryError(
      "OUTPUT_INVALID_OPTION",
      `${label} cannot be empty`,
    );
  }
  return normalized;
}

function redactCommandSecrets(command: string): string {
  const flagPattern =
    /(--(?:access-token|api-key|authorization|client-secret|cookie|credential|csrf-token|id-token|password|refresh-token|secret|session|token)(?:=|\s+))(?:"[^"]*"|'[^']*'|\S+)/giu;
  const redactedFlags = command.replace(flagPattern, "$1[REDACTED]");
  const assignmentPattern =
    /\b((?:access[-_]?token|api[-_]?key|authorization|client[-_]?secret|cookie|credential|csrf[-_]?token|id[-_]?token|password|passwd|refresh[-_]?token|secret|session|token)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;'"]+)/giu;
  const redactedAssignments = redactedFlags.replace(assignmentPattern, "$1[REDACTED]");
  return replaceInvalidUnicode(
    redactedAssignments.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, "Bearer [REDACTED]"),
  );
}
