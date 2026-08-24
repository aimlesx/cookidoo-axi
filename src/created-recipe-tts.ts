import { UsageError } from "./errors.js";

const SUPPORTED_SETTING = /(?<![\p{L}\p{N}.,+\-−‐‑‒–—―…⋯])(?<!\d[.,])(?<amount>\d+)\s*(?<unit>min|s)\s*\/\s*(?:(?<temperature>\d{1,3})\s*°\s*C\s*\/\s*)?obr\.\s*(?:(?<reverse>wsteczne)\s+)?(?<speed>10|[0-9](?:[.,]\d)?)(?![\p{L}\p{N}]|[.,]\d)/giu;
const NUMERIC_RANGE_BEFORE = /\d\s*(?:[\-−‐‑‒–—―/±]|\.{2,}|…|⋯|do)\s*$/iu;
const NUMERIC_RANGE_AFTER = /^\s*(?:[\-−‐‑‒–—―/±]|\.{2,}|…|⋯|do)\s*\d/iu;
const SIGNED_AMOUNT_BEFORE = /[+\-−‐‑‒–—―]\s*$/u;
const MAX_INFERRED_SETTINGS_PER_STEP = 32;
const MAX_INFERRED_SETTINGS_TOTAL = 128;
const MAX_TRANSFORMED_BODY_BYTES = 1_000_000;

interface TtsAnnotationData {
  readonly time: number;
  readonly speed: string;
  readonly temperature?: {
    readonly value: string;
    readonly unit: "C";
  };
  readonly direction?: "CCW";
}

interface TtsAnnotation {
  readonly type: "TTS";
  readonly data: TtsAnnotationData;
  readonly position: {
    readonly offset: number;
    readonly length: number;
  };
}

/**
 * Infer tappable Thermomix presets from a deliberately small Polish syntax.
 * This function performs no I/O and does not mutate its input.
 */
export function inferCreatedRecipeTtsAnnotations(body: unknown): unknown {
  if (!isObject(body) || !Array.isArray(body.instructions)) {
    throw new UsageError({
      code: "THERMOMIX_INSTRUCTIONS_REQUIRED",
      message: "--infer-thermomix-settings requires an instructions array in the same request body.",
      suggestion: "Supply the complete replacement instructions array, then dry-run the update again.",
      details: { flag: "--infer-thermomix-settings", bodyField: "instructions" },
    });
  }

  let detectedSettings = 0;
  const instructions = body.instructions.map((instruction, instructionIndex) => {
    if (!isObject(instruction) || instruction.type !== "STEP" || typeof instruction.text !== "string") {
      return instruction;
    }
    const inferred = annotationsForText(instruction.text);
    if (inferred.length === 0) return instruction;
    if (detectedSettings + inferred.length > MAX_INFERRED_SETTINGS_TOTAL) {
      throw inferenceLimitExceeded("request", MAX_INFERRED_SETTINGS_TOTAL);
    }
    detectedSettings += inferred.length;

    if (instruction.annotations !== undefined && !Array.isArray(instruction.annotations)) {
      throw invalidTtsAnnotation(
        "A STEP annotations value must be an array before Thermomix settings can be inferred.",
        instructionIndex,
      );
    }
    const existing = Array.isArray(instruction.annotations) ? instruction.annotations : [];
    const preserved = existing.filter((annotation) =>
      !isObject(annotation) || annotation.type !== "TTS" ||
      !inferred.some((candidate) => sameSpan(annotation.position, candidate.position))
    );
    return { ...instruction, annotations: [...preserved, ...inferred] };
  });

  if (detectedSettings === 0) {
    throw new UsageError({
      code: "THERMOMIX_SETTINGS_NOT_FOUND",
      message: "No supported Polish Thermomix setting was found in the supplied STEP instructions.",
      suggestions: [
        "Use an exact fragment such as `2 s/obr. 6`, `40 s/obr. 8`, or `5 min/80°C/obr. 3`.",
        "Set uncertain, Varoma, mode, range, or prose-only values manually instead of inferring them.",
      ],
      details: { flag: "--infer-thermomix-settings", detectedSettings: 0 },
    });
  }

  const result = { ...body, instructions };
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_TRANSFORMED_BODY_BYTES) {
    throw new UsageError({
      code: "BODY_TOO_LARGE",
      message: `Request body exceeds ${MAX_TRANSFORMED_BODY_BYTES} bytes after Thermomix setting inference.`,
      suggestion: "Reduce the complete instructions payload and dry-run it again.",
      details: {
        flag: "--infer-thermomix-settings",
        limitBytes: MAX_TRANSFORMED_BODY_BYTES,
        phase: "post-inference",
      },
    });
  }
  return result;
}

