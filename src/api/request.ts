import { UsageError } from "../errors.js";
import type { OperationDescriptor } from "../cli/types.js";

export interface PreparedRequest {
  operationId: string;
  method: OperationDescriptor["method"];
  url: URL;
  headers: Record<string, string>;
  body?: string;
}

export function prepareRequest(input: {
  operation: OperationDescriptor;
  baseUrl: string;
  path: Record<string, string>;
  query: Record<string, string | number | boolean>;
  filters: Array<{ key: string; value: string }>;
  headers: Record<string, string>;
  body: unknown;
}): PreparedRequest {
  const { operation } = input;
  assertBaseUrl(input.baseUrl);
  let renderedPath = operation.path;
  for (const parameter of operation.parameters.filter((candidate) => candidate.in === "path")) {
    const value = input.path[parameter.name];
    if ((value === undefined || value === "") && parameter.required) {
      throw new UsageError("MISSING_PATH_PARAMETER", `Missing path parameter: ${parameter.name}`);
    }
    if (value !== undefined) {
      renderedPath = renderedPath.replace(`{${parameter.name}}`, encodeURIComponent(value));
    }
  }
  if (/\{[^}]+\}/.test(renderedPath)) {
    throw new UsageError("MISSING_PATH_PARAMETER", `Unresolved path template: ${renderedPath}`);
  }

  const url = new URL(renderedPath, normalizedBaseUrl(input.baseUrl));
  for (const [key, value] of Object.entries(input.query)) {
    url.searchParams.set(key, String(value));
  }
  const filterContract = searchFilterContract(operation);
  const emittedFilters = new Set<string>();
  for (const { key, value } of input.filters) {
    if (
      !filterContract.names.has(key) &&
      (!filterContract.extensible || !isSafeExtensionFilterName(key))
    ) {
      throw new UsageError("UNKNOWN_FILTER", "Unknown or unsafe search filter name", {
        suggestions: filterContract.names.size
          ? [`Advertised filters: ${[...filterContract.names].sort().join(", ")}`]
          : undefined
      });
    }
    if (url.searchParams.has(key)) {
      throw new UsageError("DUPLICATE_QUERY", "A query key was supplied both directly and through --filter");
    }
    if (emittedFilters.has(key)) {
      throw new UsageError("DUPLICATE_QUERY", "A search filter was supplied more than once");
    }
    emittedFilters.add(key);
    url.searchParams.set(key, value);
  }

  const headers: Record<string, string> = {
    Accept: preferredAccept(operation),
    ...input.headers
  };
  const prepared: PreparedRequest = {
    operationId: operation.operationId,
    method: operation.method,
    url,
    headers
  };
  if (input.body !== undefined) {
    headers["Content-Type"] = preferredRequestMedia(operation);
    prepared.body = JSON.stringify(input.body);
  }
  return prepared;
}

export function publicRequestView(request: PreparedRequest): Record<string, unknown> {
  return {
    operation: request.operationId,
    method: request.method,
    url: request.url.toString(),
    headers: Object.fromEntries(
      Object.entries(request.headers).filter(([name]) => !isSecretHeader(name))
    ),
    ...(request.body === undefined ? {} : { body: safeParse(request.body) })
  };
}

function preferredRequestMedia(operation: OperationDescriptor): string {
  if (!operation.requestBody) return "application/json";
  const mediaTypes = Object.keys(operation.requestBody.content);
  return mediaTypes.find((mediaType) => mediaType === "application/json") ?? mediaTypes[0] ?? "application/json";
}

function preferredAccept(operation: OperationDescriptor): string {
  const successes = Object.entries(operation.responses)
    .filter(([status]) => /^2\d\d$/.test(status) || status === "default")
    .map(([, response]) => response)
    .filter(isObject);
  const mediaTypes = successes.flatMap((response) => {
    const content = response.content;
    return isObject(content) ? Object.keys(content) : [];
  });
  return mediaTypes.find((mediaType) => mediaType.startsWith("application/vnd.")) ??
    mediaTypes.find((mediaType) => mediaType.includes("json")) ??
    "application/json";
}

function searchFilterContract(operation: OperationDescriptor): {
  names: Set<string>;
  extensible: boolean;
} {
  const filter = operation.parameters.find(
    (parameter) => parameter.in === "query" && parameter.name === "filters"
  );
  if (!filter) return { names: new Set(), extensible: false };
  const properties = isObject(filter.schema.properties) ? filter.schema.properties : {};
  return {
    names: new Set(Object.keys(properties)),
    extensible: filter.schema.additionalProperties !== undefined &&
      filter.schema.additionalProperties !== false,
  };
}

function isSafeExtensionFilterName(value: string): boolean {
  return value.length > 0 && value.length <= 128 && !/[\p{Cc}\p{Cs}=&?#]/u.test(value) &&
    !["__proto__", "prototype", "constructor"].includes(value);
}

function assertBaseUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new UsageError("INVALID_BASE_URL", "Cookidoo base URL is invalid");
  }
  if (url.protocol !== "https:" || url.hostname !== "cookidoo.pl" || url.username || url.password) {
    throw new UsageError(
      "UNSAFE_BASE_URL",
      "This build supports only https://cookidoo.pl and will not send credentials elsewhere"
    );
  }
}

function normalizedBaseUrl(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function isSecretHeader(name: string): boolean {
  return /^(?:authorization|cookie|set-cookie|x-csrf-token)$/i.test(name);
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return "<unparseable>";
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
