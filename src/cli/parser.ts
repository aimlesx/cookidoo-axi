import { UsageError } from "../errors.js";
import type {
  AuthStatusInspection,
  GlobalOptions,
  OperationListFilter,
  OperationDescriptor,
  ParsedInvocation,
  ParsedOperationInvocation
} from "./types.js";

const GLOBAL_VALUE_FLAGS: ReadonlyMap<string, keyof Pick<GlobalOptions,
  "output" | "profile" | "lang" | "timeoutMs" | "fields" | "maxItems" | "confirm" | "target">> = new Map([
  ["--output", "output"],
  ["--profile", "profile"],
  ["--lang", "lang"],
  ["--timeout-ms", "timeoutMs"],
  ["--fields", "fields"],
  ["--max-items", "maxItems"],
  ["--confirm", "confirm"],
  ["--target", "target"]
]);

const GLOBAL_BOOLEAN_FLAGS: ReadonlyMap<string, keyof Pick<GlobalOptions,
  "full" | "dryRun" | "allowUnverified" | "debug">> = new Map([
  ["--full", "full"],
  ["--dry-run", "dryRun"],
  ["--allow-unverified", "allowUnverified"],
  ["--debug", "debug"]
]);

export function defaultOptions(): GlobalOptions {
  return {
    output: "toon",
    profile: "default",
    lang: "pl",
    timeoutMs: 15_000,
    maxItems: 20,
    full: false,
    dryRun: false,
    allowUnverified: false,
    debug: false
  };
}

export function parseInvocation(
  argv: string[],
  operations: OperationDescriptor[]
): ParsedInvocation {
  const { remaining, options } = extractGlobalOptions(argv);
  if (remaining.length === 0) return { kind: "home", options };
  if (remaining.length === 1 && isHelp(remaining[0])) return { kind: "root-help", options };
  if (remaining[0]?.startsWith("-")) {
    throw unknownFlag(remaining[0], [
      ...GLOBAL_VALUE_FLAGS.keys(),
      ...GLOBAL_BOOLEAN_FLAGS.keys(),
      "--help",
      "--version",
    ]);
  }

  if (remaining[0] === "auth") return parseAuth(remaining.slice(1), options);
  if (remaining[0] === "skill") return parseSkill(remaining.slice(1), options);
  if (remaining[0] === "setup") throw legacySetupCommand(remaining);
  if (remaining[0] === "hook" && remaining[1] === "session-start") {
    throw new UsageError({
      code: "LEGACY_COMMAND_REMOVED",
      message: "The legacy `cookidoo-axi hook session-start` integration has been removed; Agent Skills no longer require a session hook.",
      suggestion: "cookidoo-axi skill install --skills-directory <path>",
      details: { replacement: "cookidoo-axi skill install --skills-directory <path>" },
    });
  }
  if (remaining[0] === "operation") {
    return parseOperationMeta(remaining.slice(1), options, operations);
  }

  const createdVirtual = parseCreatedVirtual(remaining, options, operations);
  if (createdVirtual !== undefined) return createdVirtual;

  const helpIndex = remaining.findIndex(isHelp);
  if (helpIndex >= 0) {
    if (helpIndex !== remaining.length - 1) {
      throw new UsageError("HELP_POSITION", "--help must be the final argument");
    }
    const tokens = remaining.slice(0, -1);
    const exact = operations.find((operation) => equalTokens(operation.command, tokens));
    if (exact) return { kind: "operation-help", operation: exact, options };
    const focused = longestCommandPrefix(tokens, operations);
    if (focused !== undefined) {
      return { kind: "operation-help", operation: focused, options };
    }
    if (isKnownGroup(tokens, operations)) return { kind: "group-help", group: tokens, options };
  }

  const operation = longestCommandPrefix(remaining, operations);
  if (!operation) throw unknownCommand(remaining, operations);
  return parseOperationArgs(operation, remaining.slice(operation.command.length), options, false);
}

