import { OPENAPI_MANIFEST } from "../api/spec.js";
import {
  classifySafety,
  type SafetyClassification,
  type SafetyLevel,
} from "../safety/policy.js";
import {
  commandArgument,
  commandLiteral,
  commandLiterals,
  renderCommand,
  type CommandToken,
} from "./command.js";
import type { OperationDescriptor, ParsedOperationInvocation } from "./types.js";

const MAX_SCHEMA_DEPTH = 2;
const MAX_SCHEMA_PROPERTIES = 24;
const MAX_SCHEMA_VARIANTS = 8;
const MAX_ENUM_VALUES = 20;
const MAX_DESCRIPTION_CHARACTERS = 300;

/**
 * Task-shaped routes which deliberately do not mirror a distinct OpenAPI
 * operation. Keeping them with the backing operation makes catalog search
 * discover the safer, higher-level command an agent can actually run.
 */
const TASK_COMMAND_ALIASES: Readonly<Record<string, readonly string[]>> = {
  listCreatedRecipes: [
    "cookidoo-axi created import --recipe-url <https-url>",
  ],
  patchCreatedRecipe: [
    "cookidoo-axi created update <customerRecipeId> --instructions <STEP-json> --infer-thermomix-settings",
    "cookidoo-axi created publish <customerRecipeId>",
    "cookidoo-axi created unpublish <customerRecipeId>",
  ],
};

const COLLECTION_KEYS: Readonly<Record<string, readonly string[]>> = {
  search: ["data"],
  searchStripe: ["data"],
  searchIngredients: ["ingredients"],
  listCreatedRecipes: ["items", "data"],
  listCustomLists: ["customlists"],
  listManagedLists: ["managedlists"],
  bootstrapCollectionFeed: ["items"],
  getCollectionFeed: ["items"],
  getCollectionFeedPage: ["items"],
};

export interface CollectionView {
  readonly items: readonly unknown[];
  readonly total: number | null;
  readonly hasMore: boolean | null;
  readonly envelope: unknown;
}

export interface BodyVariantContract {
  readonly variant: number;
  readonly required: readonly string[];
  readonly properties: readonly string[];
  readonly additionalProperties: boolean | "schema" | null;
}

export interface EffectiveSafetyCase {
  readonly level: SafetyLevel;
  readonly effect: string;
  readonly mutation: boolean;
  readonly destructive: boolean;
  readonly externallyVisible: boolean;
  readonly deviceAction: boolean;
  readonly advertisedOnlyMutation: boolean;
  readonly requiresConfirmation: boolean;
  readonly allowUnverifiedRequired: boolean;
  readonly semanticOverrides: readonly string[];
}

export interface ConditionalSafetyCase extends EffectiveSafetyCase {
  readonly when: string;
  readonly preferredCommand?: string;
}

export interface EffectiveSafetyPolicy {
  readonly default: EffectiveSafetyCase;
  readonly conditionalCases: readonly ConditionalSafetyCase[];
}

export function operationCatalog(operations: readonly OperationDescriptor[]): Record<string, unknown> {
  return {
    operations: operations.map((operation) => {
      const policy = effectiveSafetyPolicy(operation);
      const cases = [policy.default, ...policy.conditionalCases];
      const guarded = cases.some((entry) => entry.requiresConfirmation);
      const risks = [...new Set(cases.map((entry) => entry.level))];
      return {
        command: `cookidoo-axi ${operation.command.join(" ")}`,
        taskCommands: [...(TASK_COMMAND_ALIASES[operation.operationId] ?? [])],
        operationId: operation.operationId,
        method: operation.method,
        auth: operation.security,
        evidence: operation.status,
        response: operation.responseShape,
        risk: policy.default.level,
        risks,
        requiresAllowUnverified: cases.some((entry) => entry.allowUnverifiedRequired),
        destructive: cases.some((entry) => entry.destructive),
        externallyVisible: cases.some((entry) => entry.externallyVisible),
        guarded,
        ...(policy.conditionalCases.length === 0 ? {} : { conditionalPolicy: true }),
        summary: operation.summary,
      };
    }),
    count: operations.length,
    coverage: "complete",
    source: {
      generatedFrom: OPENAPI_MANIFEST.generatedFrom,
      ...OPENAPI_MANIFEST.source,
    },
  };
}

