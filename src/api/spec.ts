import { readFile } from "node:fs/promises";

import { Ajv2020 } from "ajv/dist/2020.js";
import type { ErrorObject, ValidateFunction } from "ajv";

import bundledManifestDocument from "../generated/openapi-manifest.json" with { type: "json" };
import { OperationalError, UsageError } from "../errors.js";

export type JsonSchema = boolean | Readonly<Record<string, unknown>>;
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export type ParameterLocation = "path" | "query" | "header" | "cookie";
export type OperationSecurity = "public" | "cookie" | "basic" | "none";
export type OperationStatus =
  | "observed"
  | "corroborated"
  | "advertised-only"
  | "vendor-spec"
  | "unknown";
export type ResponseShape = "typed" | "partial" | "unknown";
export type RiskEffect =
  | "read"
  | "private-write"
  | "delete"
  | "public-share"
  | "public-rating"
  | "device-link"
  | "unknown";

export interface ManifestParameter {
  readonly name: string;
  readonly in: ParameterLocation;
  readonly required: boolean;
  readonly description?: string;
  readonly schema: JsonSchema;
}

export interface ManifestRequestMedia {
  readonly schema: JsonSchema;
  readonly bodyProperties: Readonly<Record<string, JsonSchema>>;
  readonly example?: unknown;
}

export interface ManifestRequestBody {
  readonly required: boolean;
  readonly content: Readonly<Record<string, ManifestRequestMedia>>;
}

export interface OperationRisk {
  readonly effect: RiskEffect;
  readonly destructive: boolean;
  readonly externallyVisible: boolean;
  readonly exercised: boolean;
}

export interface ManifestOperation {
  readonly operationId: string;
  readonly command: readonly string[];
  readonly tag: string;
  readonly method: HttpMethod;
  readonly path: string;
  readonly summary: string;
  readonly description?: string;
  readonly parameters: readonly ManifestParameter[];
  readonly requestBody: ManifestRequestBody | null;
  readonly responses: Readonly<Record<string, unknown>>;
  readonly security: OperationSecurity;
  readonly status: OperationStatus;
  readonly responseShape: ResponseShape;
  readonly risk: OperationRisk;
}

export interface OpenApiManifest {
  readonly generatedFrom: string;
  readonly source: {
    readonly repository: string;
    readonly commit: string;
    readonly path: string;
    readonly sha256: string;
  };
  readonly openapi: string;
  readonly apiVersion: string;
  readonly server: string;
  readonly authentication: Readonly<Record<string, unknown>>;
  readonly protocol: Readonly<Record<string, unknown>>;
  readonly compatibilityOverrides: {
    readonly responses: Readonly<Record<string, Readonly<Record<string, {
      readonly addMediaType: string;
      readonly copySchemaFrom: string;
      readonly observedAt: string;
    }>>>>;
  };
  readonly components: {
    readonly schemas: Readonly<Record<string, JsonSchema>>;
    readonly responses: Readonly<Record<string, unknown>>;
    readonly securitySchemes: Readonly<Record<string, unknown>>;
  };
  readonly operations: readonly ManifestOperation[];
}

export interface ValidationIssue {
  readonly path: string;
  readonly keyword: string;
  readonly message: string;
  readonly params?: Readonly<Record<string, unknown>>;
}

export type RequestBodyValidationResult =
  | {
      readonly ok: true;
      readonly operationId: string;
      readonly mediaType: string | null;
      readonly value: unknown;
    }
  | {
      readonly ok: false;
      readonly operationId: string;
      readonly mediaType: string | null;
      readonly issues: readonly ValidationIssue[];
    };

export interface RequestBodyValidationOptions {
  readonly mediaType?: string;
}

export interface ResponseValidationOptions {
  readonly contentType?: string | null;
  readonly empty?: boolean;
}

export type ResponseValidationResult =
  | { readonly ok: true; readonly operationId: string; readonly status: number; readonly value: unknown }
  | { readonly ok: false; readonly operationId: string; readonly status: number; readonly issues: readonly ValidationIssue[] };

export type FlatParameterInput = Readonly<Record<string, unknown>>;

export interface CoercedParameters {
  readonly path: Readonly<Record<string, unknown>>;
  readonly query: Readonly<Record<string, unknown>>;
  readonly header: Readonly<Record<string, unknown>>;
  readonly cookie: Readonly<Record<string, unknown>>;
}

export type ParameterValidationResult =
  | { readonly ok: true; readonly value: CoercedParameters }
  | { readonly ok: false; readonly issues: readonly ValidationIssue[] };