function parseSkill(args: string[], options: GlobalOptions): ParsedInvocation {
  if (args.length === 0 || (args.length === 1 && isHelp(args[0]))) {
    return { kind: "group-help", group: ["skill"], options };
  }
  const command = args[0] as string;
  if (!["install", "remove"].includes(command)) {
    throw new UsageError({
      code: "UNKNOWN_COMMAND",
      message: `Unknown skill command: ${command}`,
      suggestions: [
        "cookidoo-axi skill install --skills-directory <path>",
        "cookidoo-axi skill remove --skills-directory <path> --confirm <absolute-skill-directory>",
      ],
      details: { subcommand: command },
    });
  }
  if (args.length === 2 && isHelp(args[1])) {
    return { kind: "group-help", group: ["skill", command], options };
  }
  let skillsDirectory: string | undefined;
  for (let index = 1; index < args.length; index += 1) {
    const token = args[index] as string;
    if (token === "--skills-directory") {
      if (skillsDirectory !== undefined) {
        throw new UsageError("INVALID_OPTION", "--skills-directory may be supplied only once");
      }
      skillsDirectory = requireValue(args, ++index, token);
    } else if (isHelp(token)) {
      return { kind: "group-help", group: ["skill", command], options };
    } else {
      throw unexpectedToken(token, ["--skills-directory", "--confirm", "--help"]);
    }
  }
  if (skillsDirectory === undefined) {
    throw new UsageError({
      code: "MISSING_OPTION",
      message: `skill ${command} requires --skills-directory <path>`,
      suggestion: `cookidoo-axi skill ${command} --skills-directory <path>${command === "remove" ? " --confirm <absolute-skill-directory>" : ""}`,
      details: { flag: "--skills-directory" },
    });
  }
  if (skillsDirectory.length === 0 || /[\u0000-\u001f\u007f]/u.test(skillsDirectory)) {
    throw new UsageError({
      code: "INVALID_OPTION",
      message: "--skills-directory must be a nonempty path without control characters",
      suggestion: `cookidoo-axi skill ${command} --skills-directory <path>${command === "remove" ? " --confirm <absolute-skill-directory>" : ""}`,
      details: { flag: "--skills-directory" },
    });
  }
  const unsupportedSafetyFlag = options.dryRun
    ? "--dry-run"
    : options.allowUnverified
      ? "--allow-unverified"
      : options.target !== undefined
        ? "--target"
        : command === "install" && options.confirm !== undefined
          ? "--confirm"
          : undefined;
  if (unsupportedSafetyFlag !== undefined) {
    throw new UsageError({
      code: "INVALID_OPTION",
      message: `${unsupportedSafetyFlag} is not supported by skill ${command}`,
      suggestion: `cookidoo-axi skill ${command} --skills-directory <path>${command === "remove" ? " --confirm <absolute-skill-directory>" : ""}`,
      details: { flag: unsupportedSafetyFlag, command: `skill ${command}` },
    });
  }
  return command === "install"
    ? { kind: "skill-install", skillsDirectory, options }
    : { kind: "skill-remove", skillsDirectory, options };
}

function legacySetupCommand(args: readonly string[]): UsageError {
  const removing = args[1] === "remove";
  const replacement = removing
    ? "cookidoo-axi skill remove --skills-directory <path> --confirm <absolute-skill-directory>"
    : "cookidoo-axi skill install --skills-directory <path>";
  return new UsageError({
    code: "LEGACY_COMMAND_REMOVED",
    message: `The legacy \`${args.slice(0, 2).join(" ")}\` integration has been removed. Use \`${replacement}\`.`,
    suggestion: replacement,
    details: { replacement },
  });
}

function parseAuth(args: string[], options: GlobalOptions): ParsedInvocation {
  if (options.dryRun) {
    throw new UsageError({
      code: "INVALID_OPTION",
      message: "--dry-run is not supported by auth commands.",
      suggestion: "Remove --dry-run; only API operations provide an auth-free dry-run mode.",
      details: { flag: "--dry-run", command: "auth" },
    });
  }
  if (args.length === 0 || (args.length === 1 && isHelp(args[0]))) {
    return { kind: "group-help", group: ["auth"], options };
  }
  const command = args[0] as string;
  const rest = args.slice(1);
  if (rest.length === 1 && isHelp(rest[0])) {
    return { kind: "group-help", group: ["auth", command], options };
  }
  if (command === "doctor") {
    if (rest.length) throw unexpectedToken(rest[0] as string, ["--help"]);
    return { kind: "auth-doctor", options };
  }
  if (command === "status") return parseAuthStatus(rest, options);
  if (command === "login") {
    if (rest.length) throw unexpectedToken(rest[0] as string, ["--help"]);
    return { kind: "auth-login", options };
  }
  if (command === "import-env" || command === "import-feed-env") {
    let envFile = ".env";
    for (let index = 0; index < rest.length; index += 1) {
      const token = rest[index] as string;
      if (token === "--env-file") {
        envFile = requireValue(rest, ++index, token);
      } else if (isHelp(token)) {
        return { kind: "group-help", group: ["auth", command], options };
      } else {
        throw unexpectedToken(token, ["--env-file", "--profile", "--help"]);
      }
    }
    return command === "import-env"
      ? { kind: "auth-import-env", envFile, options }
      : { kind: "auth-import-feed-env", envFile, options };
  }
  if (command === "remove") {
    if (rest.length) throw unexpectedToken(rest[0] as string, ["--help"]);
    return { kind: "auth-remove", options };
  }
  if (command === "clear-session") {
    if (rest.length) throw unexpectedToken(rest[0] as string, ["--help"]);
    return { kind: "auth-clear-session", options };
  }
  throw new UsageError("UNKNOWN_COMMAND", `Unknown auth command: ${command ?? "<missing>"}`, {
    suggestions: ["cookidoo-axi auth doctor", "cookidoo-axi auth import-env --env-file .env"]
  });
}

