import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { stdin } from "node:process";
import { UsageError } from "../errors.js";

const MAX_BODY_BYTES = 1_000_000;

export async function buildRequestBody(
  bodyInput: string | undefined,
  fields: Array<{
    path: string;
    value: string;
    array: boolean;
    schema?: Record<string, unknown>;
    flag?: string;
  }>,
  required: boolean
): Promise<unknown> {
  if (bodyInput !== undefined) return parseJson(await readBodyInput(bodyInput), "request body");
  if (fields.length === 0) {
    if (required) throw new UsageError("MISSING_BODY", "This operation requires a JSON body", {
      suggestions: ["Use --data @request.json, --data -, --set key=value, or a schema property flag"]
    });
    return undefined;
  }
  const body: Record<string, unknown> = {};
  for (const field of fields) {
    const value = field.schema === undefined
      ? parseLooseValue(field.value)
      : parseSchemaValue(field.value, field.schema, field.flag ?? `--${field.path}`);
    if (field.array) appendArrayPath(body, field.path, value);
    else setPath(body, field.path, value);
  }
  return body;
}

function parseSchemaValue(
  raw: string,
  schema: Record<string, unknown>,
  flag: string,
): unknown {
  if (schemaIncludesType(schema, "array")) {
    const trimmed = raw.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      const parsed = parseJsonForFlag(trimmed, flag, "a JSON array");
      if (!Array.isArray(parsed)) throw invalidFieldValue(flag, "a JSON array");
      return parsed;
    }
    const arraySchema = schemaBranchForType(schema, "array");
    const itemSchema = isPlainObject(arraySchema?.items)
      ? arraySchema.items as Record<string, unknown>
      : undefined;
    return itemSchema === undefined
      ? parseLooseValue(raw, flag)
      : parseSchemaScalar(raw, itemSchema, flag);
  }
  return parseSchemaScalar(raw, schema, flag);
}

function parseSchemaScalar(
  raw: string,
  schema: Record<string, unknown>,
  flag: string,
): unknown {
  // A union that permits a string must preserve the caller's exact bytes;
  // otherwise string-looking JSON literals cannot be represented faithfully.
  if (schemaIncludesType(schema, "string")) return raw;
  if (schemaIncludesType(schema, "integer")) {
    if (!/^-?(?:0|[1-9]\d*)$/u.test(raw)) throw invalidFieldValue(flag, "an integer");
    const value = Number(raw);
    if (!Number.isSafeInteger(value)) throw invalidFieldValue(flag, "a safe integer");
    return value;
  }
  if (schemaIncludesType(schema, "number")) {
    if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/u.test(raw)) {
      throw invalidFieldValue(flag, "a finite number");
    }
    const value = Number(raw);
    if (!Number.isFinite(value)) throw invalidFieldValue(flag, "a finite number");
    return value;
  }
  if (schemaIncludesType(schema, "boolean")) {
    if (raw === "true") return true;
    if (raw === "false") return false;
    throw invalidFieldValue(flag, "true or false");
  }
  if (schemaIncludesType(schema, "object")) {
    const parsed = parseJsonForFlag(raw, flag, "a JSON object");
    if (!isPlainObject(parsed)) throw invalidFieldValue(flag, "a JSON object");
    return parsed;
  }
  if (schemaIncludesType(schema, "null")) {
    if (raw === "null") return null;
    throw invalidFieldValue(flag, "null");
  }
  return parseLooseValue(raw, flag);
}

function parseJsonForFlag(input: string, flag: string, expected: string): unknown {
  try {
    return JSON.parse(input);
  } catch {
    throw invalidFieldValue(flag, expected);
  }
}

function invalidFieldValue(flag: string, expected: string): UsageError {
  return new UsageError(
    "INVALID_VALUE",
    `Invalid value for ${flag}: expected ${expected}`,
    { details: { flag } },
  );
}

function schemaIncludesType(schema: Record<string, unknown>, type: string): boolean {
  if (schema.type === type) return true;
  if (Array.isArray(schema.type) && schema.type.includes(type)) return true;
  return ["oneOf", "anyOf"].some((key) =>
    Array.isArray(schema[key]) && (schema[key] as unknown[]).some((entry) =>
      isPlainObject(entry) && schemaIncludesType(entry, type)));
}