export function operationDescription(operation: OperationDescriptor): Record<string, unknown> {
  const parameters = operation.parameters.map((parameter) => ({
    name: parameter.name,
    flag: parameter.in === "query"
      ? parameter.name === "filters" ? "--filter" : `--${kebab(parameter.name)}`
      : parameter.in === "path" && parameter.name === "lang" ? "--lang" : null,
    argument: parameter.in === "path" && parameter.name !== "lang"
      ? `<${parameter.name}>` : null,
    in: parameter.in,
    required: parameter.required,
    schema: schemaSummary(parameter.schema),
    description: parameter.description ?? null,
    cliHandling: parameterCliHandling(operation.operationId, parameter.name, parameter.in),
  }));
  const requestBodies = operation.requestBody === null ? [] :
    Object.entries(operation.requestBody.content).map(([mediaType, media]) => {
      const variants = bodyVariantContracts(media.schema);
      return {
        mediaType,
        required: operation.requestBody?.required ?? false,
        properties: Object.keys(media.bodyProperties).map((name) => {
          const requiredInVariants = variants
            .filter((variant) => variant.required.includes(name))
            .map((variant) => variant.variant);
          const availableInVariants = variants
            .filter((variant) => variant.properties.includes(name))
            .map((variant) => variant.variant);
          return {
            name,
            flag: `--${kebab(name)}`,
            required: variants.length > 0 && requiredInVariants.length === variants.length,
            requirement: requiredInVariants.length === 0
              ? "optional"
              : requiredInVariants.length === variants.length ? "always" : "variant-dependent",
            requiredInVariants,
            availableInVariants,
            schema: summarizeSchema(media.bodyProperties[name] ?? {}, 0, new Set(), 1),
            cliHandling: bodyPropertyCliHandling(operation.operationId, name),
          };
        }),
        variants,
        schema: schemaSummary(media.schema),
        example: media.example ?? null,
      };
    });
  const responseStatuses = Object.keys(operation.responses);
  const responseOverrides = OPENAPI_MANIFEST.compatibilityOverrides.responses[operation.operationId] ?? {};
  const policy = effectiveSafetyPolicy(operation);
  return {
    operationId: operation.operationId,
    command: `cookidoo-axi ${operation.command.join(" ")}`,
    summary: operation.summary,
    description: operation.description ?? null,
    request: {
      method: operation.method,
      path: operation.path,
      auth: operation.security,
      parameters,
      bodies: requestBodies,
    },
    response: {
      shape: operation.responseShape,
      successStatuses: responseStatuses.filter((status) => /^2\d\d$/u.test(status) || status === "303"),
      errorStatuses: responseStatuses.filter((status) => !/^2\d\d$/u.test(status) && status !== "303"),
      statuses: Object.entries(operation.responses).map(([status, response]) =>
        responseContract(status, response, responseOverrides[status])),
    },
    safety: {
      evidence: operation.status,
      level: policy.default.level,
      effect: policy.default.effect,
      destructive: policy.default.destructive,
      externallyVisible: policy.default.externallyVisible,
      exercised: operation.risk.exercised,
      requiresConfirmation: policy.default.requiresConfirmation,
      conditionallyGuarded: !policy.default.requiresConfirmation &&
        policy.conditionalCases.some((entry) => entry.requiresConfirmation),
      advertisedOnlyGate: policy.default.allowUnverifiedRequired ||
        policy.conditionalCases.some((entry) => entry.allowUnverifiedRequired),
      upstream: {
        effect: operation.risk.effect,
        destructive: operation.risk.destructive,
        externallyVisible: operation.risk.externallyVisible,
      },
      effectivePolicy: {
        default: safetyCaseContract(policy.default),
        conditionalCases: policy.conditionalCases.map(safetyCaseContract),
      },
      automaticMutationRetry: false,
    },
  };
}

export function effectiveSafetyPolicy(operation: OperationDescriptor): EffectiveSafetyPolicy {
  const classified = safetyCase(classifySafety(operation.operationId));
  if (operation.operationId === "patchCreatedRecipe") {
    return {
      default: {
        ...classified,
        level: "private-write",
        effect: "private-write",
        externallyVisible: false,
        requiresConfirmation: false,
        semanticOverrides: [
          ...classified.semanticOverrides,
          "a content edit without workStatus does not change publication state",
        ],
      },
      conditionalCases: [{
        ...classified,
        when: "the validated request body includes workStatus (PUBLIC or PRIVATE)",
        preferredCommand: "cookidoo-axi created publish|unpublish <customerRecipeId>",
      }],
    };
  }
  if (operation.operationId === "listCreatedRecipes") {
    return {
      default: classified,
      conditionalCases: [{
        level: "unverified",
        effect: "private-write",
        mutation: true,
        destructive: false,
        externallyVisible: false,
        deviceAction: false,
        advertisedOnlyMutation: true,
        requiresConfirmation: true,
        allowUnverifiedRequired: true,
        semanticOverrides: [
          "recipeUrl, partnerId, or addToCookidoo activates an unverified import-like GET",
        ],
        when: "any of recipeUrl, partnerId, or addToCookidoo is supplied",
        preferredCommand: "cookidoo-axi created import",
      }],
    };
  }
  return { default: classified, conditionalCases: [] };
}