function parseAuthStatus(args: string[], options: GlobalOptions): ParsedInvocation {
  let inspection: AuthStatusInspection = "none";
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index] as string;
    if (token === "--inspect") {
      if (inspection !== "none") {
        throw new UsageError("INVALID_OPTION", "--inspect may be supplied only once");
      }
      const value = requireValue(args, ++index, token);
      if (!isAuthStatusInspection(value)) {
        throw new UsageError(
          "INVALID_OPTION",
          "--inspect must be session, market, feed, or all",
        );
      }
      inspection = value;
      continue;
    }
    if (isHelp(token)) return { kind: "group-help", group: ["auth", "status"], options };
    throw unexpectedToken(token, ["--inspect", "--profile", "--help"]);
  }
  return { kind: "auth-status", inspection, options };
}

function isAuthStatusInspection(value: string): value is Exclude<AuthStatusInspection, "none"> {
  return ["session", "market", "feed", "all"].includes(value);
}

function parseCreatedVirtual(
  args: string[],
  options: GlobalOptions,
  operations: OperationDescriptor[]
): ParsedOperationInvocation | ParsedInvocation | undefined {
  if (args[0] !== "created") return undefined;
  const command = args[1];
  if (!["publish", "unpublish", "import"].includes(command ?? "")) return undefined;
  const helpIndex = args.findIndex(isHelp);
  if (helpIndex >= 0) {
    if (helpIndex !== args.length - 1) {
      throw new UsageError("HELP_POSITION", "--help must be the final argument");
    }
    return { kind: "group-help", group: ["created", command as string], options };
  }
  if (command === "import") {
    const operation = operations.find((candidate) => candidate.operationId === "listCreatedRecipes");
    if (!operation) throw new UsageError("MANIFEST_ERROR", "Missing listCreatedRecipes operation");
    const parsed = parseOperationArgs(operation, args.slice(2), options, true);
    if (parsed.query.recipeUrl === undefined) {
      throw new UsageError("MISSING_OPTION", "created import requires --recipe-url <https-url>");
    }
    return { ...parsed, rawOperation: false, operationMode: "created-import" };
  }
  const operation = operations.find((candidate) => candidate.operationId === "patchCreatedRecipe");
  if (!operation) throw new UsageError("MANIFEST_ERROR", "Missing patchCreatedRecipe operation");
  const parsed = parseOperationArgs(operation, args.slice(2), options, false);
  if (parsed.bodyInput !== undefined || parsed.bodyFields.length > 0) {
    throw new UsageError("CONFLICTING_INPUT", `created ${command} accepts no request-body flags`);
  }
  return {
    ...parsed,
    operationMode: command === "publish" ? "created-publish" : "created-unpublish",
    bodyFields: [{
      path: "workStatus",
      value: command === "publish" ? "PUBLIC" : "PRIVATE",
      array: false,
    }],
  };
}