export interface ParameterValidationOptions {
  /** Apply defaults such as `lang=pl`, `page=0`, and the AJAX marker. */
  readonly applyDefaults?: boolean;
  /** Reject input that is not declared by the selected operation. */
  readonly rejectUnknown?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonSchema(value: unknown): value is JsonSchema {
  return typeof value === "boolean" || isRecord(value);
}

function resolveManifestRef(root: Readonly<Record<string, unknown>>, ref: string): unknown {
  if (!ref.startsWith("#/")) return undefined;
  let current: unknown = root;
  for (const encoded of ref.slice(2).split("/")) {
    const key = encoded.replaceAll("~1", "/").replaceAll("~0", "~");
    if (["__proto__", "prototype", "constructor"].includes(key)
        || !isRecord(current) || !Object.hasOwn(current, key)) return undefined;
    current = current[key];
  }
  return current;
}

function collectManifestBodyProperties(
  root: Readonly<Record<string, unknown>>,
  schema: JsonSchema,
  seen: ReadonlySet<string> = new Set(),
): Readonly<Record<string, JsonSchema>> | undefined {
  if (typeof schema === "boolean") return {};
  if (typeof schema.$ref === "string") {
    if (seen.has(schema.$ref)) return {};
    const target = resolveManifestRef(root, schema.$ref);
    if (!isJsonSchema(target)) return undefined;
    return collectManifestBodyProperties(root, target, new Set([...seen, schema.$ref]));
  }
  const properties: Record<string, JsonSchema> = {};
  if (schema.properties !== undefined) {
    if (!isRecord(schema.properties)
        || Object.entries(schema.properties).some(([name, property]) =>
          ["__proto__", "prototype", "constructor"].includes(name) || !isJsonSchema(property))) {
      return undefined;
    }
    Object.assign(properties, schema.properties);
  }
  for (const branchKey of ["oneOf", "anyOf", "allOf"] as const) {
    const branches = schema[branchKey];
    if (branches === undefined) continue;
    if (!Array.isArray(branches)) return undefined;
    for (const branch of branches) {
      if (!isJsonSchema(branch)) return undefined;
      const branchProperties = collectManifestBodyProperties(root, branch, seen);
      if (branchProperties === undefined) return undefined;
      Object.assign(properties, branchProperties);
    }
  }
  return properties;
}

function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= (days[month - 1] ?? 0);
}

function manifestFailure(message: string, details?: Readonly<Record<string, unknown>>): never {
  throw new OperationalError({
    code: "INVALID_OPENAPI_MANIFEST",
    message,
    suggestion: "Regenerate the bundled OpenAPI manifest and run the local checks.",
    ...(details === undefined ? {} : { details }),
  });
}

