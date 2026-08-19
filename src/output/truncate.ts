import type { JsonValue } from "@toon-format/toon";

import {
  appendJsonPath,
  cloneJsonValue,
  createJsonObject,
  isJsonObject,
} from "./json-value.js";
import type { ContentTruncation } from "./types.js";
import { OutputBoundaryError } from "./types.js";

const DEFAULT_PROTECTED_VALUES = ["[REDACTED]"];

export interface StringTruncationResult {
  readonly value: JsonValue;
  readonly fields: readonly ContentTruncation[];
}

export function truncateJsonStrings(
  value: JsonValue,
  maxCharacters: number,
  rootPath = "$",
  protectedValues: readonly string[] = DEFAULT_PROTECTED_VALUES,
): StringTruncationResult {
  if (!Number.isSafeInteger(maxCharacters) || maxCharacters < 1) {
    throw new OutputBoundaryError(
      "OUTPUT_INVALID_OPTION",
      "String preview limit must be a positive safe integer",
    );
  }

  const fields: ContentTruncation[] = [];
  return {
    value: truncateValue(value, maxCharacters, rootPath, fields, new Set(protectedValues)),
    fields,
  };
}

function truncateValue(
  value: JsonValue,
  maxCharacters: number,
  path: string,
  fields: ContentTruncation[],
  protectedValues: ReadonlySet<string>,
): JsonValue {
  if (typeof value === "string") {
    if (protectedValues.has(value)) {
      return value;
    }
    const characters = Array.from(value);
    if (characters.length <= maxCharacters) {
      return value;
    }

    const retained = Math.max(0, maxCharacters - 1);
    fields.push({
      path,
      shownCharacters: retained,
      totalCharacters: characters.length,
    });
    return `${characters.slice(0, retained).join("")}…`;
  }

  if (Array.isArray(value)) {
    return value.map((item, index) =>
      truncateValue(
        item,
        maxCharacters,
        appendJsonPath(path, index),
        fields,
        protectedValues,
      ),
    );
  }

  if (isJsonObject(value)) {
    const output = createJsonObject();
    for (const [key, item] of Object.entries(value)) {
      output[key] = truncateValue(
        item,
        maxCharacters,
        appendJsonPath(path, key),
        fields,
        protectedValues,
      );
    }
    return output;
  }

  return cloneJsonValue(value);
}