export function bodyVariantContracts(schema: unknown): BodyVariantContract[] {
  return collectBodyVariants(schema, new Set())
    .slice(0, MAX_SCHEMA_VARIANTS)
    .map((variant, index) => ({
      variant: index + 1,
      required: [...variant.required].sort(),
      properties: [...variant.properties].sort(),
      additionalProperties: variant.additionalProperties,
    }));
}

export function schemaSummary(schema: unknown): Record<string, unknown> {
  return summarizeSchema(schema, 0, new Set(), MAX_SCHEMA_DEPTH);
}

export function schemaHelpLabel(schema: unknown): string {
  return inlineSchema(schema, new Set());
}

export function isCollectionOperation(operationId: string): boolean {
  return operationId === "getRecipeCluster" || operationId === "getRecipeClusterV2" ||
    operationId === "listSubscriptions" || Object.hasOwn(COLLECTION_KEYS, operationId);
}

export function collectionView(value: unknown, operationId?: string): CollectionView | undefined {
  if (Array.isArray(value)) {
    return value.length === 0
      ? { items: value, total: 0, hasMore: false, envelope: null }
      : { items: value, total: null, hasMore: null, envelope: null };
  }
  if (!isObject(value) || operationId === undefined) return undefined;
  const itemKey = (COLLECTION_KEYS[operationId] ?? [])
    .find((key) => Array.isArray(value[key]));
  if (itemKey === undefined) return undefined;
  const items = value[itemKey] as unknown[];
  const page = isObject(value.page) ? value.page : undefined;
  const total = firstFiniteNonnegativeInteger(
    value.totalElements,
    value.total,
    page?.totalElements,
  );
  const hasMore = paginationHasMore(value, page);
  const envelope = Object.fromEntries(
    Object.entries(value).filter(([key]) => key !== itemKey),
  );
  return { items, total, hasMore, envelope };
}

export function safeCommand(invocation: ParsedOperationInvocation): string {
  const tokens: CommandToken[] = commandLiterals(["cookidoo-axi"]);
  if (invocation.operationMode === "created-publish") {
    tokens.push(...commandLiterals(["created", "publish"]));
  } else if (invocation.operationMode === "created-unpublish") {
    tokens.push(...commandLiterals(["created", "unpublish"]));
  } else if (invocation.operationMode === "created-import") {
    tokens.push(...commandLiterals(["created", "import"]));
  } else if (invocation.rawOperation) {
    tokens.push(...commandLiterals(["operation", "run"]));
    tokens.push(commandArgument(invocation.operation.operationId));
  } else {
    tokens.push(...commandLiterals(invocation.operation.command));
  }
  const pathNames = invocation.operation.parameters
    .filter((parameter) => parameter.in === "path" && parameter.name !== "lang")
    .map((parameter) => parameter.name);
  tokens.push(...pathNames
    .map((name) => invocation.path[name])
    .filter((value): value is string => value !== undefined)
    .map(commandArgument));
  for (const [key, value] of Object.entries(invocation.query)) {
    const flag = key === "pageBefore" && invocation.pageBeforeUnit !== undefined
      ? `--page-before-${invocation.pageBeforeUnit}`
      : `--${kebab(key)}`;
    tokens.push(commandLiteral(flag), commandArgument(value));
  }
  for (const filter of invocation.filters) {
    tokens.push(commandLiteral("--filter"), commandArgument(`${filter.key}=${filter.value}`));
  }
  const bodyFlags = reproducibleBodyTokens(invocation);
  if (bodyFlags !== null) tokens.push(...bodyFlags);
  if (invocation.bodyInput?.startsWith("@") === true) {
    tokens.push(commandLiteral("--data"), commandArgument(invocation.bodyInput));
  }
  if (invocation.inferThermomixSettings) {
    tokens.push(commandLiteral("--infer-thermomix-settings"));
  }
  tokens.push(commandLiteral("--output"), commandArgument(invocation.options.output));
  tokens.push(commandLiteral("--max-items"), commandArgument(invocation.options.maxItems));
  if (invocation.options.timeoutMs !== 15_000) {
    tokens.push(commandLiteral("--timeout-ms"), commandArgument(invocation.options.timeoutMs));
  }
  if (invocation.options.fields !== undefined) {
    tokens.push(commandLiteral("--fields"), commandArgument(invocation.options.fields.join(",")));
  }
  if (invocation.options.allowUnverified) tokens.push(commandLiteral("--allow-unverified"));
  if (invocation.options.target !== undefined) {
    tokens.push(commandLiteral("--target"), commandArgument(invocation.options.target));
  }
  if (invocation.options.profile !== "default") {
    tokens.push(commandLiteral("--profile"), commandArgument(invocation.options.profile));
  }
  if (invocation.options.lang !== "pl") {
    tokens.push(commandLiteral("--lang"), commandArgument(invocation.options.lang));
  }
  if (invocation.options.full) tokens.push(commandLiteral("--full"));
  return renderCommand(tokens);
}