const HTTP_METHODS = new Set<HttpMethod>(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const PARAMETER_LOCATIONS = new Set<ParameterLocation>(["path", "query", "header", "cookie"]);
const SECURITY_VALUES = new Set<OperationSecurity>(["public", "cookie", "basic", "none"]);
const STATUS_VALUES = new Set<OperationStatus>([
  "observed",
  "corroborated",
  "advertised-only",
  "vendor-spec",
  "unknown",
]);
const SHAPE_VALUES = new Set<ResponseShape>(["typed", "partial", "unknown"]);
const EFFECT_VALUES = new Set<RiskEffect>([
  "read",
  "private-write",
  "delete",
  "public-share",
  "public-rating",
  "device-link",
  "unknown",
]);

/** Validate an unknown parsed JSON value and return its typed manifest view. */
export function parseManifest(value: unknown): OpenApiManifest {
  if (!isRecord(value)) manifestFailure("The OpenAPI manifest root must be an object.");
  for (const key of ["generatedFrom", "openapi", "apiVersion", "server"] as const) {
    if (typeof value[key] !== "string" || value[key].length === 0) {
      manifestFailure(`The OpenAPI manifest has an invalid ${key} field.`);
    }
  }
  if (!isRecord(value.source)
      || typeof value.source.repository !== "string"
      || !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(value.source.repository)
      || typeof value.source.commit !== "string"
      || !/^[0-9a-f]{40}$/u.test(value.source.commit)
      || typeof value.source.path !== "string"
      || value.source.path.length === 0
      || typeof value.source.sha256 !== "string"
      || !/^[0-9a-f]{64}$/u.test(value.source.sha256)) {
    manifestFailure("The OpenAPI manifest has invalid immutable source provenance.");
  }
  if (!isRecord(value.authentication) || !isRecord(value.protocol)) {
    manifestFailure("The OpenAPI manifest authentication and protocol metadata must be objects.");
  }
  if (!isRecord(value.compatibilityOverrides)
      || !isRecord(value.compatibilityOverrides.responses)) {
    manifestFailure("The OpenAPI manifest compatibility overrides must be an object.");
  }
  if (!isRecord(value.components) || !isRecord(value.components.schemas)) {
    manifestFailure("The OpenAPI manifest must contain component schemas.");
  }
  if (!isRecord(value.components.securitySchemes) || !isRecord(value.components.responses)) {
    manifestFailure("The OpenAPI manifest must contain response and security-scheme metadata.");
  }
  if (!Array.isArray(value.operations) || value.operations.length === 0) {
    manifestFailure("The OpenAPI manifest must contain operations.");
  }

  const operationIds = new Set<string>();
  const commandKeys = new Set<string>();
  for (const candidate of value.operations) {
    if (!isRecord(candidate)) manifestFailure("Every manifest operation must be an object.");
    const operationId = candidate.operationId;
    if (typeof operationId !== "string" || operationId.length === 0) {
      manifestFailure("Every manifest operation needs an operationId.");
    }
    if (operationIds.has(operationId)) {
      manifestFailure("Manifest operationIds must be unique.", { operationId });
    }
    operationIds.add(operationId);

    if (!Array.isArray(candidate.command) || candidate.command.length === 0 ||
        candidate.command.some((part) => typeof part !== "string" || part.length === 0)) {
      manifestFailure("Every manifest operation needs a non-empty command path.", { operationId });
    }
    const command = candidate.command as string[];
    const commandKey = JSON.stringify(command);
    if (commandKeys.has(commandKey)) {
      manifestFailure("Manifest command paths must be unique.", {
        operationId,
        command: command.join(" "),
      });
    }
    commandKeys.add(commandKey);

    if (typeof candidate.method !== "string" || !HTTP_METHODS.has(candidate.method as HttpMethod)) {
      manifestFailure("A manifest operation has an unsupported HTTP method.", { operationId });
    }
    for (const key of ["path", "tag", "summary"] as const) {
      if (typeof candidate[key] !== "string" || candidate[key].length === 0) {
        manifestFailure(`A manifest operation has an invalid ${key}.`, { operationId });
      }
    }
    if (!Array.isArray(candidate.parameters)) {
      manifestFailure("A manifest operation has invalid parameters.", { operationId });
    }
    for (const parameter of candidate.parameters) {
      if (!isRecord(parameter) || typeof parameter.name !== "string" ||
          typeof parameter.in !== "string" ||
          !PARAMETER_LOCATIONS.has(parameter.in as ParameterLocation) ||
          typeof parameter.required !== "boolean" || !("schema" in parameter)) {
        manifestFailure("A manifest operation has an invalid parameter entry.", { operationId });
      }
    }
    if (candidate.requestBody !== null) {
      if (!isRecord(candidate.requestBody) || typeof candidate.requestBody.required !== "boolean" ||
          !isRecord(candidate.requestBody.content)) {
        manifestFailure("A manifest operation has an invalid request body.", { operationId });
      }
      for (const media of Object.values(candidate.requestBody.content)) {
        if (!isRecord(media) || !isJsonSchema(media.schema) || !isRecord(media.bodyProperties)
            || Object.values(media.bodyProperties).some((schema) => !isJsonSchema(schema))) {
          manifestFailure("A manifest request media entry is invalid.", { operationId });
        }
        const bodyProperties = media.bodyProperties as Record<string, JsonSchema>;
        const expectedBodyProperties = collectManifestBodyProperties(value, media.schema);
        if (expectedBodyProperties === undefined
            || Object.keys(expectedBodyProperties).length !== Object.keys(bodyProperties).length
            || Object.entries(expectedBodyProperties).some(([name, schema]) =>
              !Object.hasOwn(bodyProperties, name)
              || JSON.stringify(bodyProperties[name]) !== JSON.stringify(schema))) {
          manifestFailure("A manifest request body-property map does not match its schema.", {
            operationId,
          });
        }
      }
    }
    if (!isRecord(candidate.responses) || typeof candidate.security !== "string" ||
        !SECURITY_VALUES.has(candidate.security as OperationSecurity) ||
        typeof candidate.status !== "string" || !STATUS_VALUES.has(candidate.status as OperationStatus) ||
        typeof candidate.responseShape !== "string" ||
        !SHAPE_VALUES.has(candidate.responseShape as ResponseShape)) {
      manifestFailure("A manifest operation has invalid response or provenance metadata.", {
        operationId,
      });
    }
    if (!isRecord(candidate.risk) || typeof candidate.risk.effect !== "string" ||
        !EFFECT_VALUES.has(candidate.risk.effect as RiskEffect) ||
        typeof candidate.risk.destructive !== "boolean" ||
        typeof candidate.risk.externallyVisible !== "boolean" ||
        typeof candidate.risk.exercised !== "boolean") {
      manifestFailure("A manifest operation has invalid risk metadata.", { operationId });
    }
  }

  const operationsById = new Map(
    value.operations
      .filter(isRecord)
      .map((operation) => [operation.operationId, operation]),
  );
  for (const [operationId, statuses] of Object.entries(value.compatibilityOverrides.responses)) {
    if (!isRecord(statuses)) {
      manifestFailure("A response compatibility override has invalid status metadata.", { operationId });
    }
    const operation = operationsById.get(operationId);
    if (!isRecord(operation) || !isRecord(operation.responses)) {
      manifestFailure("A response compatibility override targets an unknown operation.", { operationId });
    }
    for (const [status, override] of Object.entries(statuses)) {
      if (!/^2[0-9]{2}$/u.test(status) || !isRecord(override)
          || Object.keys(override).some((key) =>
            !["addMediaType", "copySchemaFrom", "observedAt"].includes(key))
          || typeof override.addMediaType !== "string"
          || typeof override.copySchemaFrom !== "string"
          || override.addMediaType === override.copySchemaFrom
          || !/^application\/(?:json|[a-z0-9][a-z0-9!#$%&'*.^_|~-]*\+json)$/u.test(override.addMediaType)
          || !/^application\/(?:json|[a-z0-9][a-z0-9!#$%&'*.^_|~-]*\+json)$/u.test(override.copySchemaFrom)
          || typeof override.observedAt !== "string"
          || !isCalendarDate(override.observedAt)) {
        manifestFailure("A response compatibility override is invalid.", { operationId, status });
      }
      const response = operation.responses[status];
      const content = isRecord(response) && isRecord(response.content) ? response.content : undefined;
      if (content === undefined
          || !isRecord(content[override.addMediaType])
          || !isRecord(content[override.copySchemaFrom])
          || JSON.stringify(content[override.addMediaType]) !== JSON.stringify(content[override.copySchemaFrom])) {
        manifestFailure("A response compatibility override is not an additive schema copy.", {
          operationId,
          status,
        });
      }
    }
  }

  return value as unknown as OpenApiManifest;
}

/** The validated manifest generated at build time. */
export const OPENAPI_MANIFEST = parseManifest(bundledManifestDocument);

/** Load an alternate generated manifest, or return the bundled one when omitted. */
export async function loadManifest(source?: string | URL): Promise<OpenApiManifest> {
  if (source === undefined) return OPENAPI_MANIFEST;
  let text: string;
  try {
    text = await readFile(source, "utf8");
  } catch {
    throw new OperationalError({
      code: "OPENAPI_MANIFEST_READ_FAILED",
      message: "The OpenAPI manifest could not be read.",
      suggestion: "Verify the manifest path and regenerate it if necessary.",
      details: { source: String(source) },
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new OperationalError({
      code: "OPENAPI_MANIFEST_JSON_INVALID",
      message: "The OpenAPI manifest is not valid JSON.",
      suggestion: "Regenerate the manifest from the canonical OpenAPI document.",
      details: { source: String(source) },
    });
  }
  return parseManifest(parsed);
}

interface OperationIndex {
  readonly byId: ReadonlyMap<string, ManifestOperation>;
  readonly byCommand: ReadonlyMap<string, ManifestOperation>;
}

const operationIndexes = new WeakMap<OpenApiManifest, OperationIndex>();

function operationIndex(manifest: OpenApiManifest): OperationIndex {
  const cached = operationIndexes.get(manifest);
  if (cached !== undefined) return cached;
  const byId = new Map<string, ManifestOperation>();
  const byCommand = new Map<string, ManifestOperation>();
  for (const operation of manifest.operations) {
    byId.set(operation.operationId, operation);
    byCommand.set(JSON.stringify(operation.command), operation);
  }
  const index = { byId, byCommand };
  operationIndexes.set(manifest, index);
  return index;
}

function editDistance(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitution = previous[rightIndex - 1] ?? 0;
      const deletion = previous[rightIndex] ?? 0;
      const insertion = current[rightIndex - 1] ?? 0;
      current.push(Math.min(
        deletion + 1,
        insertion + 1,
        substitution + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      ));
    }
    previous = current;
  }
  return previous[right.length] ?? Math.max(left.length, right.length);
}

export function findOperationById(
  operationId: string,
  manifest: OpenApiManifest = OPENAPI_MANIFEST,
): ManifestOperation | undefined {
  return operationIndex(manifest).byId.get(operationId);
}

export function getOperationById(
  operationId: string,
  manifest: OpenApiManifest = OPENAPI_MANIFEST,
): ManifestOperation {
  const operation = findOperationById(operationId, manifest);
  if (operation !== undefined) return operation;
  const alternatives = manifest.operations
    .map((candidate) => candidate.operationId)
    .sort((left, right) => editDistance(operationId, left) - editDistance(operationId, right))
    .slice(0, 3);
  throw new UsageError({
    code: "UNKNOWN_OPERATION",
    message: `Unknown OpenAPI operation: ${operationId}`,
    suggestion: alternatives.length === 0
      ? "Use command help to select a supported operation."
      : `Did you mean ${alternatives.join(", ")}?`,
    details: { operationId, alternatives },
  });
}

export function findOperationByCommand(
  command: readonly string[],
  manifest: OpenApiManifest = OPENAPI_MANIFEST,
): ManifestOperation | undefined {
  return operationIndex(manifest).byCommand.get(JSON.stringify(command));
}

export function getOperationByCommand(
  command: readonly string[],
  manifest: OpenApiManifest = OPENAPI_MANIFEST,
): ManifestOperation {
  const operation = findOperationByCommand(command, manifest);
  if (operation !== undefined) return operation;
  const first = command[0];
  const alternatives = manifest.operations
    .map((candidate) => candidate.command)
    .filter((candidate) => first === undefined || candidate[0] === first)
    .slice(0, 8)
    .map((candidate) => candidate.join(" "));
  throw new UsageError({
    code: "UNKNOWN_COMMAND",
    message: `Unknown command path: ${command.join(" ") || "<empty>"}`,
    suggestion: alternatives.length === 0
      ? "Run cookidoo-axi --help for valid commands."
      : `Valid commands here include: ${alternatives.join(", ")}`,
    details: { command, alternatives },
  });
}

/**
 * Resolve only canonical generated operations. A caller-supplied raw operation
 * can never replace its generated method, path, command, or risk metadata.
 */
export function canonicalOperation(
  operation: string | ManifestOperation,
  manifest: OpenApiManifest = OPENAPI_MANIFEST,
): ManifestOperation {
  const canonical = getOperationById(
    typeof operation === "string" ? operation : operation.operationId,
    manifest,
  );
  if (typeof operation !== "string" &&
      (operation.method !== canonical.method || operation.path !== canonical.path ||
       JSON.stringify(operation.command) !== JSON.stringify(canonical.command))) {
    throw new UsageError({
      code: "RAW_OPERATION_REJECTED",
      message: "Raw or modified operation metadata is not executable.",
      suggestion: `Use the generated command: cookidoo-axi ${canonical.command.join(" ")}`,
      details: { operationId: canonical.operationId },
    });
  }
  return canonical;
}

function isIsoDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;
}

function isIsoDateTime(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    return false;
  }
  return Number.isFinite(Date.parse(value));
}

function isUri(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol.length > 1;
  } catch {
    return false;
  }
}

const ajv = new Ajv2020({
  allErrors: true,
  coerceTypes: false,
  strict: false,
  validateFormats: true,
});
ajv.addFormat("date", { type: "string", validate: isIsoDate });
ajv.addFormat("date-time", { type: "string", validate: isIsoDateTime });
ajv.addFormat("uri", { type: "string", validate: isUri });

function normalizeSchemaRefs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeSchemaRefs);
  if (!isRecord(value)) return value;
  const normalized: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "$ref" && typeof entry === "string" &&
        entry.startsWith("#/components/schemas/")) {
      normalized[key] = `#/$defs/${entry.slice("#/components/schemas/".length)}`;
    } else {
      normalized[key] = normalizeSchemaRefs(entry);
    }
  }
  return normalized;
}

