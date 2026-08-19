import type { JsonArray, JsonObject, JsonValue } from "@toon-format/toon";

import { OutputBoundaryError } from "./types.js";

export function createJsonObject(): Record<string, JsonValue> {
  return Object.create(null) as Record<string, JsonValue>;
}

export function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function appendJsonPath(path: string, key: string | number): string {
  if (typeof key === "number") {
    return `${path}[${key}]`;
  }

  if (/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) {
    return `${path}.${key}`;
  }

  const escaped = key.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  return `${path}["${escaped}"]`;
}

export function assertValidUnicode(value: string, path = "$"): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new OutputBoundaryError(
          "OUTPUT_INVALID_VALUE",
          `Unpaired high surrogate in string at ${path}`,
        );
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new OutputBoundaryError(
        "OUTPUT_INVALID_VALUE",
        `Unpaired low surrogate in string at ${path}`,
      );
    }
  }
}

/** Replaces malformed UTF-16 only for best-effort human diagnostics. */
export function replaceInvalidUnicode(value: string): string {
  let result = "";

  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        result += value[index] ?? "";
        result += value[index + 1] ?? "";
        index += 1;
      } else {
        result += "\ufffd";
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      result += "\ufffd";
    } else {
      result += value[index] ?? "";
    }
  }

  return result;
}

export function toJsonValue(input: unknown, path = "$"): JsonValue {
  return convertJsonValue(input, path, new WeakSet<object>());
}

function convertJsonValue(
  input: unknown,
  path: string,
  ancestors: WeakSet<object>,
): JsonValue {
  if (input === null || typeof input === "boolean") {
    return input;
  }

  if (typeof input === "string") {
    assertValidUnicode(input, path);
    return input;
  }

  if (typeof input === "number") {
    if (!Number.isFinite(input)) {
      throw new OutputBoundaryError(
        "OUTPUT_INVALID_VALUE",
        `Non-finite number at ${path}; output must use the JSON data model`,
      );
    }
    return Object.is(input, -0) ? 0 : input;
  }

  if (typeof input !== "object") {
    throw new OutputBoundaryError(
      "OUTPUT_INVALID_VALUE",
      `Unsupported ${typeof input} value at ${path}; output must be JSON-like`,
    );
  }

  if (ancestors.has(input)) {
    throw new OutputBoundaryError(
      "OUTPUT_INVALID_VALUE",
      `Circular reference at ${path}`,
    );
  }

  ancestors.add(input);
  try {
    if (Array.isArray(input)) {
      const output: JsonValue[] = [];
      for (let index = 0; index < input.length; index += 1) {
        if (!(index in input)) {
          throw new OutputBoundaryError(
            "OUTPUT_INVALID_VALUE",
            `Sparse array slot at ${appendJsonPath(path, index)}`,
          );
        }
        output.push(
          convertJsonValue(input[index], appendJsonPath(path, index), ancestors),
        );
      }
      return output;
    }

    const prototype = Object.getPrototypeOf(input) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new OutputBoundaryError(
        "OUTPUT_INVALID_VALUE",
        `Non-plain object at ${path}; normalize it before the output boundary`,
      );
    }

    const symbolKeys = Object.getOwnPropertySymbols(input).filter((key) =>
      Object.prototype.propertyIsEnumerable.call(input, key),
    );
    if (symbolKeys.length > 0) {
      throw new OutputBoundaryError(
        "OUTPUT_INVALID_VALUE",
        `Enumerable symbol key at ${path}; output keys must be strings`,
      );
    }

    const output = createJsonObject();
    const descriptors = Object.getOwnPropertyDescriptors(input);
    for (const key of Object.keys(input)) {
      assertValidUnicode(key, `${path} (object key)`);
      const descriptor = descriptors[key];
      if (descriptor === undefined || !("value" in descriptor)) {
        throw new OutputBoundaryError(
          "OUTPUT_INVALID_VALUE",
          `Accessor property at ${appendJsonPath(path, key)} is not allowed`,
        );
      }
      output[key] = convertJsonValue(
        descriptor.value,
        appendJsonPath(path, key),
        ancestors,
      );
    }
    return output;
  } finally {
    ancestors.delete(input);
  }
}

export function cloneJsonValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map((item) => cloneJsonValue(item)) as JsonArray;
  }
  if (isJsonObject(value)) {
    const output = createJsonObject();
    for (const [key, item] of Object.entries(value)) {
      output[key] = cloneJsonValue(item);
    }
    return output;
  }
  return value;
}

/** JSON-model equality; object key order is intentionally insignificant. */
export function jsonValuesEqual(left: JsonValue, right: JsonValue): boolean {
  if (typeof left !== "object" || left === null) {
    return Object.is(left, right) || left === right;
  }
  if (typeof right !== "object" || right === null) {
    return false;
  }

  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    return left.every((item, index) => {
      const rightItem = right[index];
      return rightItem !== undefined && jsonValuesEqual(item, rightItem);
    });
  }

  if (!isJsonObject(left) || !isJsonObject(right)) {
    return false;
  }

  const leftEntries = Object.entries(left);
  const rightKeys = Object.keys(right);
  if (leftEntries.length !== rightKeys.length) {
    return false;
  }

  return leftEntries.every(([key, value]) => {
    if (!Object.prototype.hasOwnProperty.call(right, key)) {
      return false;
    }
    const rightValue = right[key];
    return rightValue !== undefined && jsonValuesEqual(value, rightValue);
  });
}
