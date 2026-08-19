import type { JsonArray, JsonValue } from "@toon-format/toon";

export type OutputFormat = "toon" | "json";

export type CompletenessState = "empty" | "complete" | "partial" | "unknown";

export interface CompletenessMetadata {
  readonly state: CompletenessState;
  readonly shown: number;
  readonly total: number | null;
  readonly hasMore: boolean | null;
}

export interface ContentTruncation {
  /** JSONPath-like location within the emitted envelope. */
  readonly path: string;
  /** Unicode code points retained from the original value. */
  readonly shownCharacters: number;
  /** Unicode code points in the original value. */
  readonly totalCharacters: number;
}

export interface CollectionTruncation {
  /** JSONPath-like location of a locally bounded array. */
  readonly path: string;
  readonly shownItems: number;
  readonly totalItems: number;
}

export interface ObjectTruncation {
  /** JSONPath-like location of a locally bounded object/map. */
  readonly path: string;
  readonly shownKeys: number;
  readonly totalKeys: number;
}

export type TruncationMode =
  | "none"
  | "collection"
  | "content"
  | "object"
  | "collection-and-content"
  | "mixed";

export interface TruncationMetadata {
  readonly applied: boolean;
  readonly mode: TruncationMode;
  /** Effective local item limit, or null when --full bypassed it. */
  readonly itemLimit: number | null;
  /** Items available to the output boundary before local truncation. */
  readonly availableItems: number | null;
  /** Items hidden locally; this does not include un-fetched upstream pages. */
  readonly omittedItems: number;
  /** Effective per-object key limit, or null when --full bypassed it. */
  readonly objectLimit: number | null;
  /** Object properties hidden locally across data and context. */
  readonly omittedProperties: number;
  /** Effective per-string preview limit, or null when --full bypassed it. */
  readonly contentLimit: number | null;
  readonly fields: readonly ContentTruncation[];
  /** Nested/root arrays bounded locally, with exact original counts. */
  readonly collections: readonly CollectionTruncation[];
  /** Objects/maps bounded locally, with exact original key counts. */
  readonly objects: readonly ObjectTruncation[];
  /** Exact command that bypasses local truncation, when truncation occurred. */
  readonly fullCommand: string | null;
}

export interface FieldSelectionMetadata {
  readonly applied: boolean;
  readonly requested: readonly string[];
  /** Requested paths absent from every applicable object. */
  readonly missing: readonly string[];
}

export interface RedactionMetadata {
  readonly applied: boolean;
  readonly count: number;
}

export interface NextCommand {
  readonly command: string;
  readonly description: string;
}

export type NextCommandInput = string | NextCommand;

export interface CollectionEnvelope {
  readonly data: JsonArray;
  readonly kind: "collection";
  readonly completeness: CompletenessMetadata;
  readonly truncation: TruncationMetadata;
  readonly selection: FieldSelectionMetadata;
  readonly redaction: RedactionMetadata;
  readonly context: JsonValue;
  readonly next: readonly NextCommand[];
}

export interface DetailEnvelope {
  readonly data: JsonValue;
  readonly kind: "detail";
  readonly completeness: CompletenessMetadata;
  readonly truncation: TruncationMetadata;
  readonly selection: FieldSelectionMetadata;
  readonly redaction: RedactionMetadata;
  readonly context: JsonValue;
  readonly next: readonly NextCommand[];
}

export type OutputEnvelope = CollectionEnvelope | DetailEnvelope;

export type OutputErrorCode =
  | "OUTPUT_INVALID_VALUE"
  | "OUTPUT_INVALID_OPTION"
  | "OUTPUT_SERIALIZATION_FAILED"
  | "OUTPUT_ROUND_TRIP_FAILED"
  | "OUTPUT_INVALID_DOCUMENT";

export class OutputBoundaryError extends Error {
  override readonly name = "OutputBoundaryError";

  constructor(
    readonly code: OutputErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface SerializedOutput {
  readonly format: OutputFormat;
  /** Serialized document without a terminal newline. */
  readonly text: string;
}

export interface TextOutputStream {
  write(chunk: string): unknown;
}
