import type { OperationDescriptor } from "./types.js";
import {
  commandArgument,
  commandLiteral,
  commandLiterals,
  renderCommand,
  type CommandToken,
} from "./command.js";
import {
  bodyVariantContracts,
  effectiveSafetyPolicy,
  schemaHelpLabel,
  type EffectiveSafetyPolicy,
} from "./present.js";

export function rootHelp(operations: OperationDescriptor[]): string {
  const groups = [...new Set(operations.map((operation) => operation.command[0]))].sort();
  return [
    "cookidoo-axi — agent-friendly Cookidoo API access (unofficial, macOS only)",
    "",
    "Usage:",
    "  cookidoo-axi",
    "  cookidoo-axi <group> <command> [arguments] [options]",
    "  cookidoo-axi operation describe <operation-id>",
    "",
    `API groups: ${groups.join(", ")}`,
    "Utility groups: auth, operation, skill",
    "",
    "Global options:",
    "  --output <toon|json>      Structured stdout format (default: toon)",
    "  --profile <name>          Keychain profile (default: default)",
    "  --lang <locale>           API path language (default: pl)",
    "  --fields <a,b>            Select response fields",
    "  --max-items <n>           Bound arrays and object width (default: 20)",
    "  --full                    Bypass local projections and array/object/string bounds",
    "  --timeout-ms <n>          Per-request deadline (default: 15000)",
    "  --dry-run                 Validate an API mutation without auth/network",
    "  --confirm <exact-target>  Confirm a guarded mutation",
    "  --target <exact-target>   Supply a target when it cannot be derived from UnknownJson",
    "  --allow-unverified        Permit an advertised-only operation with confirmation",
    "  --debug                   Diagnostics to stderr; secrets remain redacted",
    "  -h, --help                Help for exactly this command level",
    "  -v, -V, --version         Bare version fast path",
    "",
    "Examples:",
    "  cookidoo-axi profile get-localized",
    "  cookidoo-axi search recipes --query risotto --limit 5",
    "  cookidoo-axi operation list --output json"
  ].join("\n");
}