export function hasReproducibleBody(invocation: ParsedOperationInvocation): boolean {
  if (invocation.operationMode === "created-publish" ||
      invocation.operationMode === "created-unpublish") return true;
  if (invocation.bodyFields.length > 0) return reproducibleBodyTokens(invocation) !== null;
  // Inline JSON, stdin, and @file inputs are intentionally not reconstructed:
  // an @file may change after dry-run, invalidating the reviewed request.
  return invocation.bodyInput === undefined;
}

function reproducibleBodyTokens(invocation: ParsedOperationInvocation): CommandToken[] | null {
  if (invocation.operationMode === "created-publish" ||
      invocation.operationMode === "created-unpublish") return [];
  const tokens: CommandToken[] = [];
  let totalCharacters = 0;
  for (const field of invocation.bodyFields) {
    if (
      field.value.length > 160 ||
      /[\p{Cc}\p{Cs}]/u.test(field.value) ||
      !/^[A-Za-z0-9_.-]+$/u.test(field.path) ||
      isSensitiveFieldPath(field.path)
    ) {
      return null;
    }
    const pair: CommandToken[] = field.flag === undefined
      ? [commandLiteral("--set"), commandArgument(`${field.path}=${field.value}`)]
      : [commandLiteral(field.flag), commandArgument(field.value)];
    totalCharacters += renderCommand(pair).length;
    if (totalCharacters > 512) return null;
    tokens.push(...pair);
  }
  return tokens;
}

function isSensitiveFieldPath(path: string): boolean {
  const leaf = path.split(".").at(-1)?.toLowerCase().replaceAll(/[^a-z0-9]/gu, "") ?? "";
  return /(?:authorization|password|passwd|credential|secret|privatekey|apikey|cookie|sessionid|token)$/u
    .test(leaf);
}

interface InternalBodyVariant {
  readonly required: ReadonlySet<string>;
  readonly properties: ReadonlySet<string>;
  readonly additionalProperties: boolean | "schema" | null;
}

interface ResolvedSchema {
  readonly value: unknown;
  readonly refName: string | null;
  readonly circular: boolean;
  readonly unresolved: boolean;
  readonly seenRefs: ReadonlySet<string>;
}

function safetyCase(classification: SafetyClassification): EffectiveSafetyCase {
  return {
    level: classification.level,
    effect: classification.effect,
    mutation: classification.mutation,
    destructive: classification.destructive,
    externallyVisible: classification.externallyVisible,
    deviceAction: classification.deviceAction,
    advertisedOnlyMutation: classification.advertisedOnlyMutation,
    requiresConfirmation: classification.requiresConfirmation,
    allowUnverifiedRequired: classification.advertisedOnlyMutation,
    semanticOverrides: [...classification.semanticOverrides],
  };
}

function safetyCaseContract(entry: EffectiveSafetyCase): Record<string, unknown> {
  const conditional = "when" in entry
    ? entry as ConditionalSafetyCase : undefined;
  return {
    ...(conditional === undefined ? {} : { when: conditional.when }),
    level: entry.level,
    effect: entry.effect,
    mutation: entry.mutation,
    destructive: entry.destructive,
    externallyVisible: entry.externallyVisible,
    deviceAction: entry.deviceAction,
    allowUnverifiedRequired: entry.allowUnverifiedRequired,
    requiresConfirmation: entry.requiresConfirmation,
    semanticOverrides: [...entry.semanticOverrides],
    ...(conditional?.preferredCommand === undefined
      ? {} : { preferredCommand: conditional.preferredCommand }),
    ...(entry.requiresConfirmation ? {
      confirmation: {
        deriveFrom: "the fully populated request run with --dry-run",
        outputField: "data.safety.confirmationTarget",
        executeWith: "copy that value verbatim into --confirm",
      },
    } : {}),
  };
}

