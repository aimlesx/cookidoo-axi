import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

import { decode } from "@toon-format/toon";

import {
  commandArgument,
  commandLiteral,
  commandLiterals,
  renderCommand,
} from "../dist/cli/command.js";

import {
  OutputBoundaryError,
  assertSerializedDocument,
  ensureFullCommand,
  normalizeCollection,
  normalizeDetail,
  redactSecrets,
  sanitizeDiagnostic,
  selectFields,
  serializeOutput,
  toJsonValue,
  truncateJsonObjects,
  truncateJsonStrings,
  writeOutput,
} from "../dist/output/index.js";

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function outputError(code) {
  return (error) => {
    assert.ok(error instanceof OutputBoundaryError);
    assert.equal(error.code, code);
    return true;
  };
}

function shellArgv(command) {
  const script = [
    `set -- ${command}`,
    `printf '%s\\0' "$@"`,
  ].join("\n");
  const output = execFileSync("/bin/sh", ["-c", script], { encoding: "utf8" });
  return output.length === 0 ? [] : output.slice(0, -1).split("\0");
}

test("nested secret keys are conservatively redacted without mutating input", () => {
  const source = {
    id: "fixture",
    credentials: { username: "offline@example.invalid", password: "fixture-pass" },
    nested: [{ access_token: "token-value", display: "safe" }],
    "X-API-Key": "key-value",
  };
  const before = structuredClone(source);
  const result = redactSecrets(toJsonValue(source));

  assert.deepEqual(source, before);
  assert.deepEqual(plain(result.value), {
    id: "fixture",
    credentials: "[REDACTED]",
    nested: [{ access_token: "[REDACTED]", display: "safe" }],
    "X-API-Key": "[REDACTED]",
  });
  assert.deepEqual(result.paths, ["$.credentials", "$.nested[0].access_token", '$["X-API-Key"]']);
});

test("credential query parameters are redacted inside nested URLs", () => {
  const sentinel = "SYNTHETIC_TOKEN_DO_NOT_USE";
  const outer = new URL("https://cookidoo.pl/created-recipes/pl");
  outer.searchParams.set(
    "recipeUrl",
    `https://example.invalid/recipe?access_token=${sentinel}&visible=yes`,
  );
  const result = redactSecrets(toJsonValue({ url: outer.toString() }));
  const serialized = JSON.stringify(result.value);
  assert.doesNotMatch(serialized, new RegExp(sentinel, "u"));
  assert.match(serialized, /REDACTED/u);
  assert.deepEqual(result.paths, ["$.url"]);
});

test("credential-like assignments inside ordinary string values are fully redacted", () => {
  const result = redactSecrets(toJsonValue({
    recipeId: "token=SYNTHETIC_VALUE",
    note: "Bearer SYNTHETIC_BEARER",
    nested: "prefix password='SYNTHETIC PASSWORD' suffix",
    custom: "myPassword=SYNTHETIC_CUSTOM",
    embeddedUrl: "prefix https://user:SYNTHETIC_PASS@example.invalid/path suffix",
    safe: "protein=12g",
  }));
  assert.deepEqual(plain(result.value), {
    recipeId: "[REDACTED]",
    note: "[REDACTED]",
    nested: "[REDACTED]",
    custom: "[REDACTED]",
    embeddedUrl: "[REDACTED]",
    safe: "protein=12g",
  });
  assert.deepEqual(result.paths, [
    "$.recipeId", "$.note", "$.nested", "$.custom", "$.embeddedUrl",
  ]);
});