const validatorCaches = new WeakMap<OpenApiManifest, Map<string, ValidateFunction>>();

function compileValidator(
  manifest: OpenApiManifest,
  namespace: string,
  schema: JsonSchema,
): ValidateFunction {
  let cache = validatorCaches.get(manifest);
  if (cache === undefined) {
    cache = new Map<string, ValidateFunction>();
    validatorCaches.set(manifest, cache);
  }
  const cacheKey = `${namespace}\u0000${JSON.stringify(schema)}`;
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;
  const definitions = Object.fromEntries(
    Object.entries(manifest.components.schemas)
      .map(([name, definition]) => [name, normalizeSchemaRefs(definition)]),
  );
  const rootSchema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $defs: definitions,
    allOf: [normalizeSchemaRefs(schema)],
  };
  let validator: ValidateFunction;
  try {
    validator = ajv.compile(rootSchema);
  } catch {
    throw new OperationalError({
      code: "REQUEST_SCHEMA_COMPILE_FAILED",
      message: "A generated request schema could not be compiled.",
      suggestion: "Regenerate the OpenAPI manifest and run the local checks.",
      details: { namespace },
    });
  }
  cache.set(cacheKey, validator);
  return validator;
}

function validationIssues(errors: ErrorObject[] | null | undefined): ValidationIssue[] {
  return (errors ?? []).map((error) => ({
    path: error.instancePath || "/",
    keyword: error.keyword,
    message: error.message ?? "is invalid",
    params: error.params,
  }));
}

