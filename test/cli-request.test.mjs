import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { prepareRequest, publicRequestView } from "../dist/api/request.js";
import { OPENAPI_MANIFEST, getOperationById } from "../dist/api/spec.js";
import { buildRequestBody } from "../dist/cli/input.js";
import { defaultOptions, parseInvocation } from "../dist/cli/parser.js";

const operations = OPENAPI_MANIFEST.operations;

function usageCode(code) {
  return (error) => {
    assert.equal(error?.name, "UsageError");
    assert.equal(error?.code, code);
    return true;
  };
}

test("parser has bounded non-interactive defaults and local home/help commands", () => {
  assert.deepEqual(defaultOptions(), {
    output: "toon",
    profile: "default",
    lang: "pl",
    timeoutMs: 15_000,
    maxItems: 20,
    full: false,
    dryRun: false,
    allowUnverified: false,
    debug: false,
  });
  assert.equal(parseInvocation([], operations).kind, "home");
  assert.equal(parseInvocation(["--help"], operations).kind, "root-help");
  assert.deepEqual(parseInvocation(["auth", "status"], operations), {
    kind: "auth-status",
    inspection: "none",
    options: defaultOptions(),
  });
  assert.equal(
    parseInvocation(["auth", "status", "--inspect", "session"], operations).inspection,
    "session",
  );
  for (const argv of [
    ["auth", "--dry-run"],
    ["--dry-run", "auth", "doctor"],
    ["auth", "status", "--dry-run"],
    ["auth", "login", "--dry-run"],
    ["auth", "import-env", "--dry-run"],
    ["auth", "import-feed-env", "--dry-run"],
    ["auth", "clear-session", "--dry-run"],
    ["auth", "remove", "--dry-run"],
  ]) {
    assert.throws(() => parseInvocation(argv, operations), (error) => {
      assert.equal(error?.name, "UsageError");
      assert.equal(error?.code, "INVALID_OPTION");
      assert.equal(error?.exitCode, 2);
      assert.deepEqual(error?.details, { flag: "--dry-run", command: "auth" });
      assert.match(error?.suggestion ?? "", /only API operations/u);
      return true;
    });
  }
  assert.throws(
    () => parseInvocation(["auth", "status", "--inspect", "unknown"], operations),
    usageCode("INVALID_OPTION"),
  );
  assert.equal(parseInvocation(["operation", "list"], operations).kind, "operation-list");
  assert.deepEqual(
    parseInvocation([
      "operation", "list", "--group", "created", "--risk", "write", "--query", "copy",
    ], operations).filter,
    { group: "created", risk: "write", query: "copy" },
  );
  assert.throws(
    () => parseInvocation(["operation", "list", "--risk", "advertised"], operations),
    usageCode("INVALID_OPTION"),
  );
  assert.equal(parseInvocation(["created", "--help"], operations).kind, "group-help");
  assert.equal(parseInvocation(["created", "create", "--help"], operations).kind, "operation-help");
  assert.deepEqual(
    parseInvocation(["skill", "install", "--skills-directory", "/opt/skills"], operations),
    { kind: "skill-install", skillsDirectory: "/opt/skills", options: defaultOptions() },
  );
  assert.deepEqual(
    parseInvocation([
      "skill", "remove", "--skills-directory", "/opt/skills",
      "--confirm", "/opt/skills/cookidoo-axi",
    ], operations),
    {
      kind: "skill-remove",
      skillsDirectory: "/opt/skills",
      options: { ...defaultOptions(), confirm: "/opt/skills/cookidoo-axi" },
    },
  );
  assert.equal(parseInvocation(["skill", "--help"], operations).kind, "group-help");
  assert.equal(parseInvocation(["skill", "install", "--help"], operations).kind, "group-help");
  assert.throws(
    () => parseInvocation(["skill", "install"], operations),
    usageCode("MISSING_OPTION"),
  );
  for (const argv of [
    ["skill", "install", "--skills-directory", ""],
    ["skill", "install", "--skills-directory", "bad\npath"],
    ["skill", "install", "--skills-directory", "/opt/skills", "--dry-run"],
    ["skill", "install", "--skills-directory", "/opt/skills", "--allow-unverified"],
    ["skill", "install", "--skills-directory", "/opt/skills", "--target", "x"],
    ["skill", "install", "--skills-directory", "/opt/skills", "--confirm", "x"],
    [
      "skill", "remove", "--skills-directory", "/opt/skills",
      "--confirm", "/opt/skills/cookidoo-axi", "--dry-run",
    ],
  ]) {
    assert.throws(() => parseInvocation(argv, operations), usageCode("INVALID_OPTION"));
  }
  for (const argv of [
    ["setup", "codex", "--directory", "."],
    ["setup", "remove", "--directory", "."],
    ["hook", "session-start"],
  ]) {
    assert.throws(() => parseInvocation(argv, operations), (error) => {
      assert.equal(error?.code, "LEGACY_COMMAND_REMOVED");
      assert.match(error.suggestion, /^cookidoo-axi skill /u);
      return true;
    });
  }
});