function schemaBranchForType(
  schema: Record<string, unknown>,
  type: string,
): Record<string, unknown> | undefined {
  if (schema.type === type || (Array.isArray(schema.type) && schema.type.includes(type))) {
    return schema;
  }
  for (const key of ["oneOf", "anyOf"] as const) {
    if (!Array.isArray(schema[key])) continue;
    for (const entry of schema[key]) {
      if (!isPlainObject(entry)) continue;
      const match = schemaBranchForType(entry, type);
      if (match !== undefined) return match;
    }
  }
  return undefined;
}

async function readBodyInput(input: string): Promise<string> {
  if (input === "-") return readStdinBounded();
  if (input.startsWith("@")) {
    const path = resolve(input.slice(1));
    const content = await readFile(path, "utf8");
    if (Buffer.byteLength(content) > MAX_BODY_BYTES) {
      throw new UsageError("BODY_TOO_LARGE", `Request body exceeds ${MAX_BODY_BYTES} bytes`);
    }
    return content;
  }
  if (Buffer.byteLength(input) > MAX_BODY_BYTES) {
    throw new UsageError("BODY_TOO_LARGE", `Request body exceeds ${MAX_BODY_BYTES} bytes`);
  }
  return input;
}

async function readStdinBounded(): Promise<string> {
  stdin.setEncoding("utf8");
  let result = "";
  for await (const chunk of stdin) {
    result += chunk;
    if (Buffer.byteLength(result) > MAX_BODY_BYTES) {
      throw new UsageError("BODY_TOO_LARGE", `stdin body exceeds ${MAX_BODY_BYTES} bytes`);
    }
  }
  return result;
}

function parseJson(input: string, label: string): unknown {
  try {
    return JSON.parse(input);
  } catch {
    // Native JSON.parse diagnostics may quote source fragments. Keep the
    // public error fixed so malformed input can never echo a credential.
    throw new UsageError("INVALID_JSON", `${label} is not valid JSON`);
  }
}

function parseLooseValue(value: string, flag?: string): unknown {
  const trimmed = value.trim();
  if (/^(?:true|false|null|-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)$/i.test(trimmed)) {
    return JSON.parse(trimmed);
  }
  if ((trimmed.startsWith("[") && trimmed.endsWith("]")) ||
      (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith('"') && trimmed.endsWith('"'))) {
    return flag === undefined
      ? parseJson(trimmed, "body field")
      : parseJsonForFlag(trimmed, flag, "valid JSON");
  }
  return value;
}

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split(".").filter(Boolean);
  if (segments.length === 0 || segments.some(isUnsafeKey)) {
    throw new UsageError("INVALID_BODY_PATH", `Unsafe or empty body path: ${path}`);
  }
  let current = target;
  for (const segment of segments.slice(0, -1)) {
    const existing = current[segment];
    if (existing !== undefined && (!isPlainObject(existing))) {
      throw new UsageError("BODY_PATH_CONFLICT", `Body path conflicts at: ${segment}`);
    }
    const next = isPlainObject(existing) ? existing : {};
    current[segment] = next;
    current = next;
  }
  current[segments.at(-1) as string] = value;
}

function appendArrayPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split(".").filter(Boolean);
  const key = segments.at(-1);
  if (!key || segments.some(isUnsafeKey)) throw new UsageError("INVALID_BODY_PATH", `Unsafe body path: ${path}`);
  const parentPath = segments.slice(0, -1).join(".");
  let parent: Record<string, unknown> = target;
  if (parentPath) {
    parent = ensureObjectPath(target, segments.slice(0, -1), path);
  }
  const existing = parent[key];
  if (existing !== undefined && !Array.isArray(existing)) {
    throw new UsageError("BODY_PATH_CONFLICT", `Expected array body field: ${path}`);
  }
  const values = Array.isArray(value) ? value : [value];
  parent[key] = [...(existing ?? []), ...values];
}

function ensureObjectPath(
  target: Record<string, unknown>,
  segments: string[],
  fullPath: string
): Record<string, unknown> {
  let current = target;
  for (const segment of segments) {
    const existing = current[segment];
    if (existing !== undefined && !isPlainObject(existing)) {
      throw new UsageError("BODY_PATH_CONFLICT", `Body path conflicts at: ${fullPath}`);
    }
    const next = isPlainObject(existing) ? existing : {};
    current[segment] = next;
    current = next;
  }
  return current;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUnsafeKey(value: string): boolean {
  return value === "__proto__" || value === "prototype" || value === "constructor";
}