function parameterCliHandling(
  operationId: string,
  name: string,
  location: OperationDescriptor["parameters"][number]["in"],
): string {
  if (location === "header" && name.toLowerCase() === "x-requested-with") {
    return "set automatically from the schema default";
  }
  if (location === "path" && name === "lang") {
    return "set with global --lang; the CLI applies the schema default";
  }
  if (location === "query" && name === "filters") {
    return "repeat --filter key=value; named keys are advertised and safe extension keys are allowed by additionalProperties";
  }
  if (operationId === "getCollectionFeedPage" && name === "pageBefore") {
    return "use --page-before for ISO date-time; numeric values require the explicit seconds or milliseconds flag";
  }
  if (operationId === "listCreatedRecipes" &&
      ["recipeUrl", "partnerId", "addToCookidoo"].includes(name)) {
    return "import-like input; use the guarded created import command (or raw operation mode)";
  }
  return "direct CLI input";
}

function bodyPropertyCliHandling(operationId: string, name: string): string {
  if (operationId === "patchCreatedRecipe" && name === "workStatus") {
    return "rejected by created update; use created publish/unpublish (or raw operation mode)";
  }
  return "top-level flag, --set, or complete --data body";
}

function responseContract(
  status: string,
  rawResponse: unknown,
  compatibility?: {
    readonly addMediaType: string;
    readonly copySchemaFrom: string;
    readonly observedAt: string;
  },
): Record<string, unknown> {
  const resolved = resolveResponse(rawResponse, new Set());
  if (!isObject(resolved.value)) {
    return {
      status,
      success: isSuccessStatus(status),
      ...(resolved.refName === null ? {} : { ref: resolved.refName }),
      description: null,
      headers: [],
      content: [],
    };
  }
  const response = resolved.value;
  const headers = isObject(response.headers)
    ? Object.entries(response.headers).slice(0, MAX_SCHEMA_PROPERTIES).map(([name, header]) => ({
        name,
        ...headerContract(header),
      }))
    : [];
  const content = isObject(response.content)
    ? Object.entries(response.content).slice(0, MAX_SCHEMA_VARIANTS).map(([mediaType, media]) => {
        const mediaRecord = isObject(media) ? media : {};
        return {
          mediaType,
          ...(compatibility?.addMediaType === mediaType ? {
            source: "compatibility-override",
            copySchemaFrom: compatibility.copySchemaFrom,
            observedAt: compatibility.observedAt,
          } : {}),
          schema: schemaSummary(mediaRecord.schema ?? {}),
          example: mediaRecord.example ?? null,
        };
      })
    : [];
  return {
    status,
    success: isSuccessStatus(status),
    ...(resolved.refName === null ? {} : { ref: resolved.refName }),
    description: typeof response.description === "string"
      ? boundedText(response.description) : null,
    headers,
    content,
  };
}

function headerContract(rawHeader: unknown): Record<string, unknown> {
  if (!isObject(rawHeader)) return { required: false, schema: { shape: "unknown" } };
  const refName = typeof rawHeader.$ref === "string"
    ? localComponentName(rawHeader.$ref, "headers") : null;
  return {
    ...(refName === null ? {} : { ref: refName }),
    required: rawHeader.required === true,
    description: typeof rawHeader.description === "string"
      ? boundedText(rawHeader.description) : null,
    schema: schemaSummary(rawHeader.schema ?? {}),
  };
}

function isSuccessStatus(status: string): boolean {
  return /^2\d\d$/u.test(status) || status === "303";
}

function resolveResponse(value: unknown, seenRefs: ReadonlySet<string>): ResolvedSchema {
  if (!isObject(value) || typeof value.$ref !== "string") {
    return {
      value,
      refName: null,
      circular: false,
      unresolved: false,
      seenRefs,
    };
  }
  const ref = value.$ref;
  const refName = localComponentName(ref, "responses");
  if (refName === null) {
    return { value, refName: ref.split("/").at(-1) ?? ref, circular: false, unresolved: true, seenRefs };
  }
  if (seenRefs.has(ref)) {
    return { value: {}, refName, circular: true, unresolved: false, seenRefs };
  }
  const target = OPENAPI_MANIFEST.components.responses[refName];
  if (target === undefined) {
    return { value: {}, refName, circular: false, unresolved: true, seenRefs };
  }
  const nextSeen = new Set(seenRefs);
  nextSeen.add(ref);
  const nested = resolveResponse(target, nextSeen);
  return {
    value: nested.value,
    refName,
    circular: nested.circular,
    unresolved: nested.unresolved,
    seenRefs: nested.seenRefs,
  };
}