function parseOperationMeta(
  args: string[],
  options: GlobalOptions,
  operations: OperationDescriptor[]
): ParsedInvocation {
  if (args.length === 0 || (args.length === 1 && isHelp(args[0]))) {
    return { kind: "group-help", group: ["operation"], options };
  }
  if (args[0] === "list") {
    if (args.slice(1).some(isHelp)) {
      return { kind: "group-help", group: ["operation", "list"], options };
    }
    const filter: {
      group?: string;
      risk?: NonNullable<OperationListFilter["risk"]>;
      query?: string;
    } = {};
    const groups = [...new Set(operations.map((operation) => operation.command[0]))].sort();
    const risks = ["read", "write", "destructive", "external", "device", "unverified"] as const;
    for (let index = 1; index < args.length; index += 1) {
      const flag = args[index] as string;
      if (flag === "--group") {
        if (filter.group !== undefined) throw new UsageError("INVALID_OPTION", "--group may be supplied only once");
        const value = requireValue(args, ++index, flag).toLowerCase();
        if (!groups.includes(value)) {
          throw new UsageError("INVALID_OPTION", `--group must be one of: ${groups.join(", ")}`);
        }
        filter.group = value;
      } else if (flag === "--risk") {
        if (filter.risk !== undefined) throw new UsageError("INVALID_OPTION", "--risk may be supplied only once");
        const value = requireValue(args, ++index, flag).toLowerCase();
        if (!risks.includes(value as typeof risks[number])) {
          throw new UsageError("INVALID_OPTION", `--risk must be one of: ${risks.join(", ")}`);
        }
        filter.risk = value as typeof risks[number];
      } else if (flag === "--query") {
        if (filter.query !== undefined) throw new UsageError("INVALID_OPTION", "--query may be supplied only once");
        const value = requireValue(args, ++index, flag).trim();
        if (value.length === 0 || value.length > 100 || /[\p{Cc}\p{Cs}]/u.test(value)) {
          throw new UsageError("INVALID_OPTION", "--query must contain 1 to 100 printable characters");
        }
        filter.query = value;
      } else {
        throw unexpectedToken(flag, ["--group", "--risk", "--query", "--help"]);
      }
    }
    return { kind: "operation-list", filter, options };
  }
  if (args[0] === "describe") {
    if (args.length === 2 && isHelp(args[1])) {
      return { kind: "group-help", group: ["operation", "describe"], options };
    }
    const operationId = args[1];
    if (!operationId) throw new UsageError("MISSING_ARGUMENT", "operation describe requires <operation-id>");
    if (args.length === 3 && isHelp(args[2])) {
      return { kind: "group-help", group: ["operation", "describe"], options };
    }
    if (args.length !== 2) {
      throw unexpectedToken(args[2] as string, ["--help"]);
    }
    return { kind: "operation-describe", operationId, options };
  }
  if (args[0] === "run") {
    const operationId = args[1];
    if (!operationId) throw new UsageError("MISSING_ARGUMENT", "operation run requires <operation-id>");
    const operation = operations.find((candidate) => candidate.operationId === operationId);
    if (!operation) throw new UsageError("UNKNOWN_OPERATION", `Unknown operation: ${operationId}`);
    if (args.slice(2).some(isHelp)) return { kind: "operation-help", operation, options };
    return parseOperationArgs(operation, args.slice(2), options, true);
  }
  const subcommand = displayToken(args[0] ?? "<missing>");
  throw new UsageError(
    "UNKNOWN_COMMAND",
    `Unknown operation subcommand: ${JSON.stringify(subcommand)}`,
    { details: { subcommand } },
  );
}