test("normalization redacts before selection and preserves redaction markers during truncation", () => {
  const envelope = normalizeDetail(
    {
      name: "A deliberately long offline recipe title",
      password: "never-emit-this",
      ignored: { token: "also-never-emit-this" },
    },
    {
      command: "cookidoo-axi recipe get r123",
      fields: "name,password",
      maxStringCharacters: 8,
      context: { cookie: "fixture-cookie", market: "pl" },
      next: [{
        command: "cookidoo-axi auth status",
        description: "Retry with myPassword=fixture-password",
      }],
    },
  );

  assert.equal(envelope.kind, "detail");
  assert.deepEqual(plain(envelope.data), {
    name: "A delib…",
    password: "[REDACTED]",
  });
  assert.deepEqual(plain(envelope.context), { cookie: "[REDACTED]", market: "pl" });
  assert.equal(envelope.selection.applied, true);
  assert.equal(envelope.redaction.applied, true);
  assert.equal(envelope.redaction.count, 3);
  assert.equal(envelope.truncation.mode, "content");
  assert.equal(envelope.truncation.fullCommand, "cookidoo-axi recipe get r123 --full");
  assert.doesNotMatch(JSON.stringify(envelope), /fixture-(?:secret|token|password|cookie)/u);
  assert.equal(envelope.next[0].command, envelope.truncation.fullCommand);
  assert.equal(envelope.next[1].command, "cookidoo-axi auth status");
  assert.equal(envelope.next[1].description, "[REDACTED]");
});

test("credential-bearing commands are omitted instead of rewriting POSIX quoting", () => {
  const command = [
    "cookidoo-axi organize move-recipe",
    "--recipe-id 'token=a'",
    "--target-list-id 'x;printf AXI_PWNED'",
    "--src-list-id 'token=b'",
    "--target-list-type 'CUSTOM'",
    "--src-list-type 'CUSTOM'",
  ].join(" ");
  const embeddedQuoteCommand = renderCommand([
    ...commandLiterals(["cookidoo-axi", "note", "create"]),
    commandLiteral("--text"),
    commandArgument("password='fixture-secret'"),
    commandLiteral("--recipe-id"),
    commandArgument("x;printf AXI_PWNED"),
  ]);
  const envelope = normalizeDetail({ ok: true }, {
    command: "cookidoo-axi fixture",
    next: [command, embeddedQuoteCommand],
  });
  assert.deepEqual(envelope.next, []);
});

test("full escape hatch does not confuse quoted user data with the --full flag", () => {
  const command = "cookidoo-axi search recipes --query 'cake --full easy' --output 'json'";
  const expanded = ensureFullCommand(command);
  assert.equal(expanded, `${command} --full`);
  assert.deepEqual(shellArgv(expanded), [
    "cookidoo-axi", "search", "recipes", "--query", "cake --full easy",
    "--output", "json", "--full",
  ]);
  assert.throws(
    () => ensureFullCommand("cookidoo-axi note create --text 'password=fixture-secret'"),
    outputError("OUTPUT_INVALID_OPTION"),
  );
});

test("collection normalization makes local and upstream incompleteness explicit", () => {
  const envelope = normalizeCollection(
    [
      { id: 1, title: "one" },
      { id: 2, title: "two" },
      { id: 3, title: "three" },
    ],
    {
      command: "cookidoo-axi created list",
      maxItems: 2,
      total: 10,
      hasMore: true,
    },
  );
  assert.equal(envelope.data.length, 2);
  assert.deepEqual(envelope.completeness, {
    state: "partial",
    shown: 2,
    total: 10,
    hasMore: true,
  });
  assert.equal(envelope.truncation.mode, "collection");
  assert.equal(envelope.truncation.omittedItems, 1);
  assert.equal(envelope.truncation.fullCommand, "cookidoo-axi created list --full");

  const unknown = normalizeCollection([], { command: "cookidoo-axi search recipes" });
  assert.equal(unknown.completeness.state, "unknown");
  assert.equal(unknown.completeness.total, null);

  assert.throws(
    () => normalizeCollection([{ id: 1 }], { command: "x", total: 0 }),
    outputError("OUTPUT_INVALID_VALUE"),
  );
});

