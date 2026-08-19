export type CliExitCode = 1 | 2;

export interface CliErrorInit {
  readonly code: string;
  readonly message: string;
  readonly suggestion?: string;
  readonly suggestions?: readonly string[];
  readonly details?: Readonly<Record<string, unknown>>;
}

export type CliErrorMetadata = Readonly<Record<string, unknown>> & {
  readonly suggestion?: string;
  readonly suggestions?: readonly string[] | undefined;
  readonly details?: Readonly<Record<string, unknown>>;
};

/**
 * A stable, serializable CLI error. Provider payloads and stack traces must not
 * be copied into `details`; callers may safely render `toJSON()` on stdout.
 */
export abstract class CliError extends Error {
  abstract readonly exitCode: CliExitCode;

  readonly code: string;
  readonly suggestion: string | undefined;
  readonly suggestions: readonly string[];
  readonly details: Readonly<Record<string, unknown>> | undefined;

  protected constructor(name: string, init: CliErrorInit) {
    super(init.message);
    this.name = name;
    this.code = init.code;
    this.suggestions = init.suggestions ??
      (init.suggestion === undefined ? [] : [init.suggestion]);
    this.suggestion = init.suggestion ?? this.suggestions[0];
    this.details = init.details;
  }

  toJSON(): {
    readonly error: {
      readonly code: string;
      readonly message: string;
      readonly exitCode: CliExitCode;
      readonly suggestion?: string;
      readonly suggestions?: readonly string[];
      readonly details?: Readonly<Record<string, unknown>>;
    };
  } {
    const error: {
      code: string;
      message: string;
      exitCode: CliExitCode;
      suggestion?: string;
      suggestions?: readonly string[];
      details?: Readonly<Record<string, unknown>>;
    } = {
      code: this.code,
      message: this.message,
      exitCode: this.exitCode,
    };
    if (this.suggestion !== undefined) error.suggestion = this.suggestion;
    if (this.suggestions.length > 0) error.suggestions = this.suggestions;
    if (this.details !== undefined) error.details = this.details;
    return { error };
  }
}

function normalizeInit(
  initOrCode: CliErrorInit | string,
  message?: string,
  metadata?: CliErrorMetadata,
): CliErrorInit {
  if (typeof initOrCode !== "string") return initOrCode;
  const suggestions = Array.isArray(metadata?.suggestions)
    ? metadata.suggestions.filter((value): value is string => typeof value === "string")
    : undefined;
  const suggestion = typeof metadata?.suggestion === "string"
    ? metadata.suggestion : suggestions?.[0];
  const details = metadata?.details;
  return {
    code: initOrCode,
    message: message ?? initOrCode,
    ...(suggestion === undefined ? {} : { suggestion }),
    ...(suggestions === undefined ? {} : { suggestions }),
    ...(details === undefined ? {} : { details }),
  };
}

/** Invalid command input or a failed safety precondition. */
export class UsageError extends CliError {
  readonly exitCode = 2 as const;

  constructor(init: CliErrorInit);
  constructor(code: string, message: string, metadata?: CliErrorMetadata);
  constructor(
    initOrCode: CliErrorInit | string,
    message?: string,
    metadata?: CliErrorMetadata,
  ) {
    super("UsageError", normalizeInit(initOrCode, message, metadata));
  }
}

/** A local dependency, manifest, or upstream operation failed. */
export class OperationalError extends CliError {
  readonly exitCode = 1 as const;

  constructor(init: CliErrorInit);
  constructor(code: string, message: string, metadata?: CliErrorMetadata);
  constructor(
    initOrCode: CliErrorInit | string,
    message?: string,
    metadata?: CliErrorMetadata,
  ) {
    super("OperationalError", normalizeInit(initOrCode, message, metadata));
  }
}

export function isCliError(value: unknown): value is CliError {
  return value instanceof CliError;
}
