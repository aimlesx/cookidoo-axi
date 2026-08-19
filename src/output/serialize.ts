import type { Delimiter, JsonValue } from "@toon-format/toon";
import { decode, encode } from "@toon-format/toon";

import {
  assertValidUnicode,
  jsonValuesEqual,
  toJsonValue,
} from "./json-value.js";
import type { OutputFormat, SerializedOutput } from "./types.js";
import { OutputBoundaryError } from "./types.js";

export const TOON_SPEC_VERSION = "4.1";
export const TOON_PACKAGE_VERSION = "4.1.1";

export interface SerializeOutputOptions {
  readonly format?: OutputFormat;
  readonly delimiter?: Delimiter;
}

/**
 * The sole structured-output boundary. Input stays JSON-like until this call;
 * TOON is always decoded again in strict mode before it can reach stdout.
 */
export function serializeOutput(
  input: unknown,
  options: SerializeOutputOptions = {},
): SerializedOutput {
  const normalized = toJsonValue(input);
  const format = options.format ?? "toon";

  if (format === "json") {
    return serializeJson(normalized);
  }
  if (format !== "toon") {
    throw new OutputBoundaryError(
      "OUTPUT_INVALID_OPTION",
      `Unsupported output format: ${String(format)}`,
    );
  }
  return serializeToon(normalized, options.delimiter ?? ",");
}

export function assertSerializedDocument(output: SerializedOutput): void {
  const { text } = output;
  if (text.endsWith("\n") || text.endsWith("\r")) {
    throw new OutputBoundaryError(
      "OUTPUT_INVALID_DOCUMENT",
      "Serialized output must not contain a terminal newline",
    );
  }
  if (text.includes("\r")) {
    throw new OutputBoundaryError(
      "OUTPUT_INVALID_DOCUMENT",
      "Serialized output must use LF line endings",
    );
  }
  const lineWithTrailingSpace = text
    .split("\n")
    .findIndex((line) => /[ \t]+$/u.test(line));
  if (lineWithTrailingSpace >= 0) {
    throw new OutputBoundaryError(
      "OUTPUT_INVALID_DOCUMENT",
      `Serialized output contains trailing whitespace on line ${lineWithTrailingSpace + 1}`,
    );
  }

  try {
    assertValidUnicode(text, "serialized output");
  } catch (error) {
    throw new OutputBoundaryError(
      "OUTPUT_INVALID_DOCUMENT",
      "Serialized output contains malformed Unicode",
      { cause: error },
    );
  }
}

function serializeToon(input: JsonValue, delimiter: Delimiter): SerializedOutput {
  if (delimiter !== "," && delimiter !== "\t" && delimiter !== "|") {
    throw new OutputBoundaryError(
      "OUTPUT_INVALID_OPTION",
      "TOON delimiter must be comma, tab, or pipe",
    );
  }

  let text: string;
  try {
    text = encode(input, { delimiter, indentSize: 2 });
  } catch (error) {
    throw new OutputBoundaryError(
      "OUTPUT_SERIALIZATION_FAILED",
      "TOON encoding failed",
      { cause: error },
    );
  }

  const output: SerializedOutput = { format: "toon", text };
  assertSerializedDocument(output);

  let decoded: JsonValue;
  try {
    decoded = decode(text, { indentSize: 2, strict: true });
  } catch (error) {
    throw new OutputBoundaryError(
      "OUTPUT_ROUND_TRIP_FAILED",
      "Strict TOON validation rejected encoded output",
      { cause: error },
    );
  }
  if (!jsonValuesEqual(input, decoded)) {
    throw new OutputBoundaryError(
      "OUTPUT_ROUND_TRIP_FAILED",
      "Strict TOON round trip changed the JSON value",
    );
  }

  return output;
}

function serializeJson(input: JsonValue): SerializedOutput {
  let text: string;
  try {
    text = JSON.stringify(input);
  } catch (error) {
    throw new OutputBoundaryError(
      "OUTPUT_SERIALIZATION_FAILED",
      "JSON encoding failed",
      { cause: error },
    );
  }

  const output: SerializedOutput = { format: "json", text };
  assertSerializedDocument(output);

  try {
    const decoded = toJsonValue(JSON.parse(text) as unknown);
    if (!jsonValuesEqual(input, decoded)) {
      throw new OutputBoundaryError(
        "OUTPUT_ROUND_TRIP_FAILED",
        "JSON round trip changed the JSON value",
      );
    }
  } catch (error) {
    if (error instanceof OutputBoundaryError) {
      throw error;
    }
    throw new OutputBoundaryError(
      "OUTPUT_ROUND_TRIP_FAILED",
      "JSON validation rejected encoded output",
      { cause: error },
    );
  }

  return output;
}