export function groupHelp(group: string[], operations: OperationDescriptor[]): string {
  const name = group.join(" ");
  if (name === "auth") {
    return [
      "Usage: cookidoo-axi auth <command> [options]",
      "",
      "Commands:",
      "  doctor                    Verify the native binding; no Keychain item access",
      "  status                    Prompt-free summary; inspect Keychain only on request",
      "  import-env [--env-file]   Import COOKIDOO_EMAIL/PASSWORD into Keychain",
      "  import-feed-env            Import independently supplied feed Basic credentials",
      "  login                     Create and verify a cookie session now",
      "  clear-session             Delete only the cached Keychain cookie session",
      "  remove --confirm <profile> Delete this tool's credentials and session",
      "",
      "Protected reads log in automatically; status and login are not prerequisites.",
      "Auth doctor loads the native binding but reads and writes exactly zero records.",
      "After importing, run the direct read-only check: cookidoo-axi profile get-localized",
      "Bare auth status reads no Keychain records and reports their states as not-checked.",
      "Use --inspect session|market|feed for one record; --inspect all reads all three",
      "sequentially so macOS authorization prompts cannot overlap.",
      "macOS Allow approves one access. Always Allow trusts the executable identified",
      "in the dialog for that Keychain item; macOS may prompt if the executable changes.",
      "If the requester is Node.js, that authorization applies to the exact Node binary,",
      "not only this CLI. Use Allow unless that broader local trust is acceptable.",
      "Separate market-credential, cookie-session, and feed records can prompt separately.",
      "",
      "Examples:",
      "  cookidoo-axi auth import-env --env-file .env",
      "  cookidoo-axi auth doctor --output json"
    ].join("\n");
  }
  if (name === "auth doctor") {
    return [
      "Usage: cookidoo-axi auth doctor [--output toon|json]",
      "",
      "Load and validate the macOS Keychain native binding and report its platform,",
      "architecture, and Node-API version. It constructs no Keychain entry, reads and",
      "writes exactly zero Keychain records, performs no network request, and prompts",
      "for no Keychain authorization.",
      "",
      "Examples:",
      "  cookidoo-axi auth doctor",
      "  cookidoo-axi auth doctor --output json",
    ].join("\n");
  }
  if (name === "auth import-env") {
    return [
      "Usage: cookidoo-axi auth import-env [--env-file <path>] [--profile <name>]",
      "",
      "Reads COOKIDOO_EMAIL and COOKIDOO_PASSWORD without echoing them, then stores",
      "one opaque credential record in macOS Keychain. The source file is unchanged.",
      "Replacing an existing record requires --confirm replace:market:<profile>.",
      "Next, run cookidoo-axi profile get-localized; it is read-only and logs in automatically.",
      "On a macOS prompt, Allow approves one access; Always Allow trusts the executable",
      "identified in the dialog for that item. macOS may prompt if the executable changes.",
      "If it identifies Node.js, the authorization applies to that Node binary, not only",
      "this CLI. Use Allow unless that broader local trust is acceptable.",
      "",
      "Examples:",
      "  cookidoo-axi auth import-env",
      "  cookidoo-axi auth import-env --env-file ./private.env --profile work"
    ].join("\n");
  }
  if (name === "auth import-feed-env") {
    return [
      "Usage: cookidoo-axi auth import-feed-env [--env-file <path>] [--profile <name>]",
      "",
      "Reads COOKIDOO_FEED_USERNAME and COOKIDOO_FEED_PASSWORD from a bounded local",
      "file and stores them in a separate macOS Keychain service. Feed credential",
      "acquisition is not documented by the upstream specification.",
      "Replacing an existing record requires --confirm replace:feed:<profile>.",
      "",
      "Examples:",
      "  cookidoo-axi auth import-feed-env",
      "  cookidoo-axi auth import-feed-env --env-file ./feed.env --profile work",
    ].join("\n");
  }
  if (["auth status", "auth login", "auth clear-session", "auth remove"].includes(name)) {
    const explanation = name === "auth status" ? [
      "Without --inspect, request no Keychain access and report the market-credential,",
      "cookie-session, and feed-credential states as not-checked.",
      "--inspect session|market|feed decrypts only that selected record. --inspect all",
      "decrypts all three sequentially so macOS authorization prompts cannot overlap.",
      "Inspection is optional; prefer cookidoo-axi profile get-localized for a direct",
      "read-only protected check. Separate records can each produce their own prompt.",
      "Allow approves one access. Always Allow trusts the executable identified in the",
      "dialog for that item; macOS may prompt again if the executable changes.",
      "If it identifies Node.js, the authorization applies to that exact Node binary,",
      "not only this CLI. Use Allow unless that broader local trust is acceptable.",
    ] : name === "auth login" ? [
      "Optionally create and verify a cookie session now. Protected reads already log in",
      "automatically; prefer cookidoo-axi profile get-localized for a direct read-only check.",
    ] : name === "auth clear-session" ? [
      "Remove only this profile's cached cookie jar; preserve credentials.",
    ] : [
      "Remove only this tool's market credentials, cookie jar, and feed credentials for the profile.",
    ];
    const examples = name === "auth status" ? [
      "  cookidoo-axi auth status",
      "  cookidoo-axi auth status --inspect session --profile work",
    ] : name === "auth login" ? [
      "  cookidoo-axi auth login --profile work",
      "  cookidoo-axi auth login --output json",
    ] : name === "auth clear-session" ? [
      "  cookidoo-axi auth clear-session --confirm session:default",
      "  cookidoo-axi auth clear-session --profile work --confirm session:work",
    ] : [
      "  cookidoo-axi auth remove --confirm default",
      "  cookidoo-axi auth remove --profile work --confirm work",
    ];
    return [
      `Usage: cookidoo-axi ${name}${name === "auth status" ? " [--inspect session|market|feed|all]" : name === "auth clear-session" ? " --confirm session:<profile>" : name === "auth remove" ? " --confirm <profile>" : ""}`,
      "",
      ...explanation,
      "",
      "Examples:",
      ...examples,
    ].join("\n");
  }
  if (name === "operation list") {
    return [
      "Usage: cookidoo-axi operation list [--group <group>] [--risk <level>] [--query <text>]",
      "  [--max-items <n> | --full] [--output toon|json]",
      "",
      "Filter the bounded operation catalog before it enters agent context.",
      "Risk levels: read, write, destructive, external, device, unverified.",
      "",
      "Examples:",
      "  cookidoo-axi operation list --group created --risk write",
      "  cookidoo-axi operation list --query shopping --output json",
    ].join("\n");
  }
  if (name === "operation describe") {
    return [
      "Usage: cookidoo-axi operation describe <operation-id> [--output toon|json]",
      "",
      "Examples:",
      "  cookidoo-axi operation describe getRecipe",
      "  cookidoo-axi operation describe createCreatedRecipe --output json",
    ].join("\n");
  }
  if (name === "created publish" || name === "created unpublish") {
    const action = name.endsWith("publish") && !name.endsWith("unpublish") ? "publish" : "unpublish";
    return [
      `Usage: cookidoo-axi created ${action} <customerRecipeId> [--dry-run | --confirm <exact-dry-run-token>]`,
      "",
      `${action === "publish" ? "Publish" : "Unpublish"} one customer recipe. This is externally visible and exact-confirmed.`,
      "Run the fully populated request with --dry-run first; it performs no auth or network.",
      "Copy data.safety.confirmationTarget verbatim into --confirm; never reconstruct the token.",
      "",
      "Examples:",
      `  cookidoo-axi created ${action} 01ARZ3NDEKTSV4RRFFQ69G5FAV --dry-run`,
      `  cookidoo-axi created ${action} 01ARZ3NDEKTSV4RRFFQ69G5FAV --dry-run --output json`,
    ].join("\n");
  }
  if (name === "created import") {
    return [
      "Usage: cookidoo-axi created import --recipe-url <https-url> [--partner-id <id>] [--add-to-cookidoo true]",
      "  [--dry-run | --allow-unverified --confirm <exact-dry-run-token>]",
      "",
      "Separates the mutation-sounding query mode from the normal created-recipe list.",
      "Its side effects are not verified, so it is blocked without both safety gates.",
      "Run the exact request with --dry-run, then copy data.safety.confirmationTarget",
      "verbatim into --confirm and add --allow-unverified for execution.",
      "",
      "Examples:",
      "  cookidoo-axi created import --recipe-url https://example.invalid/recipe --dry-run",
      "  cookidoo-axi created import --recipe-url https://example.invalid/recipe --partner-id synthetic --dry-run --output json",
    ].join("\n");
  }
  if (name === "operation") {
    return [
      "Usage: cookidoo-axi operation <command>",
      "",
      "Commands:",
      "  list                       List all 58 mapped OpenAPI operations",
      "  describe <operation-id>    Show inputs, risk, evidence, and response contract",
      "  run <operation-id> ...     Execute through the same validation/safety layer",
      "",
      "Examples:",
      "  cookidoo-axi operation list",
      "  cookidoo-axi operation describe createCreatedRecipe",
      "  cookidoo-axi operation run getRecipe r123456"
    ].join("\n");
  }
  if (name === "skill") {
    return [
      "Usage: cookidoo-axi skill <command> --skills-directory <path>",
      "",
      "Commands:",
      "  install   Install or safely update the bundled cookidoo-axi Agent Skill",
      "  remove    Remove only an unmodified skill managed by this installer",
      "",
      "The skills root is explicit and must already exist as a direct, non-symlink directory.",
      "Use a Codex `.agents/skills` or Claude Code `.claude/skills` root as appropriate.",
      "The managed child directory is always <skills-directory>/cookidoo-axi.",
      "No hooks or parent-directory files are created, changed, or removed.",
      "API-only safety flags such as --dry-run and --allow-unverified are rejected.",
      "",
      "Examples:",
      "  cookidoo-axi skill install --skills-directory /workspace/.agents/skills",
      "  cookidoo-axi skill install --skills-directory /workspace/.claude/skills",
    ].join("\n");
  }
  if (name === "skill install") {
    return [
      "Usage: cookidoo-axi skill install --skills-directory <path> [--output toon|json]",
      "",
      "Copy the exact bundled SKILL.md into <path>/cookidoo-axi and record its SHA-256",
      "and installer version in .cookidoo-axi-managed.json. An unmodified managed",
      "installation is updated idempotently; unmanaged, modified, legacy, symlinked,",
      "or extra-file targets fail without changing them.",
      "",
      "Examples:",
      "  cookidoo-axi skill install --skills-directory /workspace/.agents/skills",
      "  cookidoo-axi skill install --skills-directory /workspace/.claude/skills --output json",
    ].join("\n");
  }
  if (name === "skill remove") {
    return [
      "Usage: cookidoo-axi skill remove --skills-directory <path> --confirm <absolute-skill-directory>",
      "",
      "Remove only an unmodified managed SKILL.md, its management metadata, and the",
      "now-empty cookidoo-axi child directory. The skills root is never removed.",
      "Confirmation must exactly equal the resolved <skills-directory>/cookidoo-axi path,",
      "including when the managed child is already absent.",
      "",
      "Examples:",
      "  cookidoo-axi skill remove --skills-directory /workspace/.agents/skills --confirm /workspace/.agents/skills/cookidoo-axi",
      "  cookidoo-axi skill remove --skills-directory /workspace/.claude/skills --confirm /workspace/.claude/skills/cookidoo-axi --output json",
    ].join("\n");
  }

  const matches = operations.filter((operation) =>
    group.every((token, index) => operation.command[index] === token)
  );
  const rows = matches.map((operation) => {
    const tail = operation.command.slice(group.length).join(" ") || operation.command.at(-1);
    return `  ${tail?.padEnd(28)} ${operation.summary}`;
  });
  if (name === "created") {
    rows.push(
      "  publish                      Publish one created recipe (guarded)",
      "  unpublish                    Unpublish one created recipe (guarded)",
      "  import                       Guarded import-like query mode",
    );
  }
  const examples = matches.slice(0, 2).map((operation) => exampleCommand(operation, false));
  if (examples.length === 1) examples.push(`${examples[0]} --output json`);
  return [
    `Usage: cookidoo-axi ${name} <command> [arguments] [options]`,
    "",
    "Commands:",
    ...rows,
    "",
    `Run 'cookidoo-axi ${name} <command> --help' for exact inputs and examples.`,
    "",
    "Examples:",
    ...examples.map((example) => `  ${example}`),
  ].join("\n");
}