function parseOperationArgs(
  operation: OperationDescriptor,
  args: string[],
  options: GlobalOptions,
  rawOperation: boolean
): ParsedOperationInvocation {
  const pathParameters = operation.parameters.filter(
    (parameter) => parameter.in === "path" && parameter.name !== "lang"
  );
  const queryParameters = operation.parameters.filter((parameter) => parameter.in === "query");
  const queryFlags: ReadonlyMap<string, OperationDescriptor["parameters"][number]> = new Map(
    queryParameters
      .filter((parameter) => parameter.name !== "filters")
      .map((parameter) => [`--${kebab(parameter.name)}`, parameter] as const)
  );
  const bodyProperties = collectBodyProperties(operation);
  const bodyFlags: ReadonlyMap<string, { name: string; schema: Record<string, unknown> }> = new Map(
    [...bodyProperties].map(([name, schema]) => [`--${kebab(name)}`, { name, schema }] as const)
  );
  const allowed = [
    ...queryFlags.keys(),
    ...bodyFlags.keys(),
    "--filter",
    ...(operation.operationId === "getCollectionFeedPage"
      ? ["--page-before-seconds", "--page-before-milliseconds"]
      : []),
    "--set",
    "--data",
    ...GLOBAL_VALUE_FLAGS.keys(),
    ...GLOBAL_BOOLEAN_FLAGS.keys(),
    "--help"
  ];

  const positionals: string[] = [];
  const query: Record<string, string | number | boolean> = {};
  const headers: Record<string, string> = {};
  const filters: Array<{ key: string; value: string }> = [];
  const bodyFields: ParsedOperationInvocation["bodyFields"] = [];
  let bodyInput: string | undefined;
  let pageBeforeUnitWasExplicit = false;
  let pageBeforeUnit: "seconds" | "milliseconds" | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index] as string;
    if (!token.startsWith("-")) {
      positionals.push(token);
      continue;
    }
    if (token === "--data") {
      bodyInput = requireValue(args, ++index, token);
      continue;
    }
    if (token === "--set") {
      const assignment = splitAssignment(requireValue(args, ++index, token), token);
      bodyFields.push({ path: assignment.key, value: assignment.value, array: false });
      continue;
    }
    if (token === "--filter") {
      const assignment = splitAssignment(requireValue(args, ++index, token), token);
      filters.push(assignment);
      continue;
    }
    if (
      operation.operationId === "getCollectionFeedPage" &&
      (token === "--page-before-seconds" || token === "--page-before-milliseconds")
    ) {
      if (query.pageBefore !== undefined) {
        throw new UsageError("DUPLICATE_QUERY", "pageBefore was supplied more than once");
      }
      query.pageBefore = parseBoundedInteger(
        requireValue(args, ++index, token), token, 0, Number.MAX_SAFE_INTEGER,
      );
      pageBeforeUnitWasExplicit = true;
      pageBeforeUnit = token.endsWith("milliseconds") ? "milliseconds" : "seconds";
      continue;
    }
    const queryParameter = queryFlags.get(token);
    if (queryParameter) {
      const raw = requireValue(args, ++index, token);
      if (query[queryParameter.name] !== undefined) {
        throw new UsageError("DUPLICATE_QUERY", `${token} was supplied more than once`);
      }
      if (
        operation.operationId === "getCollectionFeedPage" &&
        queryParameter.name === "pageBefore" && /^\d+$/u.test(raw)
      ) {
        throw new UsageError(
          "AMBIGUOUS_TIMESTAMP_UNIT",
          "Numeric pageBefore requires --page-before-seconds or --page-before-milliseconds",
          { suggestions: ["Prefer --page-before <ISO-8601-date-time>"] },
        );
      }
      query[queryParameter.name] = parseParameterValue(raw, queryParameter.schema, token);
      continue;
    }
    const bodyProperty = bodyFlags.get(token);
    if (bodyProperty) {
      const raw = requireValue(args, ++index, token);
      bodyFields.push({
        path: bodyProperty.name,
        value: raw,
        array: schemaIncludesType(bodyProperty.schema, "array"),
        schema: bodyProperty.schema,
        flag: token,
      });
      continue;
    }
    throw unknownFlag(token, allowed);
  }

  if (positionals.length < pathParameters.length) {
    const missing = pathParameters[positionals.length];
    throw new UsageError("MISSING_ARGUMENT", `Missing required <${missing?.name ?? "argument"}>`, {
      suggestions: [`cookidoo-axi ${operation.command.join(" ")} --help`]
    });
  }
  if (positionals.length > pathParameters.length) {
    throw unexpectedToken(positionals[pathParameters.length] as string, allowed);
  }
  if (bodyInput !== undefined && bodyFields.length > 0) {
    throw new UsageError("CONFLICTING_INPUT", "--data cannot be combined with body property flags or --set");
  }
  if (
    operation.operationId === "getCollectionFeedPage" &&
    typeof query.pageBefore === "number" && !pageBeforeUnitWasExplicit
  ) {
    throw new UsageError(
      "AMBIGUOUS_TIMESTAMP_UNIT",
      "Numeric pageBefore requires --page-before-seconds or --page-before-milliseconds",
      { suggestions: ["Prefer --page-before <ISO-8601-date-time>"] },
    );
  }
  if (
    !rawOperation && operation.operationId === "listCreatedRecipes" &&
    ["recipeUrl", "partnerId", "addToCookidoo"].some((name) => query[name] !== undefined)
  ) {
    throw new UsageError(
      "IMPORT_MODE_REQUIRED",
      "Import-like created-recipe query options are not permitted on created list",
      { suggestions: ["Use cookidoo-axi created import --help"] },
    );
  }

  const path = Object.fromEntries(
    pathParameters.map((parameter, index) => [parameter.name, positionals[index] as string])
  );
  if (operation.parameters.some((parameter) => parameter.in === "path" && parameter.name === "lang")) {
    path.lang = options.lang;
  }
  for (const parameter of operation.parameters.filter((candidate) => candidate.in === "header")) {
    if (parameter.name.toLowerCase() === "x-requested-with") {
      headers[parameter.name] = "xmlhttprequest";
    }
  }

  return {
    kind: "operation",
    operation,
    rawOperation,
    ...(!rawOperation && operation.operationId === "patchCreatedRecipe"
      ? { operationMode: "created-edit" as const }
      : {}),
    ...(pageBeforeUnit === undefined ? {} : { pageBeforeUnit }),
    path,
    query,
    headers,
    ...(bodyInput === undefined ? {} : { bodyInput }),
    bodyFields,
    filters,
    options
  };
}