/**
 * Close the temporary validation gap in the pinned manifest for TTS entries.
 * Unknown non-TTS annotations remain forward-compatible and are not inspected.
 */
export function assertValidCreatedRecipeTtsAnnotations(body: unknown): void {
  if (!isObject(body) || !Array.isArray(body.instructions)) return;
  for (let instructionIndex = 0; instructionIndex < body.instructions.length; instructionIndex += 1) {
    const instruction = body.instructions[instructionIndex];
    if (!isObject(instruction) || typeof instruction.text !== "string" ||
        !Array.isArray(instruction.annotations)) continue;
    for (let annotationIndex = 0; annotationIndex < instruction.annotations.length; annotationIndex += 1) {
      const annotation = instruction.annotations[annotationIndex];
      if (!isObject(annotation) || annotation.type !== "TTS") continue;
      assertTtsAnnotation(annotation, instruction.text, instructionIndex, annotationIndex);
    }
  }
}

function annotationsForText(text: string): TtsAnnotation[] {
  const annotations: TtsAnnotation[] = [];
  for (const match of text.matchAll(SUPPORTED_SETTING)) {
    if (isPartOfNumericRange(text, match.index, match[0].length)) continue;
    const amount = Number(match.groups?.amount);
    const unit = match.groups?.unit?.toLowerCase();
    const speed = match.groups?.speed?.replace(",", ".");
    const temperature = match.groups?.temperature;
    if (!Number.isSafeInteger(amount) || amount <= 0 || speed === undefined) continue;
    const numericSpeed = Number(speed);
    if (!Number.isFinite(numericSpeed) || numericSpeed < 0 || numericSpeed > 10) continue;
    if (temperature !== undefined) {
      const numericTemperature = Number(temperature);
      if (!Number.isInteger(numericTemperature) || numericTemperature <= 0 || numericTemperature > 160) {
        continue;
      }
    }
    const seconds = unit === "min" ? amount * 60 : amount;
    if (!Number.isSafeInteger(seconds)) continue;
    const data: {
      time: number;
      speed: string;
      temperature?: { value: string; unit: "C" };
      direction?: "CCW";
    } = { time: seconds, speed };
    if (temperature !== undefined) {
      data.temperature = { value: String(Number(temperature)), unit: "C" };
    }
    if (match.groups?.reverse !== undefined) data.direction = "CCW";
    if (annotations.length >= MAX_INFERRED_SETTINGS_PER_STEP) {
      throw inferenceLimitExceeded("step", MAX_INFERRED_SETTINGS_PER_STEP);
    }
    annotations.push({
      type: "TTS",
      data,
      position: { offset: match.index, length: match[0].length },
    });
  }
  return annotations;
}

function isPartOfNumericRange(text: string, offset: number, length: number): boolean {
  const before = text.slice(Math.max(0, offset - 24), offset);
  const after = text.slice(offset + length, offset + length + 24);
  return SIGNED_AMOUNT_BEFORE.test(before) ||
    NUMERIC_RANGE_BEFORE.test(before) || NUMERIC_RANGE_AFTER.test(after);
}

