import type { JsonValue } from "@toon-format/toon";

import {
  cloneJsonValue,
  createJsonObject,
  isJsonObject,
} from "./json-value.js";
import { OutputBoundaryError } from "./types.js";

export type FieldSelectionInput = string | readonly string[];

export interface ParsedFieldSelection {
  readonly requested: readonly string[];
  readonly paths: readonly (readonly string[])[];
}

export interface FieldSelectionResult {
  readonly value: JsonValue;
  readonly requested: readonly string[];
  readonly missing: readonly string[];
}

interface SelectionNode {
  terminal: boolean;
  readonly children: Map<string, SelectionNode>;
}

export function parseFieldSelection(input: FieldSelectionInput): ParsedFieldSelection {
  const source = typeof input === "string" ? [input] : input;
  const requested: string[] = [];
  const paths: string[][] = [];
  const seen = new Set<string>();

  for (const entry of source) {
    for (const candidate of entry.split(",")) {
      const field = candidate.trim();
      if (field.length === 0) {
        continue;
      }
      if (/\p{Cc}/u.test(field)) {
        throw new OutputBoundaryError(
          "OUTPUT_INVALID_OPTION",
          "Field selections cannot contain control characters",
        );
      }
      const segments = field.split(".");
      if (segments.some((segment) => segment.length === 0)) {
        throw new OutputBoundaryError(
          "OUTPUT_INVALID_OPTION",
          `Invalid field path "${field}"; empty path segments are not allowed`,
        );
      }
      const canonical = segments.join(".");
      if (!seen.has(canonical)) {
        seen.add(canonical);
        requested.push(canonical);
        paths.push(segments);
      }
    }
  }

  if (requested.length === 0) {
    throw new OutputBoundaryError(
      "OUTPUT_INVALID_OPTION",
      "Field selection is empty; pass one or more comma-separated field paths",
    );
  }

  return { requested, paths };
}

export function selectFields(
  value: JsonValue,
  input: FieldSelectionInput | ParsedFieldSelection,
): FieldSelectionResult {
  const selection = isParsedSelection(input) ? input : parseFieldSelection(input);
  const root = createSelectionNode();
  for (const path of selection.paths) {
    addSelectionPath(root, path);
  }

  const projected = projectValue(value, root);
  const missing = selection.paths
    .filter((path) => !pathExists(value, path, 0))
    .map((path) => path.join("."));

  return {
    value: projected.matched ? projected.value : emptyProjection(value),
    requested: [...selection.requested],
    missing,
  };
}

function isParsedSelection(
  input: FieldSelectionInput | ParsedFieldSelection,
): input is ParsedFieldSelection {
  return typeof input === "object" && !Array.isArray(input) && "paths" in input;
}

function createSelectionNode(): SelectionNode {
  return { terminal: false, children: new Map<string, SelectionNode>() };
}

function addSelectionPath(root: SelectionNode, path: readonly string[]): void {
  let current = root;
  for (const segment of path) {
    let next = current.children.get(segment);
    if (next === undefined) {
      next = createSelectionNode();
      current.children.set(segment, next);
    }
    current = next;
  }
  current.terminal = true;
}

function projectValue(
  value: JsonValue,
  selection: SelectionNode,
): { readonly matched: boolean; readonly value: JsonValue } {
  if (selection.terminal) {
    return { matched: true, value: cloneJsonValue(value) };
  }

  if (Array.isArray(value)) {
    let matched = false;
    const output = value.map((item) => {
      const projected = projectValue(item, selection);
      matched ||= projected.matched;
      return projected.matched ? projected.value : emptyProjection(item);
    });
    return { matched, value: output };
  }

  if (!isJsonObject(value)) {
    return { matched: false, value: createJsonObject() };
  }

  let matched = false;
  const output = createJsonObject();
  for (const [key, childSelection] of selection.children) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      continue;
    }
    const item = value[key];
    if (item === undefined) {
      continue;
    }
    const projected = projectValue(item, childSelection);
    if (projected.matched) {
      matched = true;
      output[key] = projected.value;
    }
  }
  return { matched, value: output };
}

function emptyProjection(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map((item) => emptyProjection(item));
  }
  return createJsonObject();
}

function pathExists(
  value: JsonValue,
  path: readonly string[],
  index: number,
): boolean {
  if (index >= path.length) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.some((item) => pathExists(item, path, index));
  }
  if (!isJsonObject(value)) {
    return false;
  }
  const segment = path[index];
  if (segment === undefined || !Object.prototype.hasOwnProperty.call(value, segment)) {
    return false;
  }
  const child = value[segment];
  return child !== undefined && pathExists(child, path, index + 1);
}