function extractGlobalOptions(argv: string[]): { remaining: string[]; options: GlobalOptions } {
  const options = defaultOptions();
  const remaining: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;
    const valueKey = GLOBAL_VALUE_FLAGS.get(token);
    if (valueKey) {
      const value = requireValue(argv, ++index, token);
      if (valueKey === "output") {
        if (value !== "toon" && value !== "json") {
          throw new UsageError("INVALID_OPTION", "--output must be toon or json");
        }
        options.output = value;
      } else if (valueKey === "profile") {
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)) {
          throw new UsageError("INVALID_PROFILE", "--profile must start with a letter or digit and use at most 64 letters, digits, dots, underscores, or hyphens");
        }
        options.profile = value;
      } else if (valueKey === "lang") {
        if (!/^[a-z]{2}(?:-[A-Z]{2})?$/.test(value)) {
          throw new UsageError("INVALID_LANGUAGE", "--lang must look like pl or pl-PL");
        }
        options.lang = value;
      } else if (valueKey === "timeoutMs") {
        options.timeoutMs = parseBoundedInteger(value, "--timeout-ms", 1_000, 120_000);
      } else if (valueKey === "maxItems") {
        options.maxItems = parseBoundedInteger(value, "--max-items", 1, 500);
      } else if (valueKey === "fields") {
        const fields = value.split(",").map((field) => field.trim());
        if (
          fields.length === 0 || fields.some((field) =>
            field.split(".").some((segment) => segment.length === 0) || /\p{Cc}/u.test(field))
        ) {
          throw new UsageError("INVALID_FIELDS", "--fields requires non-empty dotted paths without control characters");
        }
        options.fields = fields;
      } else if (valueKey === "confirm") {
        options.confirm = value;
      } else if (valueKey === "target") {
        if (
          value.length === 0 || value !== value.trim() || value.length > 512 ||
          /[\p{Cc}\p{Cs}]/u.test(value)
        ) {
          throw new UsageError(
            "INVALID_TARGET",
            "--target must be a non-empty exact token of at most 512 characters without control characters",
          );
        }
        options.target = value;
      }
      continue;
    }
    const booleanKey = GLOBAL_BOOLEAN_FLAGS.get(token);
    if (booleanKey) {
      options[booleanKey] = true;
      continue;
    }
    remaining.push(token);
  }
  return { remaining, options };
}

function collectBodyProperties(operation: OperationDescriptor): Map<string, Record<string, unknown>> {
  const result = new Map<string, Record<string, unknown>>();
  if (!operation.requestBody) return result;
  for (const media of Object.values(operation.requestBody.content)) {
    for (const [name, schema] of Object.entries(media.bodyProperties)) result.set(name, schema);
  }
  return result;
}

function parseParameterValue(
  raw: string,
  schema: Record<string, unknown>,
  flag: string,
): string | number | boolean {
  if (schemaIncludesType(schema, "string")) return raw;
  if (schemaIncludesType(schema, "integer") || schemaIncludesType(schema, "number")) {
    const value = Number(raw);
    if (!Number.isFinite(value)) {
      throw new UsageError(
        "INVALID_VALUE",
        `Invalid value for ${flag}: expected a finite number`,
        { details: { flag } },
      );
    }
    return value;
  }
  if (schemaIncludesType(schema, "boolean")) {
    if (raw === "true") return true;
    if (raw === "false") return false;
    throw new UsageError(
      "INVALID_VALUE",
      `Invalid value for ${flag}: expected true or false`,
      { details: { flag } },
    );
  }
  return raw;
}