test("parser resolves friendly and raw operation routes with typed flags", () => {
  const friendly = parseInvocation([
    "search", "recipes",
    "--query", "soup",
    "--limit", "5",
    "--filter", "difficulty=easy",
    "--output", "json",
    "--max-items", "3",
  ], operations);
  assert.equal(friendly.kind, "operation");
  assert.equal(friendly.operation.operationId, "search");
  assert.equal(friendly.rawOperation, false);
  assert.deepEqual(friendly.path, { lang: "pl" });
  assert.deepEqual(friendly.query, { query: "soup", limit: "5" });
  assert.deepEqual(friendly.filters, [{ key: "difficulty", value: "easy" }]);
  assert.equal(friendly.options.output, "json");
  assert.equal(friendly.options.maxItems, 3);

  const raw = parseInvocation(["operation", "run", "getRecipe", "r123"], operations);
  assert.equal(raw.kind, "operation");
  assert.equal(raw.rawOperation, true);
  assert.deepEqual(raw.path, { recipeId: "r123", lang: "pl" });

  const body = parseInvocation([
    "created", "create", "--recipe-name", "Offline fixture", "--serving-size", "2.5",
  ], operations);
  assert.equal(body.kind, "operation");
  assert.deepEqual(body.bodyFields.map(({ path, value, array }) => ({ path, value, array })), [
    { path: "recipeName", value: "Offline fixture", array: false },
    { path: "servingSize", value: "2.5", array: false },
  ]);

  const inferred = parseInvocation([
    "created", "update", "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    "--instructions", '{"type":"STEP","text":"Miksuj 2 s/obr. 6."}',
    "--infer-thermomix-settings",
  ], operations);
  assert.equal(inferred.kind, "operation");
  assert.equal(inferred.operationMode, "created-edit");
  assert.equal(inferred.inferThermomixSettings, true);
});

test("global safety options remain exact and can appear before or after a command", () => {
  const invocation = parseInvocation([
    "--dry-run",
    "created", "delete", "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    "--confirm", "created-recipe:01ARZ3NDEKTSV4RRFFQ69G5FAV:delete",
    "--allow-unverified",
  ], operations);
  assert.equal(invocation.kind, "operation");
  assert.equal(invocation.options.dryRun, true);
  assert.equal(invocation.options.allowUnverified, true);
  assert.equal(invocation.options.confirm, "created-recipe:01ARZ3NDEKTSV4RRFFQ69G5FAV:delete");
  assert.equal(invocation.path.customerRecipeId, "01ARZ3NDEKTSV4RRFFQ69G5FAV");
});