test("collection normalization honors explicit final pages without claiming global completeness", () => {
  const finalPage = normalizeCollection(
    [{ id: "L21" }],
    {
      command: "cookidoo-axi organize custom-list list --page 1",
      total: 21,
      hasMore: false,
    },
  );
  assert.deepEqual(finalPage.completeness, {
    state: "partial",
    shown: 1,
    total: 21,
    hasMore: false,
  });

  const emptyLaterPage = normalizeCollection([], {
    command: "cookidoo-axi search recipes --pagination 3",
    hasMore: null,
  });
  assert.deepEqual(emptyLaterPage.completeness, {
    state: "unknown",
    shown: 0,
    total: null,
    hasMore: null,
  });

  const emptyLaterPageWithGlobalTotal = normalizeCollection([], {
    command: "cookidoo-axi search recipes --pagination 3",
    total: 21,
    hasMore: null,
  });
  assert.deepEqual(emptyLaterPageWithGlobalTotal.completeness, {
    state: "partial",
    shown: 0,
    total: 21,
    hasMore: null,
  });

  const explicitFalseWithoutTotal = normalizeCollection([{ id: "r1" }], {
    command: "cookidoo-axi search recipes",
    hasMore: false,
  });
  assert.deepEqual(explicitFalseWithoutTotal.completeness, {
    state: "unknown",
    shown: 1,
    total: null,
    hasMore: false,
  });
});

test("object width is recursively bounded with stable identity-first ordering", () => {
  const source = {
    nested: {
      noise: 1,
      kind: "chapter",
      chapterId: "c1",
      status: "READY",
      tail: 2,
    },
    noise: "x",
    type: "recipe",
    id: "r1",
    status: "READY",
    tail: "x",
  };
  const envelope = normalizeDetail(source, {
    command: "cookidoo-axi recipe get r1",
    maxItems: 4,
  });

  assert.deepEqual(plain(envelope.data), {
    id: "r1",
    type: "recipe",
    status: "READY",
    nested: {
      chapterId: "c1",
      kind: "chapter",
      status: "READY",
      noise: 1,
    },
  });
  assert.equal(envelope.completeness.state, "partial");
  assert.equal(envelope.truncation.mode, "object");
  assert.equal(envelope.truncation.objectLimit, 4);
  assert.equal(envelope.truncation.omittedProperties, 3);
  assert.deepEqual(envelope.truncation.objects, [
    { path: "$.data", shownKeys: 4, totalKeys: 6 },
    { path: "$.data.nested", shownKeys: 4, totalKeys: 5 },
  ]);
  assert.equal(envelope.truncation.fullCommand, "cookidoo-axi recipe get r1 --full");

  const json = serializeOutput(envelope, { format: "json" });
  assert.deepEqual(JSON.parse(json.text), plain(envelope));
  const toon = serializeOutput(envelope, { format: "toon" });
  assert.deepEqual(plain(decode(toon.text, { strict: true })), plain(envelope));
});

test("object bounds apply to collection items and context and --full bypasses them", () => {
  const items = [{ noise: 1, type: "recipe", id: "r1", title: "one" }];
  const context = { noise: 1, kind: "page", pageId: "p1", tail: 2 };
  const bounded = normalizeCollection(items, {
    command: "cookidoo-axi created list",
    maxItems: 2,
    total: 1,
    hasMore: false,
    context,
  });
  assert.deepEqual(plain(bounded.data), [{ id: "r1", type: "recipe" }]);
  assert.deepEqual(plain(bounded.context), { pageId: "p1", kind: "page" });
  assert.deepEqual(bounded.truncation.objects, [
    { path: "$.data[0]", shownKeys: 2, totalKeys: 4 },
    { path: "$.context", shownKeys: 2, totalKeys: 4 },
  ]);
  assert.equal(bounded.truncation.omittedProperties, 4);
  assert.equal(bounded.completeness.state, "partial");
  assert.equal(bounded.completeness.hasMore, false);

  const full = normalizeCollection(items, {
    command: "cookidoo-axi created list",
    maxItems: 2,
    total: 1,
    hasMore: false,
    context,
    full: true,
  });
  assert.deepEqual(plain(full.data), items);
  assert.deepEqual(plain(full.context), context);
  assert.equal(full.truncation.applied, false);
  assert.equal(full.truncation.objectLimit, null);
  assert.deepEqual(full.truncation.objects, []);
  assert.equal(full.truncation.fullCommand, null);
});

