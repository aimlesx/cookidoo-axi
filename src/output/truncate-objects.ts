import type { JsonValue } from "@toon-format/toon";

import { appendJsonPath, cloneJsonValue, createJsonObject, isJsonObject } from "./json-value.js";
import type { CollectionTruncation, ObjectTruncation } from "./types.js";
import { OutputBoundaryError } from "./types.js";

export interface ObjectTruncationResult {
  readonly value: JsonValue;
  readonly objects: readonly ObjectTruncation[];
}

export interface StructureTruncationResult extends ObjectTruncationResult {
  readonly collections: readonly CollectionTruncation[];
}

interface RankedEntry {
  readonly key: string;
  readonly value: JsonValue;
  readonly index: number;
  readonly rank: number;
}

/**
 * Bound every JSON object while retaining the most agent-useful identity and
 * discriminator keys first. Ties retain provider insertion order.
 */
export function truncateJsonObjects(
  value: JsonValue,
  maximumKeys: number,
  rootPath = "$",
): ObjectTruncationResult {
  if (!Number.isSafeInteger(maximumKeys) || maximumKeys < 1) {
    throw new OutputBoundaryError(
      "OUTPUT_INVALID_OPTION",
      "Object key limit must be a positive safe integer",
    );
  }
  const objects: ObjectTruncation[] = [];
  return {
    value: truncateValue(value, maximumKeys, undefined, true, rootPath, objects, []),
    objects,
  };
}

/** Bound arrays and objects in one traversal so omitted branches do not create metadata. */
export function truncateJsonStructures(
  value: JsonValue,
  maximumItems: number,
  maximumKeys: number,
  rootPath = "$",
  truncateRootArray = true,
): StructureTruncationResult {
  if (!Number.isSafeInteger(maximumItems) || maximumItems < 1) {
    throw new OutputBoundaryError(
      "OUTPUT_INVALID_OPTION",
      "Array item limit must be a positive safe integer",
    );
  }
  if (!Number.isSafeInteger(maximumKeys) || maximumKeys < 1) {
    throw new OutputBoundaryError(
      "OUTPUT_INVALID_OPTION",
      "Object key limit must be a positive safe integer",
    );
  }
  const objects: ObjectTruncation[] = [];
  const collections: CollectionTruncation[] = [];
  return {
    value: truncateValue(
      value,
      maximumKeys,
      maximumItems,
      truncateRootArray,
      rootPath,
      objects,
      collections,
    ),
    objects,
    collections,
  };
}

function truncateValue(
  value: JsonValue,
  maximumKeys: number,
  maximumItems: number | undefined,
  truncateArrayHere: boolean,
  path: string,
  objects: ObjectTruncation[],
  collections: CollectionTruncation[],
): JsonValue {
  if (Array.isArray(value)) {
    const selected = maximumItems === undefined || !truncateArrayHere
      ? value : value.slice(0, maximumItems);
    if (selected.length < value.length) {
      collections.push({
        path,
        shownItems: selected.length,
        totalItems: value.length,
      });
    }
    return selected.map((item, index) => truncateValue(
      item,
      maximumKeys,
      maximumItems,
      true,
      appendJsonPath(path, index),
      objects,
      collections,
    ));
  }
  if (!isJsonObject(value)) return cloneJsonValue(value);

  const entries: RankedEntry[] = Object.entries(value).map(([key, item], index) => ({
    key,
    value: item,
    index,
    rank: keyPriority(key),
  }));
  const selected = entries.length <= maximumKeys
    ? entries
    : [...entries]
        .sort((left, right) => left.rank - right.rank || left.index - right.index)
        .slice(0, maximumKeys);
  if (selected.length < entries.length) {
    objects.push({ path, shownKeys: selected.length, totalKeys: entries.length });
  }

  const output = createJsonObject();
  for (const entry of selected) {
    output[entry.key] = truncateValue(
      entry.value,
      maximumKeys,
      maximumItems,
      true,
      appendJsonPath(path, entry.key),
      objects,
      collections,
    );
  }
  return output;
}

function keyPriority(key: string): number {
  if (/^(?:id|_id|uuid|ulid)$/iu.test(key)) return 0;
  if (/(?:Id|ID|[_-]id)$/u.test(key)) return 1;
  if (/^(?:@type|__typename|kind|type|entityType|resourceType)$/iu.test(key)) return 2;
  if (/^(?:status|state|workStatus)$/iu.test(key)) return 3;
  return 4;
}
