import { replaceInvalidUnicode } from "./json-value.js";
import {
  DEFAULT_REDACTION_REPLACEMENT,
  containsCredentialLikeText,
} from "./redact.js";
import type { SerializeOutputOptions } from "./serialize.js";
import { assertSerializedDocument, serializeOutput } from "./serialize.js";
import type { SerializedOutput, TextOutputStream } from "./types.js";
import { OutputBoundaryError } from "./types.js";

export interface WriteOutputOptions extends SerializeOutputOptions {
  readonly stdout?: TextOutputStream;
}

export interface DiagnosticOptions {
  readonly stderr?: TextOutputStream;
  readonly prefix?: string;
  readonly includeStack?: boolean;
}

export function writeOutput(
  input: unknown,
  options: WriteOutputOptions = {},
): SerializedOutput {
  const serialized = serializeOutput(input, options);
  writeSerializedOutput(serialized, options.stdout ?? process.stdout);
  return serialized;
}

export function writeSerializedOutput(
  output: SerializedOutput,
  stdout: TextOutputStream = process.stdout,
): void {
  assertSerializedDocument(output);
  stdout.write(`${output.text}\n`);
}

/** Writes human diagnostics only to stderr and never serializes unknown objects. */
export function writeDiagnostic(
  error: unknown,
  options: DiagnosticOptions = {},
): string {
  const message = diagnosticText(error, options.includeStack === true);
  const prefix = options.prefix === undefined ? "" : `${options.prefix.trim()} `;
  const text = sanitizeDiagnostic(`${prefix}${message}`);
  (options.stderr ?? process.stderr).write(`${text}\n`);
  return text;
}

export function diagnosticText(error: unknown, includeStack = false): string {
  if (error instanceof OutputBoundaryError) {
    if (includeStack && error.stack !== undefined) {
      return `${error.code}: ${error.stack}`;
    }
    return `${error.code}: ${error.message}`;
  }
  if (error instanceof Error) {
    if (includeStack && error.stack !== undefined) {
      return error.stack;
    }
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return "Unknown error";
}

export function sanitizeDiagnostic(input: string): string {
  let text = replaceInvalidUnicode(input);
  // Credential assignments can span lines (for example `password=\nvalue`).
  // Once detected, no line boundary is a trustworthy end to the value.
  if (containsCredentialLikeText(text)) return DEFAULT_REDACTION_REPLACEMENT;
  text = text.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, "Bearer [REDACTED]");
  text = text.replace(
    /(["'](?:authorization|cookie|set-cookie|password|passwd|token|secret|credential|api[-_]?key)["']\s*:\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/giu,
    "$1\"[REDACTED]\"",
  );
  text = text.replace(
    /\b(authorization|cookie|set-cookie|password|passwd|token|secret|credential|api[-_]?key)\b(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu,
    "$1$2[REDACTED]",
  );
  text = text
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n+$/u, "");
  return text.length === 0 ? "Unknown error" : text;
}