function summarizeSchema(
  schema: unknown,
  depth: number,
  seenRefs: ReadonlySet<string>,
  maxDepth: number,
): Record<string, unknown> {
  if (typeof schema === "boolean") return { allowed: schema };
  if (!isObject(schema)) return { shape: "unknown" };
  const resolved = resolveSchema(schema, seenRefs);
  const summary: Record<string, unknown> = {};
  if (resolved.refName !== null) summary.ref = resolved.refName;
  if (resolved.unresolved) {
    summary.unresolved = true;
    return summary;
  }
  if (resolved.circular) {
    summary.recursive = true;
    return summary;
  }
  if (typeof resolved.value === "boolean") {
    summary.allowed = resolved.value;
    return summary;
  }
  if (!isObject(resolved.value)) {
    summary.shape = "unknown";
    return summary;
  }
  const value = resolved.value;
  for (const key of [
    "type", "format", "pattern", "default", "const", "minimum", "maximum",
    "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minLength", "maxLength",
    "minItems", "maxItems", "uniqueItems", "minProperties", "maxProperties",
    "readOnly", "writeOnly",
  ] as const) {
    if (value[key] !== undefined) summary[key] = value[key];
  }
  if (typeof value.description === "string") summary.description = boundedText(value.description);
  if (Array.isArray(value.enum)) {
    summary.enum = value.enum.slice(0, MAX_ENUM_VALUES);
    if (value.enum.length > MAX_ENUM_VALUES) summary.omittedEnumValues = value.enum.length - MAX_ENUM_VALUES;
  }
  if (Array.isArray(value.required)) {
    summary.required = value.required.slice(0, MAX_SCHEMA_PROPERTIES);
    if (value.required.length > MAX_SCHEMA_PROPERTIES) {
      summary.omittedRequiredProperties = value.required.length - MAX_SCHEMA_PROPERTIES;
    }
  }
  for (const key of ["oneOf", "anyOf", "allOf"] as const) {
    if (!Array.isArray(value[key])) continue;
    const entries = value[key].slice(0, MAX_SCHEMA_VARIANTS);
    if (depth < maxDepth) {
      summary[key] = entries.map((entry) =>
        summarizeSchema(entry, depth + 1, resolved.seenRefs, maxDepth));
    } else {
      summary[`${key}Count`] = value[key].length;
    }
    if (value[key].length > MAX_SCHEMA_VARIANTS) {
      summary[`omitted${capitalize(key)}Variants`] = value[key].length - MAX_SCHEMA_VARIANTS;
    }
  }
  if (isObject(value.properties)) {
    const entries = Object.entries(value.properties);
    summary.propertyCount = entries.length;
    const shown = entries.slice(0, MAX_SCHEMA_PROPERTIES);
    if (depth < maxDepth) {
      summary.properties = shown.map(([name, propertySchema]) => ({
        name,
        schema: summarizeSchema(propertySchema, depth + 1, resolved.seenRefs, maxDepth),
      }));
    } else {
      summary.propertyNames = shown.map(([name]) => name);
    }
    if (entries.length > MAX_SCHEMA_PROPERTIES) {
      summary.omittedProperties = entries.length - MAX_SCHEMA_PROPERTIES;
    }
  }
  if (value.items !== undefined) {
    summary.items = depth < maxDepth
      ? summarizeSchema(value.items, depth + 1, resolved.seenRefs, maxDepth)
      : { present: true };
  }
  if (typeof value.additionalProperties === "boolean") {
    summary.additionalProperties = value.additionalProperties;
  } else if (value.additionalProperties !== undefined) {
    summary.additionalProperties = depth < maxDepth
      ? summarizeSchema(value.additionalProperties, depth + 1, resolved.seenRefs, maxDepth)
      : { schema: true };
  }
  if (depth === 0 && value.example !== undefined) {
    summary.example = boundedExample(value.example);
  }
  if (Object.keys(summary).length === 0 ||
      Object.keys(summary).every((key) => key === "description" || key === "ref")) {
    summary.shape = "unconstrained";
  }
  return summary;
}