test("parser rejects near-miss flags, bad values, ambiguous body input, and extra positionals", () => {
  assert.throws(
    () => parseInvocation(["search", "recipes", "--qurey", "soup"], operations),
    (error) => {
      assert.equal(error.code, "UNKNOWN_FLAG");
      assert.match(error.message, /--qurey/u);
      assert.deepEqual(error.details, { flag: "--qurey" });
      assert.ok(error.suggestions.some((suggestion) => suggestion.includes("--query")));
      return true;
    },
  );
  assert.throws(
    () => parseInvocation(["totally-unknown"], operations),
    (error) => {
      assert.equal(error.code, "UNKNOWN_COMMAND");
      assert.match(error.message, /totally-unknown/u);
      assert.deepEqual(error.details, { entered: "totally-unknown" });
      return true;
    },
  );
  assert.throws(
    () => parseInvocation(["created", "list", "--add-to-cookidoo", "maybe"], operations),
    usageCode("INVALID_VALUE"),
  );
  assert.throws(
    () => parseInvocation([
      "created", "create", "--data", '{"recipeName":"x"}', "--recipe-name", "y",
    ], operations),
    usageCode("CONFLICTING_INPUT"),
  );
  assert.throws(
    () => parseInvocation(["recipe", "get"], operations),
    usageCode("MISSING_ARGUMENT"),
  );
  assert.throws(
    () => parseInvocation(["recipe", "get", "r1", "extra"], operations),
    usageCode("EXTRA_ARGUMENT"),
  );
  assert.throws(
    () => parseInvocation(["--timeout-ms", "999", "recipe", "get", "r1"], operations),
    usageCode("INVALID_OPTION"),
  );
  assert.throws(
    () => parseInvocation(["created", "create", "--recipe-name"], operations),
    usageCode("MISSING_OPTION_VALUE"),
  );
  assert.throws(
    () => parseInvocation(["device", "link", "--target", "fixture\ncontrol"], operations),
    usageCode("INVALID_TARGET"),
  );
  assert.throws(
    () => parseInvocation([
      "operation", "run", "patchCreatedRecipe", "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      "--infer-thermomix-settings",
    ], operations),
    usageCode("UNKNOWN_FLAG"),
  );
  assert.throws(
    () => parseInvocation([
      "created", "update", "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      "--infer-thermomix-settings", "--infer-thermomix-settings",
    ], operations),
    usageCode("INVALID_OPTION"),
  );
  assert.throws(
    () => parseInvocation([
      "created", "publish", "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      "--infer-thermomix-settings",
    ], operations),
    usageCode("UNKNOWN_FLAG"),
  );
});

test("parser classifies and names unexpected flags and positional arguments", () => {
  for (const argv of [
    ["operation", "describe", "getRecipe", "--definitely-wrong"],
    ["auth", "doctor", "--definitely-wrong"],
  ]) {
    assert.throws(
      () => parseInvocation(argv, operations),
      (error) => {
        assert.equal(error?.code, "UNKNOWN_FLAG");
        assert.match(error.message, /--definitely-wrong/u);
        assert.deepEqual(error.details, { flag: "--definitely-wrong" });
        return true;
      },
    );
  }

  for (const { argv, argument } of [
    { argv: ["recipe", "get", "r123", "unexpected"], argument: "unexpected" },
    { argv: ["auth", "status", "unexpected"], argument: "unexpected" },
    {
      argv: ["skill", "install", "--skills-directory", "/opt/skills", "unexpected"],
      argument: "unexpected",
    },
  ]) {
    assert.throws(
      () => parseInvocation(argv, operations),
      (error) => {
        assert.equal(error?.code, "EXTRA_ARGUMENT");
        assert.match(error.message, new RegExp(argument, "u"));
        assert.deepEqual(error.details, { argument });
        return true;
      },
    );
  }

  assert.throws(
    () => parseInvocation(["operation", "nonsense", "injected"], operations),
    (error) => {
      assert.equal(error?.code, "UNKNOWN_COMMAND");
      assert.match(error.message, /nonsense/u);
      assert.deepEqual(error.details, { subcommand: "nonsense" });
      return true;
    },
  );

  for (const { argv, flag } of [
    {
      argv: [
        "created", "import", "--recipe-url", "https://example.invalid/recipe",
        "--add-to-cookidoo", "maybe", "--dry-run",
      ],
      flag: "--add-to-cookidoo",
    },
    {
      argv: ["organize", "custom-list", "list", "--page", "bananas"],
      flag: "--page",
    },
  ]) {
    assert.throws(
      () => parseInvocation(argv, operations),
      (error) => {
        assert.equal(error?.code, "INVALID_VALUE");
        assert.match(error.message, new RegExp(flag, "u"));
        assert.deepEqual(error.details, { flag });
        return true;
      },
    );
  }
});