export function operationHelp(operation: OperationDescriptor): string {
  const allPathParameters = operation.parameters.filter((parameter) => parameter.in === "path");
  const pathParameters = allPathParameters.filter((parameter) => parameter.name !== "lang");
  const queryParameters = operation.parameters.filter((parameter) => parameter.in === "query");
  const headerParameters = operation.parameters.filter((parameter) => parameter.in === "header");
  const requiredQueryUsage = queryParameters
    .filter((parameter) => parameter.required)
    .map((parameter) => ` --${kebab(parameter.name)} <value>`)
    .join("");
  const optionalQueryUsage = queryParameters.some((parameter) => !parameter.required)
    ? " [query options]" : "";
  const body = operation.requestBody ? " [body flags | --data <json|@file|->]" : "";
  const positional = pathParameters.map((parameter) => `<${parameter.name}>`).join(" ");
  const pathRows = allPathParameters.flatMap((parameter) => {
    const input = parameter.name === "lang" ? "--lang" : `<${parameter.name}>`;
    const qualifier = parameter.name === "lang"
      ? "path value; CLI default is applied"
      : parameter.required ? "required path argument" : "path argument";
    return parameterRows(input, parameter.schema, qualifier, parameter.description);
  });
  const queryRows = queryParameters.flatMap((parameter) => {
    const flag = parameter.name === "filters" ? "--filter <key=value>" : `--${kebab(parameter.name)}`;
    const qualifier = queryQualifier(operation.operationId, parameter.name, parameter.required);
    const rows = parameterRows(flag, parameter.schema, qualifier, parameter.description);
    if (parameter.name !== "filters") return rows;
    const properties = isObject(parameter.schema.properties)
      ? Object.keys(parameter.schema.properties) : [];
    return properties.length === 0 ? rows : [
      ...rows,
      `    accepted keys: ${properties.join(", ")}`,
      "    bounded safe extension keys are also accepted; duplicate emitted keys are rejected",
    ];
  });
  if (operation.operationId === "getCollectionFeedPage") {
    queryRows.push(
      "  --page-before-seconds <integer; min=0> (explicit Unix seconds)",
      "  --page-before-milliseconds <integer; min=0> (explicit Unix milliseconds)",
    );
  }
  const headerRows = headerParameters.flatMap((parameter) =>
    parameterRows(parameter.name, parameter.schema, "set automatically", parameter.description));
  const bodyRows = requestBodyRows(operation);
  const requestMedia = operation.requestBody ? Object.keys(operation.requestBody.content).join(", ") : "none";
  const policy = effectiveSafetyPolicy(operation);
  const safetyRows = safetyHelpRows(policy);
  const friendlyExample = exampleCommand(operation, false);
  const rawExample = exampleCommand(operation, true);
  const describeExample = renderCommand([
    ...commandLiterals(["cookidoo-axi", "operation", "describe"]),
    commandArgument(operation.operationId),
  ]);
  return [
    `Usage: cookidoo-axi ${operation.command.join(" ")} ${positional}${requiredQueryUsage}${optionalQueryUsage}${body}`
      .replace(/\s+/gu, " ").trimEnd(),
    "",
    operation.summary,
    operation.description ? `\n${singleParagraph(operation.description)}` : "",
    "",
    `OpenAPI: ${operation.operationId} · ${operation.method} ${operation.path}`,
    `Auth: ${operation.security} · Evidence: ${operation.status} · Response: ${operation.responseShape}`,
    `Effective risk: ${policy.default.level}${policy.conditionalCases.length > 0 ? " (conditional cases below)" : ""}`,
    `Request media: ${requestMedia}`,
    "",
    ...(pathRows.length ? ["Path inputs:", ...pathRows, ""] : []),
    ...(queryRows.length ? ["Query options:", ...queryRows, ""] : []),
    ...(headerRows.length ? ["Automatic request inputs:", ...headerRows, ""] : []),
    ...(bodyRows.length ? ["Body options:", ...bodyRows, ""] : []),
    "Output options:",
    "  --fields <a,b> · --max-items <n> · --full · --output <toon|json>",
    "",
    ...safetyRows,
    "",
    "Examples:",
    `  ${friendlyExample}`,
    `  ${describeExample}`,
    `  ${rawExample}`,
  ].filter((line) => line !== undefined).join("\n");
}