function sameSpan(value: unknown, expected: TtsAnnotation["position"]): boolean {
  return isObject(value) && value.offset === expected.offset && value.length === expected.length;
}

function assertTtsAnnotation(
  annotation: Record<string, unknown>,
  text: string,
  instructionIndex: number,
  annotationIndex: number,
): void {
  if (!isObject(annotation.data)) {
    throw invalidTtsAnnotation("A TTS annotation requires an object data field.", instructionIndex, annotationIndex);
  }
  if (!isObject(annotation.position)) {
    throw invalidTtsAnnotation("A TTS annotation requires an object position field.", instructionIndex, annotationIndex);
  }
  const data = annotation.data;
  if (data.time !== undefined && (!Number.isInteger(data.time) || (data.time as number) < 0)) {
    throw invalidTtsAnnotation("TTS data.time must be a nonnegative integer in seconds.", instructionIndex, annotationIndex);
  }
  if (data.speed !== undefined && typeof data.speed !== "string") {
    throw invalidTtsAnnotation("TTS data.speed must be a string.", instructionIndex, annotationIndex);
  }
  if (data.direction !== undefined && data.direction !== "CW" && data.direction !== "CCW") {
    throw invalidTtsAnnotation("TTS data.direction must be CW or CCW.", instructionIndex, annotationIndex);
  }
  if (data.temperature !== undefined) {
    if (!isObject(data.temperature) || typeof data.temperature.value !== "string" ||
        (data.temperature.unit !== "C" && data.temperature.unit !== "F")) {
      throw invalidTtsAnnotation(
        "TTS data.temperature requires string value and unit C or F.",
        instructionIndex,
        annotationIndex,
      );
    }
  }

  const { offset, length } = annotation.position;
  if (!Number.isInteger(offset) || (offset as number) < 0 ||
      !Number.isInteger(length) || (length as number) < 1) {
    throw invalidTtsAnnotation(
      "TTS position.offset must be nonnegative and position.length must be positive integers.",
      instructionIndex,
      annotationIndex,
    );
  }
  if ((offset as number) + (length as number) > text.length) {
    throw invalidTtsAnnotation(
      "The TTS position span extends beyond its STEP text.",
      instructionIndex,
      annotationIndex,
    );
  }
  const end = (offset as number) + (length as number);
  if (splitsSurrogatePair(text, offset as number) || splitsSurrogatePair(text, end)) {
    throw invalidTtsAnnotation(
      "A TTS position boundary must not split a UTF-16 surrogate pair.",
      instructionIndex,
      annotationIndex,
    );
  }
}

function splitsSurrogatePair(text: string, boundary: number): boolean {
  if (boundary <= 0 || boundary >= text.length) return false;
  const before = text.charCodeAt(boundary - 1);
  const after = text.charCodeAt(boundary);
  return before >= 0xD800 && before <= 0xDBFF && after >= 0xDC00 && after <= 0xDFFF;
}

function inferenceLimitExceeded(scope: "step" | "request", limit: number): UsageError {
  return new UsageError({
    code: "THERMOMIX_SETTINGS_LIMIT_EXCEEDED",
    message: `Thermomix setting inference exceeds the ${scope} limit of ${limit}.`,
    suggestion: "Split overly dense instructions into clear steps or supply reviewed TTS annotations manually.",
    details: { flag: "--infer-thermomix-settings", scope, limit },
  });
}

function invalidTtsAnnotation(
  message: string,
  instructionIndex?: number,
  annotationIndex?: number,
): UsageError {
  return new UsageError({
    code: "INVALID_TTS_ANNOTATION",
    message,
    suggestion: "Fix or remove the malformed TTS annotation, then dry-run the complete instructions update again.",
    details: {
      bodyField: "instructions",
      ...(instructionIndex === undefined ? {} : { instructionIndex }),
      ...(annotationIndex === undefined ? {} : { annotationIndex }),
    },
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