function normalizeMediaType(mediaType: string): string {
  return mediaType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

function selectRequestMedia(
  operation: ManifestOperation,
  requestedMediaType: string | undefined,
): { readonly mediaType: string; readonly media: ManifestRequestMedia } | null {
  const body = operation.requestBody;
  if (body === null) return null;
  const entries = Object.entries(body.content);
  let selected: [string, ManifestRequestMedia] | undefined;
  if (requestedMediaType !== undefined) {
    const normalized = normalizeMediaType(requestedMediaType);
    selected = entries.find(([mediaType]) => normalizeMediaType(mediaType) === normalized);
    if (selected === undefined) {
      throw new UsageError({
        code: "UNSUPPORTED_REQUEST_MEDIA_TYPE",
        message: `${operation.operationId} does not accept ${requestedMediaType}.`,
        suggestion: `Use one of: ${entries.map(([mediaType]) => mediaType).join(", ")}`,
        details: {
          operationId: operation.operationId,
          requestedMediaType,
          supportedMediaTypes: entries.map(([mediaType]) => mediaType),
        },
      });
    }
  } else {
    selected = entries.find(([mediaType]) => normalizeMediaType(mediaType) === "application/json") ??
      (entries.length === 1 ? entries[0] : undefined);
  }
  if (selected === undefined) {
    throw new UsageError({
      code: "REQUEST_MEDIA_TYPE_REQUIRED",
      message: `${operation.operationId} accepts multiple request media types.`,
      suggestion: `Select one of: ${entries.map(([mediaType]) => mediaType).join(", ")}`,
      details: { operationId: operation.operationId },
    });
  }
  return { mediaType: selected[0], media: selected[1] };
}

export function validateRequestBody(
  operationValue: string | ManifestOperation,
  value: unknown,
  options: RequestBodyValidationOptions = {},
  manifest: OpenApiManifest = OPENAPI_MANIFEST,
): RequestBodyValidationResult {
  const operation = canonicalOperation(operationValue, manifest);
  const selection = selectRequestMedia(operation, options.mediaType);
  if (selection === null) {
    if (value === undefined) {
      return { ok: true, operationId: operation.operationId, mediaType: null, value };
    }
    return {
      ok: false,
      operationId: operation.operationId,
      mediaType: null,
      issues: [{
        path: "/",
        keyword: "requestBody",
        message: "this operation does not accept a request body",
      }],
    };
  }
  if (value === undefined) {
    if (!operation.requestBody?.required) {
      return {
        ok: true,
        operationId: operation.operationId,
        mediaType: selection.mediaType,
        value,
      };
    }
    return {
      ok: false,
      operationId: operation.operationId,
      mediaType: selection.mediaType,
      issues: [{ path: "/", keyword: "required", message: "request body is required" }],
    };
  }
  const validator = compileValidator(
    manifest,
    `body:${operation.operationId}:${selection.mediaType}`,
    selection.media.schema,
  );
  if (validator(value)) {
    return {
      ok: true,
      operationId: operation.operationId,
      mediaType: selection.mediaType,
      value,
    };
  }
  return {
    ok: false,
    operationId: operation.operationId,
    mediaType: selection.mediaType,
    issues: validationIssues(validator.errors),
  };
}

export function assertValidRequestBody(
  operation: string | ManifestOperation,
  value: unknown,
  options: RequestBodyValidationOptions = {},
  manifest: OpenApiManifest = OPENAPI_MANIFEST,
): { readonly mediaType: string | null; readonly value: unknown } {
  const result = validateRequestBody(operation, value, options, manifest);
  if (result.ok) return { mediaType: result.mediaType, value: result.value };
  throw new UsageError({
    code: "INVALID_REQUEST_BODY",
    message: `The request body for ${result.operationId} is invalid.`,
    suggestion: "Correct the reported fields or inspect this command's focused help.",
    details: { operationId: result.operationId, issues: result.issues },
  });
}

function resolveResponseObject(
  value: unknown,
  manifest: OpenApiManifest,
): Readonly<Record<string, unknown>> | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.$ref !== "string") return value;
  const prefix = "#/components/responses/";
  if (!value.$ref.startsWith(prefix)) return undefined;
  const name = value.$ref.slice(prefix.length).replaceAll("~1", "/").replaceAll("~0", "~");
  const resolved = manifest.components.responses[name];
  return isRecord(resolved) ? resolved : undefined;
}