test("object truncation never advertises a mutation rerun when disabled", () => {
  const envelope = normalizeDetail(
    { noise: 1, type: "recipe", id: "r1" },
    {
      command: "cookidoo-axi created update r1",
      maxObjectKeys: 2,
      allowFullCommand: false,
      next: ["cookidoo-axi created get r1"],
    },
  );
  assert.deepEqual(plain(envelope.data), { id: "r1", type: "recipe" });
  assert.equal(envelope.truncation.applied, true);
  assert.equal(envelope.truncation.fullCommand, null);
  assert.deepEqual(envelope.next.map(({ command }) => command), ["cookidoo-axi created get r1"]);
  assert.equal(envelope.next.some(({ command }) => command.includes("--full")), false);
});

test("detail completeness distinguishes partial and unknown source contracts", () => {
  const partial = normalizeDetail({ id: "fixture" }, {
    command: "cookidoo-axi fixture",
    sourceCompleteness: "partial",
  });
  assert.deepEqual(partial.completeness, {
    state: "partial", shown: 1, total: null, hasMore: null,
  });
  const unknown = normalizeDetail({ id: "fixture" }, {
    command: "cookidoo-axi fixture",
    sourceCompleteness: "unknown",
  });
  assert.deepEqual(unknown.completeness, {
    state: "unknown", shown: 1, total: null, hasMore: null,
  });
});

test("direct object truncation validates limits and preserves provider order for ties", () => {
  const value = toJsonValue({ z: 1, a: 2, id: "r1", type: "recipe" });
  const result = truncateJsonObjects(value, 3);
  assert.deepEqual(plain(result.value), { id: "r1", type: "recipe", z: 1 });
  assert.deepEqual(result.objects, [{ path: "$", shownKeys: 3, totalKeys: 4 }]);
  assert.throws(() => truncateJsonObjects(value, 0), outputError("OUTPUT_INVALID_OPTION"));
});

test("structural metadata is emitted only for branches retained in bounded output", () => {
  const branch = (id) => ({ noise: 1, kind: "leaf", id, tail: 2 });
  const envelope = normalizeDetail(
    {
      kept: [branch("k1"), branch("k2"), branch("k3")],
      dropped: [branch("d1"), branch("d2"), branch("d3")],
      kind: "root",
      id: "root",
    },
    {
      command: "cookidoo-axi recipe get root",
      maxItems: 1,
      maxObjectKeys: 3,
    },
  );

  assert.deepEqual(plain(envelope.data), {
    id: "root",
    kind: "root",
    kept: [{ id: "k1", kind: "leaf", noise: 1 }],
  });
  assert.deepEqual(envelope.truncation.collections, [
    { path: "$.data.kept", shownItems: 1, totalItems: 3 },
  ]);
  assert.equal(
    [...envelope.truncation.objects, ...envelope.truncation.collections]
      .some(({ path }) => path.includes("dropped")),
    false,
  );
});

test("field projection traverses arrays and reports paths absent everywhere", () => {
  const selected = selectFields(toJsonValue([
    { recipe: { id: "r1", name: "one" } },
    { recipe: { id: "r2", name: "two" } },
  ]), "recipe.id,recipe.missing");
  assert.deepEqual(plain(selected.value), [
    { recipe: { id: "r1" } },
    { recipe: { id: "r2" } },
  ]);
  assert.deepEqual(selected.requested, ["recipe.id", "recipe.missing"]);
  assert.deepEqual(selected.missing, ["recipe.missing"]);
});

test("string truncation counts Unicode code points instead of UTF-16 halves", () => {
  const truncated = truncateJsonStrings(toJsonValue({ value: "A😀BC" }), 3);
  assert.deepEqual(plain(truncated.value), { value: "A😀…" });
  assert.deepEqual(truncated.fields, [{
    path: "$.value",
    shownCharacters: 2,
    totalCharacters: 4,
  }]);

  const protectedMarker = truncateJsonStrings(toJsonValue("[REDACTED]"), 2);
  assert.equal(protectedMarker.value, "[REDACTED]");
  assert.deepEqual(protectedMarker.fields, []);
});