test("body builder handles inline/file JSON and repeated nested array flags", async (t) => {
  assert.deepEqual(
    await buildRequestBody('{"recipeName":"Offline fixture"}', [], true),
    { recipeName: "Offline fixture" },
  );
  assert.deepEqual(await buildRequestBody(undefined, [
    { path: "metadata.ids", value: "first", array: true },
    { path: "metadata.ids", value: '["second","third"]', array: true },
    { path: "metadata.enabled", value: "true", array: false },
    { path: "count", value: "2", array: false },
  ], true), {
    metadata: { ids: ["first", "second", "third"], enabled: true },
    count: 2,
  });

  const root = await mkdtemp(join(tmpdir(), "cookidoo-axi-body-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bodyPath = join(root, "body.json");
  await writeFile(bodyPath, '{"text":"from fixture"}', "utf8");
  assert.deepEqual(await buildRequestBody(`@${bodyPath}`, [], true), { text: "from fixture" });
});

test("schema property flags preserve string literals and strictly parse typed values", async () => {
  for (const literal of ["true", "null", "42", "{bad}", '["x"]', '"quoted"']) {
    const invocation = parseInvocation([
      "note", "create", "--recipe-id", "r123", "--text", literal,
    ], operations);
    assert.equal(invocation.kind, "operation");
    assert.deepEqual(
      await buildRequestBody(undefined, invocation.bodyFields, true),
      { recipeId: "r123", text: literal },
    );
  }

  const rating = parseInvocation([
    "rating", "set", "r123", "--rating", "5",
  ], operations);
  assert.equal(rating.kind, "operation");
  assert.deepEqual(await buildRequestBody(undefined, rating.bodyFields, true), { rating: 5 });

  const invalidRating = parseInvocation([
    "rating", "set", "r123", "--rating", "five",
  ], operations);
  assert.equal(invalidRating.kind, "operation");
  await assert.rejects(
    buildRequestBody(undefined, invalidRating.bodyFields, true),
    (error) => {
      assert.equal(error?.code, "INVALID_VALUE");
      assert.match(error.message, /--rating/u);
      assert.deepEqual(error.details, { flag: "--rating" });
      return true;
    },
  );

  const invalidReference = parseInvocation([
    "created", "update", "01ARZ3NDEKTSV4RRFFQ69G5FAV", "--yield", "{bad}",
  ], operations);
  assert.equal(invalidReference.kind, "operation");
  await assert.rejects(
    buildRequestBody(undefined, invalidReference.bodyFields, true),
    (error) => {
      assert.equal(error?.code, "INVALID_VALUE");
      assert.match(error.message, /--yield/u);
      assert.deepEqual(error.details, { flag: "--yield" });
      return true;
    },
  );
});

test("body builder rejects malformed, oversized, conflicting, and prototype-polluting paths", async () => {
  await assert.rejects(buildRequestBody(undefined, [], true), usageCode("MISSING_BODY"));
  await assert.rejects(buildRequestBody("{bad", [], true), usageCode("INVALID_JSON"));
  await assert.rejects(
    buildRequestBody("x".repeat(1_000_001), [], true),
    usageCode("BODY_TOO_LARGE"),
  );
  for (const path of ["__proto__.polluted", "safe.constructor.value", "prototype.x", "..."]) {
    await assert.rejects(
      buildRequestBody(undefined, [{ path, value: "yes", array: false }], true),
      usageCode("INVALID_BODY_PATH"),
    );
  }
  await assert.rejects(
    buildRequestBody(undefined, [
      { path: "parent", value: "scalar", array: false },
      { path: "parent.child", value: "value", array: false },
    ], true),
    usageCode("BODY_PATH_CONFLICT"),
  );
  assert.equal({}.polluted, undefined);
});

test("request preparation encodes paths, query, filters, and JSON body deterministically", () => {
  const search = prepareRequest({
    operation: getOperationById("search"),
    baseUrl: "https://cookidoo.pl",
    path: { lang: "pl" },
    query: { query: "zupa & chleb", limit: 5 },
    filters: [{ key: "difficulty", value: "easy" }],
    headers: { "X-Fixture": "safe" },
    body: undefined,
  });
  assert.equal(search.method, "GET");
  assert.equal(search.url.origin, "https://cookidoo.pl");
  assert.equal(search.url.pathname, "/search/api/pl/search");
  assert.equal(search.url.searchParams.get("query"), "zupa & chleb");
  assert.equal(search.url.searchParams.get("limit"), "5");
  assert.equal(search.url.searchParams.get("difficulty"), "easy");

  const created = prepareRequest({
    operation: getOperationById("createCreatedRecipe"),
    baseUrl: "https://cookidoo.pl",
    path: { lang: "pl" },
    query: {},
    filters: [],
    headers: { "X-Requested-With": "xmlhttprequest" },
    body: { recipeName: "Offline fixture" },
  });
  assert.equal(created.headers["Content-Type"], "application/json");
  assert.equal(created.body, '{"recipeName":"Offline fixture"}');

  const encoded = prepareRequest({
    operation: getOperationById("getRecipe"),
    baseUrl: "https://cookidoo.pl",
    path: { lang: "pl", recipeId: "r1/../not-a-segment" },
    query: {}, filters: [], headers: {}, body: undefined,
  });
  assert.equal(encoded.url.pathname, "/recipes/recipe/pl/r1%2F..%2Fnot-a-segment");
});

test("request preparation will not send to lookalike, insecure, or credential-bearing bases", () => {
  const operation = getOperationById("getRecipe");
  const prepare = (baseUrl) => prepareRequest({
    operation,
    baseUrl,
    path: { lang: "pl", recipeId: "r1" },
    query: {}, filters: [], headers: {}, body: undefined,
  });
  for (const base of [
    "http://cookidoo.pl",
    "https://cookidoo.pl.evil.invalid",
    "https://user:pass@cookidoo.pl",
    "not a url",
  ]) {
    assert.throws(
      () => prepare(base),
      (error) => ["INVALID_BASE_URL", "UNSAFE_BASE_URL"].includes(error.code),
      base,
    );
  }
});

test("search filters honor extensible schemas while duplicate and unsafe keys fail closed", () => {
  const operation = getOperationById("search");
  const prepare = (filters, query = {}) => prepareRequest({
    operation,
    baseUrl: "https://cookidoo.pl",
    path: { lang: "pl" },
    query,
    filters,
    headers: {},
    body: undefined,
  });
  assert.equal(
    prepare([{ key: "providerExtension", value: "x" }]).url.searchParams.get("providerExtension"),
    "x",
  );
  for (const key of ["__proto__", "constructor", "bad\nkey", "x".repeat(129)]) {
    assert.throws(
      () => prepare([{ key, value: "x" }]),
      usageCode("UNKNOWN_FILTER"),
    );
  }
  assert.throws(
    () => prepare([{ key: "difficulty", value: "easy" }], { difficulty: "hard" }),
    usageCode("DUPLICATE_QUERY"),
  );
});

test("public request views remove secret headers but retain reproducible request data", () => {
  const request = prepareRequest({
    operation: getOperationById("createRecipeNote"),
    baseUrl: "https://cookidoo.pl",
    path: { lang: "pl" },
    query: {},
    filters: [],
    headers: {
      Authorization: "Bearer fixture-token",
      Cookie: "session=fixture",
      "X-CSRF-Token": "fixture-csrf",
      "X-Requested-With": "xmlhttprequest",
    },
    body: { recipeId: "r123", text: "Offline note fixture" },
  });
  const view = publicRequestView(request);
  assert.deepEqual(view.headers, {
    Accept: "application/json",
    "X-Requested-With": "xmlhttprequest",
    "Content-Type": "application/json",
  });
  assert.deepEqual(view.body, { recipeId: "r123", text: "Offline note fixture" });
  assert.doesNotMatch(JSON.stringify(view), /fixture-(?:token|csrf)|session=fixture/u);
});