/** Validate a successful provider response without ever embedding its values in diagnostics. */
export function validateResponse(
  operationValue: string | ManifestOperation,
  status: number,
  value: unknown,
  options: ResponseValidationOptions = {},
  manifest: OpenApiManifest = OPENAPI_MANIFEST,
): ResponseValidationResult {
  const operation = canonicalOperation(operationValue, manifest);
  const responseValue = operation.responses[String(status)] ?? operation.responses.default;
  const response = resolveResponseObject(responseValue, manifest);
  if (response === undefined) {
    return {
      ok: false,
      operationId: operation.operationId,
      status,
      issues: [{ path: "/status", keyword: "responseStatus", message: "status is not declared" }],
    };
  }
  if (status === 303) {
    return { ok: true, operationId: operation.operationId, status, value };
  }
  const content = isRecord(response.content) ? response.content : {};
  const entries = Object.entries(content).filter((entry): entry is [string, Record<string, unknown>] =>
    isRecord(entry[1]));
  const empty = options.empty === true;
  if (entries.length === 0) {
    return empty || value === undefined || value === null
      ? { ok: true, operationId: operation.operationId, status, value }
      : {
          ok: false,
          operationId: operation.operationId,
          status,
          issues: [{ path: "/", keyword: "responseBody", message: "body is not declared" }],
        };
  }
  if (empty) {
    return {
      ok: false,
      operationId: operation.operationId,
      status,
      issues: [{ path: "/", keyword: "required", message: "declared response body is missing" }],
    };
  }
  const requested = options.contentType === undefined || options.contentType === null
    ? undefined : normalizeMediaType(options.contentType);
  const selected = requested === undefined
    ? (entries.length === 1 ? entries[0] : entries.find(([type]) => normalizeMediaType(type) === "application/json"))
    : entries.find(([type]) => normalizeMediaType(type) === requested);
  if (selected === undefined) {
    return {
      ok: false,
      operationId: operation.operationId,
      status,
      issues: [{
        path: "/contentType",
        keyword: "contentType",
        message: `unexpected media type; declared types are ${entries.map(([type]) => type).join(", ")}`,
      }],
    };
  }
  const schema = selected[1].schema;
  if (!isRecord(schema) && typeof schema !== "boolean") {
    return { ok: true, operationId: operation.operationId, status, value };
  }
  const validator = compileValidator(
    manifest,
    `response:${operation.operationId}:${status}:${selected[0]}`,
    schema,
  );
  if (validator(value)) return { ok: true, operationId: operation.operationId, status, value };
  return {
    ok: false,
    operationId: operation.operationId,
    status,
    issues: validationIssues(validator.errors),
  };
}