test("TOON and JSON serialization round-trip difficult JSON values", () => {
  const value = {
    empty: "",
    unicode: "Zażółć gęślą jaźń 😀",
    punctuation: "a:b,c|d\nsecond line",
    booleans: [true, false, null],
    nested: [{ id: 1, label: "first" }, { id: 2, label: "second" }],
  };

  for (const delimiter of [",", "\t", "|"]) {
    const serialized = serializeOutput(value, { format: "toon", delimiter });
    assert.equal(serialized.format, "toon");
    assert.deepEqual(plain(decode(serialized.text, { strict: true })), value);
    assert.doesNotMatch(serialized.text, /[ \t]+$/mu);
    assert.equal(serialized.text.endsWith("\n"), false);
  }

  const json = serializeOutput(value, { format: "json" });
  assert.deepEqual(JSON.parse(json.text), value);
  assert.equal(json.text.includes("\n"), false);
});

test("strict TOON rejects malformed documents and output boundary rejects malformed Unicode", () => {
  assert.throws(() => decode("a: 1\n  b: 2", { strict: true }));
  assert.throws(() => decode("a: 1\na: 2", { strict: true }));
  assert.throws(() => decode('a: "unterminated', { strict: true }));

  const malformed = String.fromCharCode(0xd800);
  assert.throws(() => serializeOutput({ malformed }), outputError("OUTPUT_INVALID_VALUE"));
  assert.throws(
    () => assertSerializedDocument({ format: "json", text: "{}\n" }),
    outputError("OUTPUT_INVALID_DOCUMENT"),
  );
  assert.throws(
    () => assertSerializedDocument({ format: "toon", text: "a: 1 \n" }),
    outputError("OUTPUT_INVALID_DOCUMENT"),
  );
});

test("JSON boundary rejects non-JSON values, prototypes, accessors, and cycles", () => {
  assert.throws(() => toJsonValue(Number.POSITIVE_INFINITY), outputError("OUTPUT_INVALID_VALUE"));
  assert.throws(() => toJsonValue(undefined), outputError("OUTPUT_INVALID_VALUE"));
  assert.throws(() => toJsonValue(new Date()), outputError("OUTPUT_INVALID_VALUE"));

  const accessor = {};
  Object.defineProperty(accessor, "secret", { enumerable: true, get: () => "fixture" });
  assert.throws(() => toJsonValue(accessor), outputError("OUTPUT_INVALID_VALUE"));

  const circular = {};
  circular.self = circular;
  assert.throws(() => toJsonValue(circular), outputError("OUTPUT_INVALID_VALUE"));
});

test("stdout emits exactly one framing newline and diagnostics scrub common secret forms", () => {
  let stdout = "";
  const serialized = writeOutput({ ok: true }, {
    format: "json",
    stdout: { write(chunk) { stdout += chunk; } },
  });
  assert.equal(stdout, `${serialized.text}\n`);
  assert.equal(stdout.endsWith("\n\n"), false);

  const diagnostic = sanitizeDiagnostic(
    "Bearer abc.def password=fixture-pass\ncookie: fixture-cookie   \n\"password\":\"quoted-fixture\"",
  );
  assert.equal(
    diagnostic,
    "[REDACTED]",
  );
  assert.doesNotMatch(diagnostic, /fixture/u);

  const urlDiagnostic = sanitizeDiagnostic(
    "Failure near https://user:SYNTHETIC_URL_PASSWORD@example.invalid/path",
  );
  assert.doesNotMatch(urlDiagnostic, /SYNTHETIC_URL_PASSWORD/u);
  assert.equal(urlDiagnostic, "[REDACTED]");

  assert.equal(
    sanitizeDiagnostic("Failure at myPassword=\nSYNTHETIC_MULTILINE_SECRET"),
    "[REDACTED]",
  );
});
