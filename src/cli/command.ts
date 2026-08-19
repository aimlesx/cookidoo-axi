import type { GlobalOptions } from "./types.js";

const STATIC_TOKEN = /^(?:[A-Za-z0-9][A-Za-z0-9._/-]*|--?[A-Za-z0-9][A-Za-z0-9-]*)$/u;

const DEFAULT_CONTEXT = {
  profile: "default",
  lang: "pl",
  output: "toon",
  maxItems: 20,
  timeoutMs: 15_000,
} as const;

export interface CommandLiteral {
  readonly kind: "literal";
  readonly value: string;
}

export interface CommandArgument {
  readonly kind: "argument";
  readonly value: string;
}

export type CommandToken = CommandLiteral | CommandArgument;

export interface CommandContextPolicy {
  /** Include the Keychain profile when it is non-default. Default: true. */
  readonly profile?: boolean;
  /** Include the API language when it is non-default. Default: true. */
  readonly lang?: boolean;
  /** Include the output format when it is non-default. Default: true. */
  readonly output?: boolean;
  /** Include the item bound when it is non-default. Default: true. */
  readonly maxItems?: boolean;
  /** Include the request timeout when it is non-default. Default: true. */
  readonly timeoutMs?: boolean;
  /** Include an explicit field projection when present. Default: true. */
  readonly fields?: boolean;
  /** Include --full when it was present. Default: false. */
  readonly full?: boolean;
  /** Include selected value options even when they equal CLI defaults. Default: false. */
  readonly includeDefaults?: boolean;
}

type CommandContext = Pick<GlobalOptions, "profile" | "lang" | "output" | "maxItems"> &
  Partial<Pick<GlobalOptions, "fields" | "full" | "timeoutMs">>;

/** Mark a compile-time or generated-manifest command word or flag as shell syntax. */
export function commandLiteral(value: string): CommandLiteral {
  if (!STATIC_TOKEN.test(value)) {
    throw new TypeError(
      "Command literals must be one conservative shell word; use commandArgument() for runtime values",
    );
  }
  return { kind: "literal", value };
}

/** Mark a runtime value as data. It will always be emitted as one single-quoted POSIX argument. */
export function commandArgument(value: string | number | boolean): CommandArgument {
  return { kind: "argument", value: String(value) };
}

export function commandLiterals(values: readonly string[]): CommandLiteral[] {
  return values.map(commandLiteral);
}

/**
 * Quote one POSIX shell argument without expansions or substitutions.
 *
 * NUL cannot be represented in a process argument. Other control characters remain literal data
 * inside the single quotes and therefore cannot become separators or shell operators.
 */
export function quotePosixArgument(value: string): string {
  if (value.includes("\0")) {
    throw new TypeError("Command arguments cannot contain NUL");
  }
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/** Render an explicitly typed command. Runtime arguments are never emitted unquoted. */
export function renderCommand(tokens: readonly CommandToken[]): string {
  if (tokens.length === 0) throw new TypeError("A command must contain at least one token");
  return tokens.map((token) => {
    if (token.kind === "literal") return commandLiteral(token.value).value;
    if (token.kind === "argument") return quotePosixArgument(token.value);
    throw new TypeError("Unknown command token kind");
  }).join(" ");
}

/**
 * Return shell-safe global context tokens for follow-ups, full commands, and reconciliation.
 * Non-default account, locale, output, item bound, and field projection are preserved by default.
 */
export function commandContextTokens(
  options: CommandContext,
  policy: CommandContextPolicy = {},
): CommandToken[] {
  const includeDefaults = policy.includeDefaults ?? false;
  const tokens: CommandToken[] = [];
  if ((policy.profile ?? true) && (includeDefaults || options.profile !== DEFAULT_CONTEXT.profile)) {
    tokens.push(commandLiteral("--profile"), commandArgument(options.profile));
  }
  if ((policy.lang ?? true) && (includeDefaults || options.lang !== DEFAULT_CONTEXT.lang)) {
    tokens.push(commandLiteral("--lang"), commandArgument(options.lang));
  }
  if ((policy.output ?? true) && (includeDefaults || options.output !== DEFAULT_CONTEXT.output)) {
    tokens.push(commandLiteral("--output"), commandArgument(options.output));
  }
  if ((policy.maxItems ?? true) && (includeDefaults || options.maxItems !== DEFAULT_CONTEXT.maxItems)) {
    tokens.push(commandLiteral("--max-items"), commandArgument(options.maxItems));
  }
  if (
    (policy.timeoutMs ?? true) &&
    options.timeoutMs !== undefined &&
    (includeDefaults || options.timeoutMs !== DEFAULT_CONTEXT.timeoutMs)
  ) {
    tokens.push(commandLiteral("--timeout-ms"), commandArgument(options.timeoutMs));
  }
  if ((policy.fields ?? true) && options.fields !== undefined) {
    tokens.push(commandLiteral("--fields"), commandArgument(options.fields.join(",")));
  }
  if ((policy.full ?? false) && options.full === true) {
    tokens.push(commandLiteral("--full"));
  }
  return tokens;
}

/** Render a command and carry its parsed account, locale, and output context forward. */
export function renderContextualCommand(
  tokens: readonly CommandToken[],
  options: CommandContext,
  policy: CommandContextPolicy = {},
): string {
  return renderCommand([...tokens, ...commandContextTokens(options, policy)]);
}