function inlineSchema(schema: unknown, seenRefs: ReadonlySet<string>): string {
  if (typeof schema === "boolean") return schema ? "any JSON" : "no value";
  if (!isObject(schema)) return "unknown";
  const resolved = resolveSchema(schema, seenRefs);
  if (resolved.unresolved) return resolved.refName ?? "unknown";
  if (resolved.circular) return resolved.refName === null ? "recursive" : `recursive ${resolved.refName}`;
  if (typeof resolved.value === "boolean") return resolved.value ? "any JSON" : "no value";
  if (!isObject(resolved.value)) return "unknown";
  const value = resolved.value;
  for (const key of ["oneOf", "anyOf"] as const) {
    if (Array.isArray(value[key])) {
      const variants = value[key].slice(0, MAX_SCHEMA_VARIANTS)
        .map((entry) => inlineSchema(entry, resolved.seenRefs));
      return `${key === "oneOf" ? "one of" : "any of"} ${variants.join(" | ")}`;
    }
  }
  let type: string;
  if (value.type === "array" || value.items !== undefined) {
    type = `array<${inlineSchema(value.items ?? {}, resolved.seenRefs)}>`;
  } else if (Array.isArray(value.type)) {
    type = value.type.filter((entry): entry is string => typeof entry === "string").join("|") || "unknown";
  } else if (typeof value.type === "string") {
    type = value.type;
  } else if (isObject(value.properties)) {
    type = "object";
  } else {
    type = resolved.refName ?? "any JSON";
  }
  if (resolved.refName !== null && ["object", "array"].includes(type)) {
    type += `(${resolved.refName})`;
  }
  const constraints: string[] = [];
  if (typeof value.format === "string") constraints.push(`format=${value.format}`);
  if (value.const !== undefined) constraints.push(`const=${shortValue(value.const)}`);
  if (Array.isArray(value.enum)) {
    constraints.push(`enum=${value.enum.slice(0, MAX_ENUM_VALUES).map(shortValue).join("|")}`);
  }
  if (typeof value.pattern === "string") constraints.push(`pattern=${value.pattern}`);
  for (const [key, label] of [
    ["minimum", "min"], ["maximum", "max"],
    ["exclusiveMinimum", "exclusiveMin"], ["exclusiveMaximum", "exclusiveMax"],
    ["minLength", "minLength"], ["maxLength", "maxLength"],
    ["minItems", "minItems"], ["maxItems", "maxItems"],
    ["minProperties", "minProperties"], ["maxProperties", "maxProperties"],
  ] as const) {
    if (typeof value[key] === "number") constraints.push(`${label}=${value[key]}`);
  }
  if (value.uniqueItems === true) constraints.push("uniqueItems");
  if (value.additionalProperties === false) constraints.push("no extra properties");
  if (value.default !== undefined) constraints.push(`default=${shortValue(value.default)}`);
  return constraints.length === 0 ? type : `${type}; ${constraints.join("; ")}`;
}

function resolveSchema(value: unknown, seenRefs: ReadonlySet<string>): ResolvedSchema {
  if (!isObject(value) || typeof value.$ref !== "string") {
    return {
      value,
      refName: null,
      circular: false,
      unresolved: false,
      seenRefs,
    };
  }
  const ref = value.$ref;
  const refName = localComponentName(ref, "schemas");
  if (refName === null) {
    return { value, refName: ref.split("/").at(-1) ?? ref, circular: false, unresolved: true, seenRefs };
  }
  if (seenRefs.has(ref)) {
    return { value: {}, refName, circular: true, unresolved: false, seenRefs };
  }
  const target = OPENAPI_MANIFEST.components.schemas[refName];
  if (target === undefined) {
    return { value: {}, refName, circular: false, unresolved: true, seenRefs };
  }
  const nextSeen = new Set(seenRefs);
  nextSeen.add(ref);
  const nested = resolveSchema(target, nextSeen);
  return {
    value: nested.value,
    refName,
    circular: nested.circular,
    unresolved: nested.unresolved,
    seenRefs: nested.seenRefs,
  };
}

function collectBodyVariants(
  schema: unknown,
  seenRefs: ReadonlySet<string>,
): InternalBodyVariant[] {
  const resolved = resolveSchema(schema, seenRefs);
  if (!isObject(resolved.value) || resolved.circular || resolved.unresolved) {
    return [emptyBodyVariant()];
  }
  const value = resolved.value;
  const base = ownBodyVariant(value);
  const alternatives = Array.isArray(value.oneOf) ? value.oneOf
    : Array.isArray(value.anyOf) ? value.anyOf : undefined;
  if (alternatives !== undefined) {
    return alternatives.slice(0, MAX_SCHEMA_VARIANTS)
      .flatMap((branch) => collectBodyVariants(branch, resolved.seenRefs))
      .slice(0, MAX_SCHEMA_VARIANTS)
      .map((branch) => mergeBodyVariants(base, branch));
  }
  if (Array.isArray(value.allOf)) {
    let combinations = [base];
    for (const branch of value.allOf.slice(0, MAX_SCHEMA_VARIANTS)) {
      const branchVariants = collectBodyVariants(branch, resolved.seenRefs);
      combinations = combinations.flatMap((current) =>
        branchVariants.map((entry) => mergeBodyVariants(current, entry)))
        .slice(0, MAX_SCHEMA_VARIANTS);
    }
    return combinations;
  }
  return [base];
}