export function assertValidResponse(
  operation: string | ManifestOperation,
  status: number,
  value: unknown,
  options: ResponseValidationOptions = {},
  manifest: OpenApiManifest = OPENAPI_MANIFEST,
): unknown {
  const result = validateResponse(operation, status, value, options, manifest);
  if (result.ok) return result.value;
  throw new OperationalError({
    code: "RESPONSE_CONTRACT_MISMATCH",
    message: `The response for ${result.operationId} does not match its generated OpenAPI contract.`,
    suggestion: "Do not infer missing fields; inspect the status/media details and report contract drift.",
    details: { operationId: result.operationId, status: result.status, issues: result.issues },
  });
}

function resolveSchema(schema: JsonSchema, manifest: OpenApiManifest): JsonSchema {
  let current = schema;
  const seen = new Set<string>();
  while (isRecord(current) && typeof current.$ref === "string") {
    const prefix = "#/components/schemas/";
    if (!current.$ref.startsWith(prefix)) return current;
    if (seen.has(current.$ref)) return current;
    seen.add(current.$ref);
    const name = current.$ref.slice(prefix.length)
      .replaceAll("~1", "/")
      .replaceAll("~0", "~");
    const resolved = manifest.components.schemas[name];
    if (resolved === undefined) {
      manifestFailure("A request schema contains an unresolved reference.", { ref: current.$ref });
    }
    current = resolved;
  }
  return current;
}

function schemaValid(
  value: unknown,
  schema: JsonSchema,
  manifest: OpenApiManifest,
  namespace: string,
): boolean {
  return compileValidator(manifest, namespace, schema)(value) as boolean;
}

function jsonParse(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function coerceValue(
  value: unknown,
  originalSchema: JsonSchema,
  manifest: OpenApiManifest,
  namespace: string,
  depth = 0,
): unknown {
  if (depth > 32 || schemaValid(value, originalSchema, manifest, `${namespace}:raw`)) return value;
  const schema = resolveSchema(originalSchema, manifest);
  if (!isRecord(schema)) return value;

  const oneOf = Array.isArray(schema.oneOf) ? schema.oneOf : undefined;
  const anyOf = Array.isArray(schema.anyOf) ? schema.anyOf : undefined;
  const branches = oneOf ?? anyOf;
  if (branches !== undefined) {
    const candidates: unknown[] = [];
    for (const [index, branch] of branches.entries()) {
      if (!isRecord(branch) && typeof branch !== "boolean") continue;
      const candidate = coerceValue(
        value,
        branch,
        manifest,
        `${namespace}:branch:${index}`,
        depth + 1,
      );
      if (schemaValid(candidate, branch, manifest, `${namespace}:branch:${index}:valid`)) {
        candidates.push(candidate);
      }
    }
    if ((oneOf !== undefined && candidates.length === 1) ||
        (anyOf !== undefined && candidates.length > 0)) {
      return candidates[0];
    }
    return value;
  }

  const types = Array.isArray(schema.type) ? schema.type :
    (typeof schema.type === "string" ? [schema.type] : []);
  if (types.length > 1) {
    for (const type of types) {
      const branch = { ...schema, type };
      const candidate = coerceValue(value, branch, manifest, `${namespace}:type:${type}`, depth + 1);
      if (schemaValid(candidate, branch, manifest, `${namespace}:type:${type}:valid`)) {
        return candidate;
      }
    }
    return value;
  }

  const type = types[0];
  if (type === "boolean" && typeof value === "string") {
    if (value === "true") return true;
    if (value === "false") return false;
  }
  if (type === "integer" && typeof value === "string" && /^-?(?:0|[1-9]\d*)$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  if (type === "number" && typeof value === "string" &&
      /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value)) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  if (type === "array") {
    const parsed = typeof value === "string" ? jsonParse(value) : value;
    if (Array.isArray(parsed)) {
      const itemSchema = (isRecord(schema.items) || typeof schema.items === "boolean")
        ? schema.items : true;
      return parsed.map((item, index) => coerceValue(
        item,
        itemSchema,
        manifest,
        `${namespace}:item:${index}`,
        depth + 1,
      ));
    }
  }
  if (type === "object" || isRecord(schema.properties)) {
    const parsed = typeof value === "string" ? jsonParse(value) : value;
    if (isRecord(parsed)) {
      const properties = isRecord(schema.properties) ? schema.properties : {};
      const additional = (isRecord(schema.additionalProperties) ||
        typeof schema.additionalProperties === "boolean") ? schema.additionalProperties : true;
      const result: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(parsed)) {
        const propertySchema = properties[key];
        const selected = (isRecord(propertySchema) || typeof propertySchema === "boolean")
          ? propertySchema : additional;
        result[key] = coerceValue(
          entry,
          selected,
          manifest,
          `${namespace}:property:${key}`,
          depth + 1,
        );
      }
      return result;
    }
  }
  return value;
}