function schemaIncludesType(schema: Record<string, unknown>, type: string): boolean {
  if (schema.type === type) return true;
  if (Array.isArray(schema.type) && schema.type.includes(type)) return true;
  for (const key of ["oneOf", "anyOf"] as const) {
    if (Array.isArray(schema[key]) && schema[key].some((item) =>
      typeof item === "object" && item !== null && !Array.isArray(item) &&
      schemaIncludesType(item as Record<string, unknown>, type))) return true;
  }
  return false;
}

function longestCommandPrefix(tokens: string[], operations: OperationDescriptor[]): OperationDescriptor | undefined {
  return operations
    .filter((operation) => startsWithTokens(tokens, operation.command))
    .sort((left, right) => right.command.length - left.command.length)[0];
}

function isKnownGroup(tokens: string[], operations: OperationDescriptor[]): boolean {
  if (tokens.length === 0) return true;
  return operations.some((operation) => startsWithTokens(operation.command, tokens));
}

function unknownCommand(tokens: string[], operations: OperationDescriptor[]): UsageError {
  const entered = tokens.filter((token) => !token.startsWith("-")).slice(0, 3).join(" ");
  const displayed = displayToken(entered || tokens[0] || "<empty>");
  const candidates = operations.map((operation) => operation.command.join(" "));
  const closest = candidates
    .map((candidate) => ({ candidate, distance: levenshtein(entered, candidate) }))
    .sort((left, right) => left.distance - right.distance)
    .slice(0, 3)
    .map(({ candidate }) => `cookidoo-axi ${candidate} --help`);
  return new UsageError("UNKNOWN_COMMAND", `Unknown command: ${JSON.stringify(displayed)}`, {
    details: { entered: displayed },
    suggestions: closest
  });
}

function unknownFlag(flag: string, allowed: string[]): UsageError {
  const displayed = displayToken(flag);
  const closest = allowed
    .map((candidate) => ({ candidate, distance: levenshtein(flag, candidate) }))
    .sort((left, right) => left.distance - right.distance)[0]?.candidate;
  return new UsageError("UNKNOWN_FLAG", `Unknown flag: ${JSON.stringify(displayed)}`, {
    details: { flag: displayed },
    suggestions: closest ? [`Use ${closest}`] : undefined
  });
}

function unexpectedToken(token: string, allowed: string[] = []): UsageError {
  if (token.startsWith("-")) return unknownFlag(token, allowed);
  const displayed = displayToken(token);
  return new UsageError("EXTRA_ARGUMENT", `Unexpected argument: ${JSON.stringify(displayed)}`, {
    details: { argument: displayed }
  });
}

function displayToken(value: string): string {
  const sanitized = value.replace(/[\u0000-\u001f\u007f]/gu, "?");
  return sanitized.length > 120 ? `${sanitized.slice(0, 117)}...` : sanitized;
}

function splitAssignment(input: string, flag: string): { key: string; value: string } {
  const separator = input.indexOf("=");
  if (separator <= 0) throw new UsageError("INVALID_ASSIGNMENT", `${flag} expects key=value`);
  return { key: input.slice(0, separator), value: input.slice(separator + 1) };
}

function parseBoundedInteger(raw: string, flag: string, minimum: number, maximum: number): number {
  if (!/^\d+$/.test(raw)) throw new UsageError("INVALID_OPTION", `${flag} must be an integer`);
  const value = Number(raw);
  if (value < minimum || value > maximum) {
    throw new UsageError("INVALID_OPTION", `${flag} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function requireValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (value === undefined || value.startsWith("--")) {
    throw new UsageError("MISSING_OPTION_VALUE", `${flag} requires a value`);
  }
  return value;
}

function kebab(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1-$2").replaceAll("_", "-").toLowerCase();
}

function isHelp(token: string | undefined): boolean {
  return token === "--help" || token === "-h";
}

function startsWithTokens(tokens: string[], prefix: string[]): boolean {
  return prefix.every((token, index) => tokens[index] === token);
}

function equalTokens(left: string[], right: string[]): boolean {
  return left.length === right.length && startsWithTokens(left, right);
}

function levenshtein(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        (current[rightIndex - 1] ?? 0) + 1,
        (previous[rightIndex] ?? 0) + 1,
        (previous[rightIndex - 1] ?? 0) + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1)
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length] ?? 0;
}