function requestBodyRows(operation: OperationDescriptor): string[] {
  if (operation.requestBody === null) return [];
  const rows: string[] = [];
  for (const [mediaType, media] of Object.entries(operation.requestBody.content)) {
    const variants = bodyVariantContracts(media.schema);
    rows.push(
      `  JSON body (${operation.requestBody.required ? "required" : "optional"}; ${mediaType})`,
      `  schema: <${schemaHelpLabel(media.schema)}>`,
    );
    for (const [name, propertySchema] of Object.entries(media.bodyProperties)) {
      const requiredIn = variants
        .filter((variant) => variant.required.includes(name))
        .map((variant) => variant.variant);
      const required = requiredIn.length === variants.length && variants.length > 0
        ? "required"
        : requiredIn.length > 0 ? `required in variant ${requiredIn.join(",")}` : "optional";
      const repeatable = schemaHasType(propertySchema, "array") ? "; repeatable" : "";
      const route = operation.operationId === "patchCreatedRecipe" && name === "workStatus"
        ? "; raw operation only—use created publish/unpublish"
        : "";
      rows.push(`  --${kebab(name)} <${schemaHelpLabel(propertySchema)}> (${required}${repeatable}${route})`);
    }
    if (variants.length > 1) {
      rows.push("  variants:");
      for (const variant of variants) {
        const required = variant.required.length === 0 ? "none" : variant.required.join(", ");
        const accepted = variant.properties.length === 0 ? "unconstrained" : variant.properties.join(", ");
        rows.push(`    ${variant.variant}: requires ${required}; properties ${accepted}`);
      }
    }
    if (Object.keys(media.bodyProperties).length === 0) {
      rows.push("  no named property flags are modeled; supply the complete JSON with --data");
    }
  }
  rows.push(
    "  --data <json|@file|->       Complete JSON body",
    "  --set <path=value>          Set a JSON field; repeatable",
  );
  return rows;
}