const NO_DEFAULT = Symbol("no-default");

function schemaDefault(schema: JsonSchema, manifest: OpenApiManifest): unknown | typeof NO_DEFAULT {
  const resolved = resolveSchema(schema, manifest);
  if (!isRecord(resolved) || !Object.hasOwn(resolved, "default")) return NO_DEFAULT;
  return structuredClone(resolved.default);
}

function parameterIssuePath(parameter: ManifestParameter, issuePath: string): string {
  const suffix = issuePath === "/" ? "" : issuePath;
  return `/${parameter.in}/${parameter.name}${suffix}`;
}

export function validateParameters(
  operationValue: string | ManifestOperation,
  supplied: FlatParameterInput,
  options: ParameterValidationOptions = {},
  manifest: OpenApiManifest = OPENAPI_MANIFEST,
): ParameterValidationResult {
  const operation = canonicalOperation(operationValue, manifest);
  const applyDefaults = options.applyDefaults ?? true;
  const rejectUnknown = options.rejectUnknown ?? true;
  const issues: ValidationIssue[] = [];
  const declaredNames = new Set(operation.parameters.map((parameter) => parameter.name));
  if (rejectUnknown) {
    for (const name of Object.keys(supplied)) {
      if (!declaredNames.has(name)) {
        issues.push({
          path: `/${name}`,
          keyword: "unknownParameter",
          message: `unknown parameter; valid parameters are ${[...declaredNames].join(", ") || "none"}`,
        });
      }
    }
  }

  const locations: Record<ParameterLocation, Record<string, unknown>> = {
    path: {},
    query: {},
    header: {},
    cookie: {},
  };
  for (const parameter of operation.parameters) {
    const present = Object.hasOwn(supplied, parameter.name) && supplied[parameter.name] !== undefined;
    let value: unknown;
    if (present) {
      value = supplied[parameter.name];
    } else if (applyDefaults) {
      const defaultValue = schemaDefault(parameter.schema, manifest);
      if (defaultValue !== NO_DEFAULT) value = defaultValue;
    }
    if (value === undefined) {
      if (parameter.required) {
        issues.push({
          path: `/${parameter.in}/${parameter.name}`,
          keyword: "required",
          message: "required parameter is missing",
        });
      }
      continue;
    }
    const coerced = coerceValue(
      value,
      parameter.schema,
      manifest,
      `parameter:${operation.operationId}:${parameter.in}:${parameter.name}`,
    );
    const validator = compileValidator(
      manifest,
      `parameter:${operation.operationId}:${parameter.in}:${parameter.name}:final`,
      parameter.schema,
    );
    if (!validator(coerced)) {
      issues.push(...validationIssues(validator.errors).map((issue) => ({
        ...issue,
        path: parameterIssuePath(parameter, issue.path),
      })));
      continue;
    }
    locations[parameter.in][parameter.name] = coerced;
  }

  if (issues.length > 0) return { ok: false, issues };
  return {
    ok: true,
    value: {
      path: locations.path,
      query: locations.query,
      header: locations.header,
      cookie: locations.cookie,
    },
  };
}

export function coerceAndValidateParameters(
  operation: string | ManifestOperation,
  supplied: FlatParameterInput,
  options: ParameterValidationOptions = {},
  manifest: OpenApiManifest = OPENAPI_MANIFEST,
): CoercedParameters {
  const canonical = canonicalOperation(operation, manifest);
  const result = validateParameters(canonical, supplied, options, manifest);
  if (result.ok) return result.value;
  throw new UsageError({
    code: "INVALID_PARAMETERS",
    message: `The parameters for ${canonical.operationId} are invalid.`,
    suggestion: "Correct the reported parameters or inspect this command's focused help.",
    details: { operationId: canonical.operationId, issues: result.issues },
  });
}
