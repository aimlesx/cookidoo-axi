import type { JsonValue } from "@toon-format/toon";

import { appendJsonPath, cloneJsonValue, createJsonObject, isJsonObject } from "./json-value.js";
import type { CollectionTruncation } from "./types.js";
import { OutputBoundaryError } from "./types.js";

export interface ArrayTruncationResult {
  readonly value: JsonValue;
  readonly collections: readonly CollectionTruncation[];
}

/** Bound every JSON array while preserving an explicit path/count audit trail. */
export function truncateJsonArrays(
  value: JsonValue,
  maximumItems: number,
  rootPath = "$",
  truncateRoot = true,
): ArrayTruncationResult {
  if (!Number.isSafeInteger(maximumItems) || maximumItems < 1) {
    throw new OutputBoundaryError(
      "OUTPUT_INVALID_OPTION",
      "Array item limit must be a positive safe integer",
    );
  }
  const collections: CollectionTruncation[] = [];
  return {
    value: truncateValue(value, maximumItems, rootPath, truncateRoot, collections),
    collections,
  };
}

function truncateValue(
  value: JsonValue,
  maximumItems: number,
  path: string,
  truncateHere: boolean,
  collections: CollectionTruncation[],
): JsonValue {
  if (Array.isArray(value)) {
    const selected = truncateHere ? value.slice(0, maximumItems) : value;
    if (selected.length < value.length) {
      collections.push({
        path,
        shownItems: selected.length,
        totalItems: value.length,
      });
    }
    return selected.map((item, index) => truncateValue(
      item,
      maximumItems,
      appendJsonPath(path, index),
      true,
      collections,
    ));
  }
  if (!isJsonObject(value)) return cloneJsonValue(value);
  const output = createJsonObject();
  for (const [key, item] of Object.entries(value)) {
    output[key] = truncateValue(
      item,
      maximumItems,
      appendJsonPath(path, key),
      true,
      collections,
    );
  }
  return output;
}