function parameterRows(
  input: string,
  schema: Record<string, unknown>,
  qualifier: string,
  description: string | undefined,
): string[] {
  const rows = [`  ${input} <${schemaHelpLabel(schema)}> (${qualifier})`];
  if (description !== undefined) rows.push(`    ${singleParagraph(description)}`);
  return rows;
}

function queryQualifier(operationId: string, name: string, required: boolean): string {
  const requirement = required ? "required" : "optional";
  if (name === "filters") return `${requirement}; repeatable exploded key=value`;
  if (operationId === "listCreatedRecipes" &&
      ["recipeUrl", "partnerId", "addToCookidoo"].includes(name)) {
    return `${requirement}; import-like—use created import, not created list`;
  }
  if (operationId === "getCollectionFeedPage" && name === "pageBefore") {
    return `${requirement}; ISO date-time or explicit-unit numeric alias`;
  }
  return requirement;
}

function safetyHelpRows(policy: EffectiveSafetyPolicy): string[] {
  const rows = ["Safety:", `  default: ${policyLabel(policy.default)}`];
  for (const conditional of policy.conditionalCases) {
    rows.push(`  when ${conditional.when}: ${policyLabel(conditional)}`);
    if (conditional.preferredCommand !== undefined) {
      rows.push(`    preferred route: ${conditional.preferredCommand}`);
    }
  }
  const allCases = [policy.default, ...policy.conditionalCases];
  if (allCases.some((entry) => entry.mutation)) {
    rows.push("  Preview a fully populated mutation with --dry-run (no auth or network)." );
  }
  if (allCases.some((entry) => entry.requiresConfirmation)) {
    rows.push(
      "  For a guarded request, copy data.safety.confirmationTarget from that exact dry run",
      "  verbatim into --confirm; never construct or reuse a token for a different request.",
    );
  }
  if (allCases.some((entry) => entry.allowUnverifiedRequired)) {
    rows.push("  Advertised-only execution also requires --allow-unverified.");
  }
  return rows;
}

