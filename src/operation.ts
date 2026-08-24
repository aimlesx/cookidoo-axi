import {
  assertValidRequestBody,
  coerceAndValidateParameters,
  type CoercedParameters,
  type ManifestOperation,
} from "./api/spec.js";
import {
  prepareRequest,
  publicRequestView,
  type PreparedRequest,
} from "./api/request.js";
import { buildRequestBody } from "./cli/input.js";
import type { ParsedOperationInvocation } from "./cli/types.js";
import { UsageError } from "./errors.js";
import {
  assertValidCreatedRecipeTtsAnnotations,
  inferCreatedRecipeTtsAnnotations,
} from "./created-recipe-tts.js";
import {
  assertSafety,
  type SafetyDecision,
} from "./safety/policy.js";

export interface ResolvedOperationInvocation {
  readonly invocation: ParsedOperationInvocation;
  readonly parameters: CoercedParameters;
  readonly body: unknown;
  readonly request: PreparedRequest;
  readonly safety: SafetyDecision;
  readonly publicRequest: Record<string, unknown>;
}

export async function resolveOperationInvocation(
  invocation: ParsedOperationInvocation,
  baseUrl = "https://cookidoo.pl",
): Promise<ResolvedOperationInvocation> {
  const operation = invocation.operation;
  const manifestOperation = operation as unknown as ManifestOperation;
  let body = await buildRequestBody(
    invocation.bodyInput,
    invocation.bodyFields,
    (operation.requestBody?.required ?? false) && !invocation.inferThermomixSettings,
  );
  if (
    invocation.operationMode === "created-edit" && isObject(body) &&
    Object.hasOwn(body, "workStatus")
  ) {
    throw new UsageError(
      "PUBLICATION_COMMAND_REQUIRED",
      "created update cannot change workStatus",
      {
        suggestions: [
          "Use cookidoo-axi created publish <id> --dry-run",
          "Use cookidoo-axi created unpublish <id> --dry-run",
        ],
      },
    );
  }
  if (invocation.inferThermomixSettings) {
    body = inferCreatedRecipeTtsAnnotations(body);
  }
  if (operation.operationId === "patchCreatedRecipe") {
    assertValidCreatedRecipeTtsAnnotations(body);
  }
  const validatedBody = assertValidRequestBody(manifestOperation, body).value;

  const filters = Object.fromEntries(invocation.filters.map(({ key, value }) => [key, value]));
  const flat: Record<string, unknown> = {
    ...invocation.path,
    ...invocation.query,
    ...invocation.headers,
    ...(invocation.filters.length === 0 ? {} : { filters }),
  };
  const parameters = coerceAndValidateParameters(manifestOperation, flat, {
    applyDefaults: true,
    rejectUnknown: true,
  });
  const request = prepareRequest({
    operation,
    baseUrl,
    path: scalarRecord(parameters.path, "path"),
    query: queryRecord(parameters.query),
    filters: invocation.filters,
    headers: scalarRecord(parameters.header, "header"),
    body: validatedBody,
  });
  const safety = assertSafety(manifestOperation, {
    parameters,
    body: validatedBody,
    ...(invocation.options.confirm === undefined ? {} : { confirm: invocation.options.confirm }),
    ...(invocation.options.target === undefined ? {} : { target: invocation.options.target }),
    allowUnverified: invocation.options.allowUnverified,
    dryRun: invocation.options.dryRun,
  });
  return {
    invocation,
    parameters,
    body: validatedBody,
    request,
    safety,
    publicRequest: publicRequestView(request),
  };
}

function scalarRecord(
  value: Readonly<Record<string, unknown>>,
  location: string,
): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!["string", "number", "boolean"].includes(typeof entry)) {
      throw new UsageError(
        "INVALID_PARAMETERS",
        `The validated ${location} parameter '${key}' is not scalar`,
      );
    }
    output[key] = String(entry);
  }
  return output;
}

function queryRecord(
  value: Readonly<Record<string, unknown>>,
): Record<string, string | number | boolean> {
  const output: Record<string, string | number | boolean> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "filters") continue;
    if (typeof entry !== "string" && typeof entry !== "number" && typeof entry !== "boolean") {
      throw new UsageError(
        "INVALID_PARAMETERS",
        `The validated query parameter '${key}' is not scalar`,
      );
    }
    output[key] = entry;
  }
  return output;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