function emptyBodyVariant(): InternalBodyVariant {
  return { required: new Set(), properties: new Set(), additionalProperties: null };
}

function ownBodyVariant(schema: Record<string, unknown>): InternalBodyVariant {
  const required = Array.isArray(schema.required)
    ? schema.required.filter((entry): entry is string => typeof entry === "string") : [];
  const properties = isObject(schema.properties) ? Object.keys(schema.properties) : [];
  let additionalProperties: boolean | "schema" | null = null;
  if (typeof schema.additionalProperties === "boolean") {
    additionalProperties = schema.additionalProperties;
  } else if (schema.additionalProperties !== undefined) {
    additionalProperties = "schema";
  }
  return {
    required: new Set(required),
    properties: new Set(properties),
    additionalProperties,
  };
}

function mergeBodyVariants(left: InternalBodyVariant, right: InternalBodyVariant): InternalBodyVariant {
  return {
    required: new Set([...left.required, ...right.required]),
    properties: new Set([...left.properties, ...right.properties]),
    additionalProperties: mergeAdditionalProperties(
      left.additionalProperties,
      right.additionalProperties,
    ),
  };
}

function mergeAdditionalProperties(
  left: boolean | "schema" | null,
  right: boolean | "schema" | null,
): boolean | "schema" | null {
  if (left === false || right === false) return false;
  if (left === "schema" || right === "schema") return "schema";
  if (left === true || right === true) return true;
  return null;
}

function localComponentName(ref: string, group: string): string | null {
  const prefix = `#/components/${group}/`;
  if (!ref.startsWith(prefix)) return null;
  return ref.slice(prefix.length).replaceAll("~1", "/").replaceAll("~0", "~");
}

function boundedText(value: string): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length <= MAX_DESCRIPTION_CHARACTERS
    ? normalized : `${normalized.slice(0, MAX_DESCRIPTION_CHARACTERS - 1)}…`;
}

function boundedExample(value: unknown): unknown {
  try {
    const serialized = JSON.stringify(value);
    if (serialized !== undefined && serialized.length <= 1_200) return value;
  } catch {
    // Generated examples should be JSON, but discovery must remain total.
  }
  return { omitted: true, reason: "example exceeds the 1200-character discovery bound" };
}

function shortValue(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) return String(value);
  return serialized.length <= 80 ? serialized : `${serialized.slice(0, 79)}…`;
}

function capitalize(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

function finiteNonnegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function firstFiniteNonnegativeInteger(...values: readonly unknown[]): number | null {
  for (const value of values) {
    const integer = finiteNonnegativeInteger(value);
    if (integer !== null) return integer;
  }
  return null;
}

function paginationHasMore(
  value: Readonly<Record<string, unknown>>,
  page: Readonly<Record<string, unknown>> | undefined,
): boolean | null {
  const directHasMore = firstBoolean(value.hasMore, page?.hasMore);
  if (directHasMore !== null) return directHasMore;

  const lastPage = firstBoolean(value.last, page?.last);
  if (lastPage !== null) return !lastPage;

  for (const links of [value._links, value.links, page?._links, page?.links]) {
    const linkedHasMore = hasNextLink(links);
    if (linkedHasMore !== null) return linkedHasMore;
  }

  const currentPage = firstFiniteNonnegativeInteger(
    page?.page,
    page?.number,
    typeof value.page === "number" ? value.page : undefined,
  );
  const totalPages = firstFiniteNonnegativeInteger(page?.totalPages, value.totalPages);
  if (currentPage !== null && totalPages !== null) {
    return currentPage + 1 < totalPages;
  }
  return null;
}

function firstBoolean(...values: readonly unknown[]): boolean | null {
  for (const value of values) {
    if (typeof value === "boolean") return value;
  }
  return null;
}

function hasNextLink(value: unknown): boolean | null {
  if (!isObject(value) || !Object.hasOwn(value, "next")) return null;
  if (value.next === null || value.next === undefined || value.next === false || value.next === "") {
    return false;
  }
  return true;
}

function kebab(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/gu, "$1-$2").replaceAll("_", "-").toLowerCase();
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