function policyLabel(entry: EffectiveSafetyPolicy["default"]): string {
  const traits: string[] = [entry.level];
  if (entry.destructive && entry.level !== "destructive") traits.push("destructive");
  if (entry.externallyVisible) traits.push("externally visible");
  if (entry.requiresConfirmation) traits.push("exact-confirmed");
  if (entry.allowUnverifiedRequired) traits.push("requires --allow-unverified");
  return traits.join(", ");
}

function exampleCommand(operation: OperationDescriptor, raw: boolean): string {
  const command: CommandToken[] = raw
    ? [
        ...commandLiterals(["cookidoo-axi", "operation", "run"]),
        commandArgument(operation.operationId),
      ]
    : commandLiterals(["cookidoo-axi", ...operation.command]);
  for (const parameter of operation.parameters.filter((entry) =>
    entry.in === "path" && entry.name !== "lang")) {
    command.push(commandArgument(`<${parameter.name}>`));
  }
  for (const parameter of operation.parameters.filter((entry) =>
    entry.in === "query" && entry.required)) {
    command.push(
      commandLiteral(`--${kebab(parameter.name)}`),
      commandArgument(exampleParameterValue(operation.operationId, parameter.name)),
    );
  }
  if (operation.requestBody !== null) {
    const media = Object.values(operation.requestBody.content)[0];
    const serialized = media?.example === undefined ? undefined : JSON.stringify(media.example);
    command.push(
      commandLiteral("--data"),
      commandArgument(serialized !== undefined && serialized.length <= 240
        ? serialized : "@request.json"),
    );
  }
  if (operation.method !== "GET") command.push(commandLiteral("--dry-run"));
  if (raw) command.push(commandLiteral("--output"), commandArgument("json"));
  return renderCommand(command);
}

function exampleParameterValue(operationId: string, name: string): string {
  if (operationId === "getCollectionFeedPage" && name === "pageBefore") {
    return "2026-08-17T00:00:00Z";
  }
  return `<${name}>`;
}

function schemaHasType(schema: Record<string, unknown>, type: string): boolean {
  if (schema.type === type) return true;
  if (Array.isArray(schema.type) && schema.type.includes(type)) return true;
  for (const key of ["oneOf", "anyOf"] as const) {
    if (Array.isArray(schema[key]) && schema[key].some((entry) =>
      isObject(entry) && schemaHasType(entry, type))) return true;
  }
  return false;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function kebab(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1-$2").replaceAll("_", "-").toLowerCase();
}

function singleParagraph(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
