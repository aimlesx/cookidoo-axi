import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { CookieJar } from "tough-cookie";

import { prepareRequest } from "../dist/api/request.js";
import { getOperationById } from "../dist/api/spec.js";
import { KEYCHAIN_SERVICES, KeychainAuthStore } from "../dist/auth/keychain.js";
import { FEED_KEYCHAIN_SERVICE, FeedCredentialStore } from "../dist/auth/feed.js";
import { AuthError } from "../dist/auth/errors.js";
import { buildRequestBody } from "../dist/cli/input.js";
import { parseInvocation } from "../dist/cli/parser.js";
import { OPENAPI_MANIFEST } from "../dist/api/spec.js";
import { createCookidooProtectedReadVerifier, execute } from "../dist/http/client.js";
import { deriveConfirmationTarget } from "../dist/safety/policy.js";

async function run(...arguments_) {
  const cli = await import("../dist/cli.js");
  return cli.run(...arguments_);
}

class MemoryAdapter {
  secrets = new Map();
  getCalls = [];
  setCalls = [];
  deleteCalls = [];
  events = [];
  failDeleteService;
  key(service, account) { return `${service}\0${account}`; }
  async getSecret(service, account) {
    this.getCalls.push({ service, account });
    this.events.push({ action: "get", service, account });
    return this.secrets.get(this.key(service, account));
  }
  async setSecret(service, account, secret) {
    this.setCalls.push({ service, account });
    this.events.push({ action: "set", service, account });
    this.secrets.set(this.key(service, account), secret);
  }
  async deleteSecret(service, account) {
    this.deleteCalls.push({ service, account });
    this.events.push({ action: "delete", service, account });
    if (service === this.failDeleteService) {
      throw new AuthError({
        code: "KEYCHAIN_DELETE_FAILED",
        message: "A synthetic offline Keychain record could not be removed.",
        suggestion: "Retry the synthetic offline fixture.",
      });
    }
    return this.secrets.delete(this.key(service, account));
  }
  async listAccounts(service) {
    return [...this.secrets.keys()]
      .filter((key) => key.startsWith(`${service}\0`))
      .map((key) => key.slice(service.length + 1));
  }
}

function prepared(operationId, { path = {}, query = {}, body } = {}) {
  const operation = getOperationById(operationId);
  return {
    operation,
    request: prepareRequest({
      operation,
      baseUrl: "https://cookidoo.pl",
      path,
      query,
      filters: [],
      headers: {},
      body,
    }),
  };
}

function apiCode(code) {
  return (error) => {
    assert.equal(error?.name, "ApiError");
    assert.equal(error?.code, code);
    return true;
  };
}

function responseAt(url, body, init) {
  const response = new Response(body, init);
  Object.defineProperty(response, "url", { value: String(url) });
  return response;
}

test("safe public reads retry bounded transient responses and parse declared JSON", async () => {
  const { operation, request } = prepared("getRecipe", {
    path: { lang: "pl", recipeId: "r123" },
  });
  let calls = 0;
  const result = await execute({
    operation,
    request,
    retry: { maxReadAttempts: 2, baseDelayMs: 0, maximumDelayMs: 0 },
    fetch: async () => {
      calls += 1;
      if (calls === 1) return new Response(null, { status: 503 });
      return new Response('{"id":"r123"}', {
        status: 200,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    },
  });
  assert.equal(calls, 2);
  assert.equal(result.attempts, 2);
  assert.deepEqual(result.data, { id: "r123" });
});

test("Retry-After is never shortened to the local retry cap", async () => {
  const { operation, request } = prepared("getRecipe", {
    path: { lang: "pl", recipeId: "r123" },
  });
  let calls = 0;
  await assert.rejects(execute({
    operation,
    request,
    retry: { maxReadAttempts: 2, baseDelayMs: 0, maximumDelayMs: 1 },
    fetch: async () => {
      calls += 1;
      return new Response(null, { status: 503, headers: { "retry-after": "10" } });
    },
  }), apiCode("API_HTTP_ERROR"));
  assert.equal(calls, 1, "the client must stop instead of retrying before Retry-After");
});

test("declared vendor JSON response media types remain supported", async () => {
  const { operation, request } = prepared("getCreatedRecipe", {
    path: { lang: "pl", customerRecipeId: "01ARZ3NDEKTSV4RRFFQ69G5FAV" },
  });
  const jar = new CookieJar();
  const result = await execute({
    operation,
    request,
    authStore: {
      async loadCredentials() { throw new Error("not used"); },
      async loadCookieJar() { return jar; },
      async saveCookieJar() {},
    },
    fetch: async () => new Response('{"recipeId":"01ARZ3NDEKTSV4RRFFQ69G5FAV"}', {
      status: 200,
      headers: { "content-type": "application/vnd.vorwerk.customer-recipe.full+json" },
    }),
  });
  assert.equal(result.bodyKind, "json");
  assert.equal(result.data.recipeId, "01ARZ3NDEKTSV4RRFFQ69G5FAV");
});

test("cached protected reads use one Keychain read and persist only cookie rotation", async () => {
  const { operation, request } = prepared("getLocalizedCommunityProfile", {
    path: { lang: "pl" },
  });
  const adapter = new MemoryAdapter();
  const authStore = new KeychainAuthStore(adapter);
  const jar = new CookieJar();
  await jar.setCookie(
    "fixture_session=initial; Secure; HttpOnly; Path=/",
    "https://cookidoo.pl/",
  );
  await authStore.saveCookieJar("fixture", jar);
  adapter.getCalls.length = 0;
  adapter.setCalls.length = 0;

  let observedCookie;
  await execute({
    operation,
    request,
    profile: "fixture",
    authStore,
    fetch: async (input, init) => {
      const outgoing = input instanceof Request ? input : new Request(input, init);
      observedCookie = outgoing.headers.get("cookie");
      return new Response('{"id":"fixture","userInfo":{"username":"offline"}}', {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  assert.match(observedCookie, /fixture_session=initial/u);
  assert.deepEqual(adapter.getCalls, [{
    service: KEYCHAIN_SERVICES.cookieSession,
    account: "fixture",
  }]);
  assert.deepEqual(adapter.setCalls, [], "lastAccessed-only changes must not rewrite Keychain");

  adapter.getCalls.length = 0;
  adapter.setCalls.length = 0;
  await execute({
    operation,
    request,
    profile: "fixture",
    authStore,
    fetch: async (input) => responseAt(
      input instanceof Request ? input.url : input,
      '{"id":"fixture","userInfo":{"username":"offline"}}', {
        status: 200,
        headers: {
          "content-type": "application/json",
          "set-cookie": "fixture_session=rotated; Secure; HttpOnly; Path=/",
        },
      },
    ),
  });
  assert.deepEqual(adapter.getCalls, [{
    service: KEYCHAIN_SERVICES.cookieSession,
    account: "fixture",
  }]);
  assert.deepEqual(adapter.setCalls, [{
    service: KEYCHAIN_SERVICES.cookieSession,
    account: "fixture",
  }]);
  const rotated = await authStore.loadCookieJar("fixture");
  assert.match(await rotated.getCookieString("https://cookidoo.pl/"), /fixture_session=rotated/u);
});

test("first protected read reuses the verified in-memory login jar without a Keychain reread", async () => {
  const { operation, request } = prepared("getLocalizedCommunityProfile", {
    path: { lang: "pl" },
  });
  const adapter = new MemoryAdapter();
  const authStore = new KeychainAuthStore(adapter);
  await authStore.saveCredentials("fixture", {
    username: "offline@example.invalid",
    password: "fixture-password",
  });
  adapter.getCalls.length = 0;
  adapter.setCalls.length = 0;
  let profileReads = 0;
  const result = await execute({
    operation,
    request,
    profile: "fixture",
    authStore,
    fetch: async (input, init) => {
      const outgoing = input instanceof Request ? input : new Request(input, init);
      const url = new URL(outgoing.url);
      if (url.origin === "https://cookidoo.pl" && url.pathname === "/profile/pl/login") {
        return responseAt(outgoing.url, `<!doctype html><form method="post" action="https://ciam.prod.cookidoo.vorwerk-digital.com/session">
          <input type="hidden" name="requestId" value="request-fixture">
          <input type="text" name="username">
          <input type="password" name="password">
        </form>`, {
          status: 200,
          headers: {
            "content-type": "text/html",
            "set-cookie": "fixture_session=initial; Secure; HttpOnly; Path=/",
          },
        });
      }
      if (url.hostname === "ciam.prod.cookidoo.vorwerk-digital.com") {
        assert.equal(outgoing.method, "POST");
        return new Response("ok", { status: 200 });
      }
      if (url.origin === "https://cookidoo.pl" && url.pathname === "/community/profile/pl") {
        profileReads += 1;
        assert.match(outgoing.headers.get("cookie"), /fixture_session=initial/u);
        return new Response('{"id":"fixture","userInfo":{"username":"offline"}}', {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected offline request: ${url.origin}${url.pathname}`);
    },
  });
  assert.equal(result.reauthenticated, true);
  assert.equal(profileReads, 2, "one login verification and one requested profile read");
  assert.deepEqual(adapter.getCalls, [
    { service: KEYCHAIN_SERVICES.cookieSession, account: "fixture" },
    { service: KEYCHAIN_SERVICES.credentials, account: "fixture" },
  ]);
  assert.deepEqual(adapter.setCalls, [
    { service: KEYCHAIN_SERVICES.cookieSession, account: "fixture" },
  ]);
});

test("component-referenced JSON response contracts remain supported", async () => {
  const { operation, request } = prepared("getDeviceVersions");
  const jar = new CookieJar();
  const result = await execute({
    operation,
    request,
    authStore: {
      async loadCredentials() { throw new Error("not used"); },
      async loadCookieJar() { return jar; },
      async saveCookieJar() {},
    },
    fetch: async () => new Response('{"versions":[]}', {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  });
  assert.equal(result.bodyKind, "json");
  assert.deepEqual(result.data, { versions: [] });
});

test("safe reads reject oversized and HTML success bodies without reflecting content", async () => {
  const { operation, request } = prepared("getRecipe", {
    path: { lang: "pl", recipeId: "r123" },
  });
  await assert.rejects(execute({
    operation,
    request,
    maxResponseBytes: 1024,
    retry: { maxReadAttempts: 1 },
    fetch: async () => new Response("x".repeat(1025), {
      status: 200,
      headers: { "content-type": "application/json", "content-length": "1025" },
    }),
  }), apiCode("RESPONSE_BODY_UNREADABLE"));

  const secret = "fixture-provider-secret";
  await assert.rejects(execute({
    operation,
    request,
    retry: { maxReadAttempts: 1 },
    fetch: async () => new Response(`<html>${secret}</html>`, {
      status: 200,
      headers: { "content-type": "text/html" },
    }),
  }), (error) => {
    assert.equal(error.code, "RESPONSE_TYPE_UNEXPECTED");
    assert.doesNotMatch(`${error.message} ${JSON.stringify(error.details)}`, new RegExp(secret, "u"));
    return true;
  });
});

test("successful responses reject undeclared status, media type, text, and missing JSON bodies", async () => {
  const { operation, request } = prepared("getRecipe", {
    path: { lang: "pl", recipeId: "r123" },
  });
  const secret = "fixture-body-must-not-surface";
  const cases = [
    { status: 200, body: secret, contentType: "text/plain" },
    { status: 200, body: `{"value":"${secret}"}`, contentType: "application/vnd.undeclared+json" },
    { status: 201, body: `{"value":"${secret}"}`, contentType: "application/json" },
    { status: 200, body: null, contentType: "application/json" },
  ];
  for (const fixture of cases) {
    await assert.rejects(execute({
      operation,
      request,
      retry: { maxReadAttempts: 1 },
      fetch: async () => new Response(fixture.body, {
        status: fixture.status,
        headers: { "content-type": fixture.contentType },
      }),
    }), (error) => {
      assert.equal(error.code, "RESPONSE_TYPE_UNEXPECTED");
      assert.equal(error.outcome, "response-received");
      assert.doesNotMatch(`${error.message} ${JSON.stringify(error.details)}`, new RegExp(secret, "u"));
      return true;
    });
  }
});

test("response contracts come from the canonical manifest, not caller-supplied metadata", async () => {
  const preparedRecipe = prepared("getRecipe", {
    path: { lang: "pl", recipeId: "r123" },
  });
  const operation = {
    ...preparedRecipe.operation,
    responses: {
      "200": {
        content: {
          "application/vnd.forged+json": { schema: true },
        },
      },
    },
  };
  await assert.rejects(execute({
    operation,
    request: preparedRecipe.request,
    retry: { maxReadAttempts: 1 },
    fetch: async () => new Response('{"secret":"must-not-surface"}', {
      status: 200,
      headers: { "content-type": "application/vnd.forged+json" },
    }),
  }), apiCode("RESPONSE_TYPE_UNEXPECTED"));
});

test("prepared requests cannot substitute a different same-origin operation path", async () => {
  const { operation, request } = prepared("getRecipe", {
    path: { lang: "pl", recipeId: "r123" },
  });
  const forged = {
    ...request,
    url: new URL("https://cookidoo.pl/created-recipes/pl?recipeUrl=https://example.invalid/fixture"),
  };
  let dispatched = 0;
  await assert.rejects(execute({
    operation,
    request: forged,
    fetch: async () => {
      dispatched += 1;
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    },
  }), (error) => {
    assert.equal(error.code, "REQUEST_OPERATION_MISMATCH");
    assert.equal(error.outcome, "not-dispatched");
    return true;
  });
  assert.equal(dispatched, 0);
});

test("protected-read verification requires the documented CommunityProfile identity shape", async () => {
  const verify = createCookidooProtectedReadVerifier({ retry: { maxReadAttempts: 1 } });
  const context = (body, status = 200) => ({
    gatewayOrigin: "https://cookidoo.pl",
    signal: new AbortController().signal,
    fetch: async (input) => {
      assert.equal(new URL(String(input)).pathname, "/community/profile/pl");
      return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    },
  });
  for (const invalid of [{}, { error: "unauthenticated" }, [], { id: "x" }, {
    id: "x", userInfo: {},
  }]) {
    assert.equal(await verify(context(invalid)), false);
  }
  assert.equal(await verify(context({ id: "x", userInfo: { username: "offline" } })), true);
  assert.equal(await verify(context({ id: "x", userInfo: { username: "offline" } }, 201)), false);
});

test("cookie mutation preflights a protected read and never retries ambiguous dispatch", async () => {
  const { operation, request } = prepared("patchCreatedRecipe", {
    path: { lang: "pl", customerRecipeId: "01ARZ3NDEKTSV4RRFFQ69G5FAV" },
    body: { name: "offline" },
  });
  const jar = new CookieJar();
  const authStore = {
    async loadCredentials() { throw new Error("fresh login must not be needed"); },
    async loadCookieJar() { return jar; },
    async saveCookieJar() {},
  };
  let profileReads = 0;
  let mutations = 0;
  const fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/community/profile/pl")) {
      profileReads += 1;
      return new Response('{"id":"fixture","userInfo":{"username":"offline"}}', {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    mutations += 1;
    throw new Error("synthetic lost connection");
  };
  await assert.rejects(execute({ operation, request, authStore, fetch }), (error) => {
    assert.equal(error.code, "MUTATION_OUTCOME_UNKNOWN");
    assert.equal(error.retrySafe, false);
    assert.equal(error.outcome, "unknown");
    assert.equal(error.reconciliation.required, true);
    return true;
  });
  assert.equal(profileReads, 1);
  assert.equal(mutations, 1);
});

test("mutationLike GET uses preflight and exactly one effectful dispatch", async () => {
  const { operation, request } = prepared("listCreatedRecipes", {
    path: { lang: "pl" },
    query: { recipeUrl: "https://example.invalid/fixture" },
  });
  const jar = new CookieJar();
  const authStore = {
    async loadCredentials() { throw new Error("not used"); },
    async loadCookieJar() { return jar; },
    async saveCookieJar() {},
  };
  let effectful = 0;
  const result = await execute({
    operation,
    request,
    mutationLike: true,
    authStore,
    fetch: async (input) => {
      const url = String(input);
      if (url.endsWith("/community/profile/pl")) {
        return new Response('{"id":"fixture","userInfo":{"username":"offline"}}', {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      effectful += 1;
      return new Response('{"items":[]}', {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  assert.equal(effectful, 1);
  assert.equal(result.attempts, 1);
});

test("declared empty mutation responses remain successful", async () => {
  const { operation, request } = prepared("deleteCreatedRecipe", {
    path: { lang: "pl", customerRecipeId: "01ARZ3NDEKTSV4RRFFQ69G5FAV" },
  });
  const jar = new CookieJar();
  let mutationCalls = 0;
  const result = await execute({
    operation,
    request,
    authStore: {
      async loadCredentials() { throw new Error("not used"); },
      async loadCookieJar() { return jar; },
      async saveCookieJar() {},
    },
    fetch: async (input) => {
      if (String(input).endsWith("/community/profile/pl")) {
        return new Response('{"id":"fixture","userInfo":{"username":"offline"}}', {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      mutationCalls += 1;
      return new Response(null, { status: 204 });
    },
  });
  assert.equal(mutationCalls, 1);
  assert.equal(result.status, 204);
  assert.equal(result.bodyKind, "empty");
  assert.equal(result.empty, true);
  assert.equal(result.data, null);
});

test("feed Basic auth is provider-only and declared 303 remains a safe descriptor", async () => {
  const { operation, request } = prepared("getCollectionFeedPage", {
    query: { pageBefore: "2026-08-18T00:00:00Z" },
  });
  let authorization;
  const result = await execute({
    operation,
    request,
    basicCredentials: {
      async getCredentials() { return { username: "fixture-user", password: "fixture-password" }; },
    },
    fetch: async (_input, init) => {
      authorization = new Headers(init.headers).get("authorization");
      return new Response(null, {
        status: 303,
        headers: { location: "https://cookidoo.pl/recipes/feed-v2/collections/pages?pageBefore=1" },
      });
    },
  });
  assert.match(authorization, /^Basic /u);
  assert.doesNotMatch(JSON.stringify(result), /fixture-(?:user|password)|Basic/u);
  assert.deepEqual(result.data, {
    location: "https://cookidoo.pl/recipes/feed-v2/collections/pages?pageBefore=1",
  });
});

test("feed Basic auth preserves sanitized provider failures without HTTP dispatch", async () => {
  const { operation, request } = prepared("getCollectionFeedPage", {
    query: { pageBefore: "2026-08-18T00:00:00Z" },
  });
  const providerError = new AuthError({
    code: "KEYCHAIN_SANDBOXED",
    message: "macOS Keychain access is unavailable inside the Codex Seatbelt sandbox.",
    suggestion: "Rerun outside the sandbox; do not re-import credentials.",
  });
  let fetchCalls = 0;

  await assert.rejects(execute({
    operation,
    request,
    basicCredentials: {
      async getCredentials() { throw providerError; },
    },
    fetch: async () => {
      fetchCalls += 1;
      throw new Error("must not dispatch");
    },
  }), (error) => {
    assert.equal(error?.code, "KEYCHAIN_SANDBOXED");
    assert.equal(error?.suggestion, providerError.suggestion);
    return true;
  });
  assert.equal(fetchCalls, 0);
});

test("declared redirects cannot leave the fixed Cookidoo origin", async () => {
  const { operation, request } = prepared("getCollectionFeedPage", {
    query: { pageBefore: "2026-08-18T00:00:00Z" },
  });
  await assert.rejects(execute({
    operation,
    request,
    basicCredentials: { async getCredentials() { return { username: "u", password: "p" }; } },
    fetch: async () => new Response(null, {
      status: 303,
      headers: { location: "https://cookidoo.pl.evil.invalid/steal" },
    }),
  }), apiCode("RESPONSE_REDIRECT_INVALID"));
});

function outputBuffer() {
  let text = "";
  return { stream: { write(chunk) { text += String(chunk); } }, read: () => text };
}

function shellArgv(command) {
  const script = [
    `set -- ${command}`,
    `printf '%s\\0' "$@"`,
  ].join("\n");
  const output = execFileSync("/bin/sh", ["-c", script], { encoding: "utf8" });
  return output.length === 0 ? [] : output.slice(0, -1).split("\0");
}

function cliStores() {
  const adapter = new MemoryAdapter();
  return {
    authStore: new KeychainAuthStore(adapter),
    feedStore: new FeedCredentialStore(adapter),
  };
}

test("bare home is content-first and does not read Keychain records", async () => {
  let reads = 0;
  const adapter = {
    async getSecret() { reads += 1; throw new Error("home must not read secrets"); },
    async setSecret() { throw new Error("not used"); },
    async deleteSecret() { throw new Error("not used"); },
    async listAccounts() { throw new Error("not used"); },
  };
  const stdout = outputBuffer();
  const code = await run(["--output", "json"], {
    platform: "darwin",
    executablePath: "/opt/cookidoo-axi",
    stdout: stdout.stream,
    authStore: new KeychainAuthStore(adapter),
    feedStore: new FeedCredentialStore(adapter),
  });
  process.exitCode = undefined;
  assert.equal(code, 0);
  assert.equal(reads, 0);
  const result = JSON.parse(stdout.read());
  assert.equal(result.data.executable, "/opt/cookidoo-axi");
  assert.equal(result.data.auth.state, "not-checked-on-home");
  assert.equal(
    result.data.auth.inspectStoredSessionWith,
    "cookidoo-axi auth status --inspect session --output 'json'",
  );
  assert.equal(result.data.auth.verifyWith, "cookidoo-axi profile get-localized --output 'json'");
  assert.equal(result.next[1].command, "cookidoo-axi profile get-localized --output 'json'");

  const homeOut = outputBuffer();
  const homeCode = await run(["--output", "json"], {
    platform: "darwin",
    executablePath: `${homedir()}/Projects/private-checkout/bin/cookidoo-axi.mjs`,
    stdout: homeOut.stream,
    authStore: new KeychainAuthStore(adapter),
    feedStore: new FeedCredentialStore(adapter),
  });
  process.exitCode = undefined;
  assert.equal(homeCode, 0);
  assert.equal(
    JSON.parse(homeOut.read()).data.executable,
    "~/Projects/private-checkout/bin/cookidoo-axi.mjs",
  );
});

test("operation catalog filters before output and returns compact scoped discovery", async () => {
  const stdout = outputBuffer();
  const code = await run([
    "operation", "list",
    "--group", "created",
    "--risk", "write",
    "--query", "recipe",
    "--profile", "fixture",
    "--lang", "en",
    "--output", "json",
    "--max-items", "1",
  ], { platform: "darwin", stdout: stdout.stream, ...cliStores() });
  process.exitCode = undefined;
  assert.equal(code, 0);
  const result = JSON.parse(stdout.read());
  assert.equal(result.data.length, 1);
  assert.ok(result.data.every((item) =>
    ["createCreatedRecipe", "patchCreatedRecipe"].includes(item.operationId)));
  assert.ok(result.data.every((item) => Object.keys(item).every((key) =>
    [
      "operationId",
      "command",
      "taskCommands",
      "method",
      "auth",
      "risk",
      "risks",
      "requiresAllowUnverified",
      "summary",
    ].includes(key))));
  assert.ok(result.completeness.total > 1);
  const describe = result.next.find(({ command }) => command.startsWith("cookidoo-axi operation describe"));
  assert.match(describe.command, /--profile 'fixture'/u);
  assert.match(describe.command, /--lang 'en'/u);
  assert.match(describe.command, /--output 'json'/u);
  const full = parseInvocation(
    shellArgv(result.truncation.fullCommand).slice(1),
    OPENAPI_MANIFEST.operations,
  );
  assert.equal(full.kind, "operation-list");
  assert.deepEqual(full.filter, { group: "created", risk: "write", query: "recipe" });
  assert.equal(full.options.profile, "fixture");
  assert.equal(full.options.lang, "en");
  assert.equal(full.options.output, "json");
  assert.equal(full.options.maxItems, 1);
  assert.equal(full.options.full, true);
});

test("operation catalog discovers task aliases and every effective safety gate", async () => {
  const publishOut = outputBuffer();
  const publishCode = await run([
    "operation", "list",
    "--risk", "external",
    "--query", "publish",
    "--output", "json",
  ], { platform: "darwin", stdout: publishOut.stream, ...cliStores() });
  process.exitCode = undefined;
  assert.equal(publishCode, 0);
  const publish = JSON.parse(publishOut.read());
  assert.deepEqual(publish.data.map(({ operationId }) => operationId), ["patchCreatedRecipe"]);
  assert.deepEqual(publish.data[0].risks, ["private-write", "external"]);
  assert.deepEqual(publish.data[0].taskCommands, [
    "cookidoo-axi created publish <customerRecipeId>",
    "cookidoo-axi created unpublish <customerRecipeId>",
  ]);

  const unverifiedOut = outputBuffer();
  const unverifiedCode = await run([
    "operation", "list", "--risk", "unverified", "--full", "--output", "json",
  ], { platform: "darwin", stdout: unverifiedOut.stream, ...cliStores() });
  process.exitCode = undefined;
  assert.equal(unverifiedCode, 0);
  const unverified = JSON.parse(unverifiedOut.read());
  const ids = new Set(unverified.data.map(({ operationId }) => operationId));
  for (const operationId of [
    "listCreatedRecipes",
    "revokeSharedList",
    "removePlanningDay",
    "movePlannedRecipe",
    "linkConnectedDevice",
  ]) {
    assert.equal(ids.has(operationId), true, operationId);
  }
  assert.ok(unverified.data.every(({ requiresAllowUnverified }) =>
    requiresAllowUnverified === true));

  const embeddedCredential = "SYNTHETIC_EMBEDDED_URL_SECRET";
  const credentialQueryOut = outputBuffer();
  const credentialQueryCode = await run([
    "operation", "list", "--query",
    `https://user:${embeddedCredential}@example.invalid/path`,
    "--max-items", "1", "--output", "json",
  ], { platform: "darwin", stdout: credentialQueryOut.stream, ...cliStores() });
  process.exitCode = undefined;
  assert.equal(credentialQueryCode, 0);
  const credentialQueryText = credentialQueryOut.read();
  assert.doesNotMatch(credentialQueryText, new RegExp(embeddedCredential, "u"));
  const credentialQuery = JSON.parse(credentialQueryText);
  assert.equal(credentialQuery.redaction.applied, true);
  assert.equal(credentialQuery.truncation.fullCommand, null);
});

test("auth status is zero-read by default and explicit scopes inspect only requested records", async () => {
  const adapter = new MemoryAdapter();
  const authStore = new KeychainAuthStore(adapter);
  const feedStore = new FeedCredentialStore(adapter);
  await authStore.saveCredentials("fixture", {
    username: "market@example.invalid",
    password: "market-fixture-password",
  });
  await authStore.saveCookieJar("fixture", new CookieJar());
  await feedStore.saveCredentials("fixture", {
    username: "feed-fixture-user",
    password: "feed-fixture-password",
  });
  adapter.getCalls.length = 0;

  const defaultOut = outputBuffer();
  const defaultCode = await run([
    "auth", "status", "--profile", "fixture", "--output", "json",
  ], { platform: "darwin", stdout: defaultOut.stream, authStore, feedStore });
  process.exitCode = undefined;
  assert.equal(defaultCode, 0);
  assert.deepEqual(adapter.getCalls, []);
  const defaultStatus = JSON.parse(defaultOut.read()).data;
  assert.equal(defaultStatus.inspection, "none");
  assert.equal(defaultStatus.keychainAccess, "not-requested");
  assert.equal(defaultStatus.keychainRecordsRead, 0);
  assert.equal(defaultStatus.promptExpectation, "none requested");
  assert.equal(defaultStatus.marketCredentialState, "not-checked");
  assert.equal(defaultStatus.cookieSessionState, "not-checked");
  assert.equal(defaultStatus.feedCredentialState, "not-checked");

  const expectedServices = {
    market: [KEYCHAIN_SERVICES.credentials],
    session: [KEYCHAIN_SERVICES.cookieSession],
    feed: [FEED_KEYCHAIN_SERVICE],
    all: [KEYCHAIN_SERVICES.credentials, KEYCHAIN_SERVICES.cookieSession, FEED_KEYCHAIN_SERVICE],
  };
  for (const [scope, services] of Object.entries(expectedServices)) {
    adapter.getCalls.length = 0;
    const stdout = outputBuffer();
    const code = await run([
      "auth", "status", "--inspect", scope, "--profile", "fixture", "--output", "json",
    ], { platform: "darwin", stdout: stdout.stream, authStore, feedStore });
    process.exitCode = undefined;
    assert.equal(code, 0);
    assert.deepEqual(
      adapter.getCalls.map(({ service }) => service),
      services,
      `scope ${scope}`,
    );
    const status = JSON.parse(stdout.read()).data;
    assert.equal(status.inspection, scope);
    assert.equal(status.keychainRecordsRead, services.length);
    assert.equal(status.keychainAccess, "explicitly-requested");
    assert.equal(
      status.promptExpectation,
      `macOS policy-dependent; up to ${services.length} separate item authorizations`,
    );
  }
});

test("CLI dry-run is network-free and emits exact publication safety gates", async () => {
  const stdout = outputBuffer();
  const stderr = outputBuffer();
  let dispatched = false;
  const code = await run([
    "created", "publish", "01ARZ3NDEKTSV4RRFFQ69G5FAV", "--dry-run", "--output", "json",
  ], {
    platform: "darwin",
    stdout: stdout.stream,
    stderr: stderr.stream,
    ...cliStores(),
    httpExecute: async () => { dispatched = true; throw new Error("must not dispatch"); },
    fetch: async () => { throw new Error("must not fetch"); },
  });
  process.exitCode = undefined;
  assert.equal(code, 0);
  assert.equal(dispatched, false);
  assert.equal(stderr.read(), "");
  const result = JSON.parse(stdout.read());
  assert.equal(result.data.safety.authenticationPerformed, false);
  assert.equal(result.data.safety.networkPerformed, false);
  assert.equal(result.data.safety.confirmationTarget, "created-recipe:01ARZ3NDEKTSV4RRFFQ69G5FAV:publish");
});

test("body-driven dry-runs provide a bounded executable trajectory without echoing unsafe payloads", async () => {
  const planningOut = outputBuffer();
  const planningCode = await run([
    "planning", "add", "--recipe-ids", "r123", "--day-key", "2026-08-18",
    "--dry-run", "--profile", "work", "--lang", "en", "--timeout-ms", "1234",
    "--output", "json",
  ], { platform: "darwin", stdout: planningOut.stream, ...cliStores() });
  process.exitCode = undefined;
  assert.equal(planningCode, 0);
  const planning = JSON.parse(planningOut.read());
  const executeCommand = planning.next.find(({ command }) => command.startsWith("cookidoo-axi planning add"));
  assert.match(executeCommand?.command, /--recipe-ids 'r123' --day-key '2026-08-18'/u);
  const parsedPlanning = parseInvocation(
    shellArgv(executeCommand.command).slice(1),
    OPENAPI_MANIFEST.operations,
  );
  assert.equal(parsedPlanning.kind, "operation");
  assert.equal(parsedPlanning.options.profile, "work");
  assert.equal(parsedPlanning.options.lang, "en");
  assert.equal(parsedPlanning.options.timeoutMs, 1_234);

  const setOut = outputBuffer();
  const setCode = await run([
    "created", "update", "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    "--set", "image=null",
    "--set", 'recipeMetadata={"source":"fixture"}',
    "--dry-run", "--output", "json",
  ], { platform: "darwin", stdout: setOut.stream, ...cliStores() });
  process.exitCode = undefined;
  assert.equal(setCode, 0);
  const setResult = JSON.parse(setOut.read());
  assert.deepEqual(setResult.data.request.body, {
    image: null,
    recipeMetadata: { source: "fixture" },
  });
  const setCommand = setResult.next.find(({ command }) =>
    command.startsWith("cookidoo-axi created update"))?.command;
  assert.match(setCommand, /--set 'image=null'/u);
  assert.match(setCommand, /--set 'recipeMetadata=\{"source":"fixture"\}'/u);
  const parsedSet = parseInvocation(shellArgv(setCommand).slice(1), OPENAPI_MANIFEST.operations);
  assert.equal(parsedSet.kind, "operation");
  assert.deepEqual(
    await buildRequestBody(parsedSet.bodyInput, parsedSet.bodyFields, true),
    setResult.data.request.body,
  );

  const targetConflictOut = outputBuffer();
  const targetConflictCode = await run([
    "rating", "set", "r123", "--rating", "5",
    "--target", "explicit-conflict",
    "--dry-run", "--output", "json",
  ], { platform: "darwin", stdout: targetConflictOut.stream, ...cliStores() });
  process.exitCode = undefined;
  assert.equal(targetConflictCode, 0);
  const targetConflict = JSON.parse(targetConflictOut.read());
  assert.match(
    targetConflict.data.safety.requirements.find(({ code }) => code === "confirmation")?.message,
    /does not match/u,
  );
  assert.equal(
    targetConflict.next.some(({ command }) => command.startsWith("cookidoo-axi rating set")),
    false,
  );

  const fileBodyOut = outputBuffer();
  const fileBodyCode = await run([
    "device", "link", "--data", "@package.json", "--allow-unverified",
    "--dry-run", "--output", "json",
  ], { platform: "darwin", stdout: fileBodyOut.stream, ...cliStores() });
  process.exitCode = undefined;
  assert.equal(fileBodyCode, 0);
  const fileBody = JSON.parse(fileBodyOut.read());
  assert.equal(
    fileBody.next.some(({ command }) => command.startsWith("cookidoo-axi device link")),
    false,
  );

  const injectionText = "x&printf AXI_SHELL_INJECTION";
  const injectionOut = outputBuffer();
  const injectionCode = await run([
    "note", "create", "--recipe-id", "r123", "--text", injectionText,
    "--dry-run", "--output", "json",
  ], { platform: "darwin", stdout: injectionOut.stream, ...cliStores() });
  process.exitCode = undefined;
  assert.equal(injectionCode, 0);
  const injectionCommand = JSON.parse(injectionOut.read()).next
    .find(({ command }) => command.startsWith("cookidoo-axi note create"))?.command;
  assert.match(injectionCommand, /--text 'x&printf AXI_SHELL_INJECTION'/u);
  const injectionArgv = shellArgv(injectionCommand);
  assert.ok(injectionArgv.includes(injectionText));
  assert.equal(
    parseInvocation(injectionArgv.slice(1), OPENAPI_MANIFEST.operations).kind,
    "operation",
  );

  const sensitiveOut = outputBuffer();
  const sensitiveCode = await run([
    "organize", "move-recipe",
    "--recipe-id", "token=a",
    "--target-list-id", "x;printf AXI_PWNED",
    "--src-list-id", "token=b",
    "--target-list-type", "CUSTOM",
    "--src-list-type", "CUSTOM",
    "--dry-run", "--output", "json",
  ], { platform: "darwin", stdout: sensitiveOut.stream, ...cliStores() });
  process.exitCode = undefined;
  assert.equal(sensitiveCode, 0);
  const sensitive = JSON.parse(sensitiveOut.read());
  assert.doesNotMatch(JSON.stringify(sensitive), /token=[ab]/u);
  assert.equal(sensitive.redaction.applied, true);
  assert.equal(
    sensitive.next.some(({ command }) => command.startsWith("cookidoo-axi organize move-recipe")),
    false,
  );

  const suffixSecretOut = outputBuffer();
  const suffixSecretCode = await run([
    "note", "create", "--recipe-id", "r123",
    "--text", "myPassword=SYNTHETIC_SUFFIX_SECRET",
    "--dry-run", "--output", "json",
  ], { platform: "darwin", stdout: suffixSecretOut.stream, ...cliStores() });
  process.exitCode = undefined;
  assert.equal(suffixSecretCode, 0);
  const suffixSecret = JSON.parse(suffixSecretOut.read());
  assert.doesNotMatch(JSON.stringify(suffixSecret), /SYNTHETIC_SUFFIX_SECRET/u);
  assert.equal(
    suffixSecret.next.some(({ command }) => command.startsWith("cookidoo-axi note create")),
    false,
  );

  const embeddedUrlOut = outputBuffer();
  const embeddedUrlCode = await run([
    "note", "create", "--recipe-id", "r123",
    "--text", "prefix https://user:SYNTHETIC_PASS@example.invalid/path suffix",
    "--dry-run", "--output", "json",
  ], { platform: "darwin", stdout: embeddedUrlOut.stream, ...cliStores() });
  process.exitCode = undefined;
  assert.equal(embeddedUrlCode, 0);
  const embeddedUrl = JSON.parse(embeddedUrlOut.read());
  assert.doesNotMatch(JSON.stringify(embeddedUrl), /SYNTHETIC_PASS/u);
  assert.equal(
    embeddedUrl.next.some(({ command }) => command.startsWith("cookidoo-axi note create")),
    false,
  );

  const sentinel = "SYNTHETIC_TOKEN_DO_NOT_USE";
  const urlOut = outputBuffer();
  const urlCode = await run([
    "created", "import", "--recipe-url",
    `https://example.invalid/r?access_token=${sentinel}`,
    "--dry-run", "--output", "json",
  ], { platform: "darwin", stdout: urlOut.stream, ...cliStores() });
  process.exitCode = undefined;
  assert.equal(urlCode, 0);
  assert.doesNotMatch(urlOut.read(), new RegExp(sentinel, "u"));
  const urlResult = JSON.parse(urlOut.read());
  assert.equal(urlResult.next.some(({ command }) => command.startsWith("cookidoo-axi created import")), false);

  const longText = "x".repeat(600);
  const noteOut = outputBuffer();
  const noteCode = await run([
    "note", "create", "--recipe-id", "r123", "--text", longText,
    "--dry-run", "--output", "json",
  ], { platform: "darwin", stdout: noteOut.stream, ...cliStores() });
  process.exitCode = undefined;
  assert.equal(noteCode, 0);
  const note = JSON.parse(noteOut.read());
  assert.equal(note.truncation.fullCommand, null);
  assert.equal(note.next.some(({ command }) => command.startsWith("cookidoo-axi note create")), false);
});

test("CLI forwards import-like GET as mutationLike only after both gates", async () => {
  const stdout = outputBuffer();
  const stderr = outputBuffer();
  let received;
  const url = "https://example.invalid/fixture";
  const target = deriveConfirmationTarget("listCreatedRecipes", { parameters: { recipeUrl: url } });
  assert.match(target, /^created-import:[a-f0-9]{24}$/u);
  const code = await run([
    "created", "import", "--recipe-url", url,
    "--allow-unverified", "--confirm", target,
    "--output", "json",
  ], {
    platform: "darwin",
    stdout: stdout.stream,
    stderr: stderr.stream,
    ...cliStores(),
    httpExecute: async (input) => {
      received = input;
      return {
        operationId: input.operation.operationId,
        method: input.operation.method,
        status: 200,
        contentType: "application/json",
        headers: {},
        data: [],
        bodyKind: "json",
        empty: false,
        attempts: 1,
        reauthenticated: false,
      };
    },
  });
  process.exitCode = undefined;
  assert.equal(code, 0, stderr.read());
  assert.equal(received.mutationLike, true);
  assert.equal(received.request.url.searchParams.get("recipeUrl"), url);
  assert.equal(JSON.parse(stdout.read()).completeness.state, "empty");
});

test("CLI usage errors are structured on stdout, silent on stderr, and exit 2", async () => {
  const stdout = outputBuffer();
  const stderr = outputBuffer();
  const code = await run(["created", "update", "01ARZ3NDEKTSV4RRFFQ69G5FAV", "--work-status", "PUBLIC", "--output", "json"], {
    platform: "darwin",
    stdout: stdout.stream,
    stderr: stderr.stream,
    ...cliStores(),
  });
  process.exitCode = undefined;
  assert.equal(code, 2);
  const result = JSON.parse(stdout.read());
  assert.equal(result.data.error.code, "PUBLICATION_COMMAND_REQUIRED");
  assert.equal(result.data.error.exitCode, 2);
  assert.equal(stderr.read(), "");
  assert.doesNotMatch(stdout.read(), /cookie|password=|credential=/iu);

  const badFlagOut = outputBuffer();
  const badFlagCode = await run([
    "search", "recipes", "--qurey", "soup", "--output", "json",
  ], { platform: "darwin", stdout: badFlagOut.stream, ...cliStores() });
  process.exitCode = undefined;
  assert.equal(badFlagCode, 2);
  const badFlag = JSON.parse(badFlagOut.read()).data.error;
  assert.equal(badFlag.code, "UNKNOWN_FLAG");
  assert.match(badFlag.message, /--qurey/u);
  assert.equal(badFlag.details.flag, "--qurey");
  assert.ok(badFlag.suggestions.some((value) => value.includes("--query")));

  const secret = "SYNTHETIC_UNKNOWN_COMMAND_SECRET";
  const secretOut = outputBuffer();
  const secretCode = await run([
    `https://user:${secret}@example.invalid/path`, "--output", "json",
  ], { platform: "darwin", stdout: secretOut.stream, ...cliStores() });
  process.exitCode = undefined;
  assert.equal(secretCode, 2);
  assert.doesNotMatch(secretOut.read(), new RegExp(secret, "u"));

  const debugSecret = "SYNTHETIC_DEBUG_PATH_SECRET";
  const debugOut = outputBuffer();
  const debugErr = outputBuffer();
  const debugCode = await run([
    "setup", "codex", "--directory", `./myPassword=${debugSecret}`,
    "--debug", "--output", "json",
  ], {
    platform: "darwin",
    stdout: debugOut.stream,
    stderr: debugErr.stream,
    ...cliStores(),
  });
  process.exitCode = undefined;
  assert.equal(debugCode, 2);
  assert.doesNotMatch(`${debugOut.read()}${debugErr.read()}`, new RegExp(debugSecret, "u"));
});

test("confirmed market credential replacement clears the previous cached session", async (t) => {
  const adapter = new MemoryAdapter();
  const authStore = new KeychainAuthStore(adapter);
  const feedStore = new FeedCredentialStore(adapter);
  await authStore.saveCredentials("fixture", {
    username: "old@example.invalid",
    password: "old-fixture-password",
  });
  const jar = new CookieJar();
  await jar.setCookie("session=old-fixture; Secure; HttpOnly; Path=/", "https://cookidoo.pl/");
  await authStore.saveCookieJar("fixture", jar);
  const root = await mkdtemp(join(tmpdir(), "cookidoo-axi-replace-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const envPath = join(root, "replacement.env");
  await writeFile(envPath, [
    "COOKIDOO_EMAIL=new@example.invalid",
    "COOKIDOO_PASSWORD=new-fixture-password",
    "",
  ].join("\n"), { mode: 0o600 });

  const blockedOut = outputBuffer();
  const blocked = await run([
    "auth", "import-env", "--env-file", envPath, "--profile", "fixture", "--output", "json",
  ], { platform: "darwin", stdout: blockedOut.stream, authStore, feedStore });
  process.exitCode = undefined;
  assert.equal(blocked, 2);
  assert.equal(JSON.parse(blockedOut.read()).data.error.code, "CREDENTIAL_REPLACEMENT_CONFIRMATION_REQUIRED");
  assert.ok(await authStore.loadCookieJar("fixture"));

  const stdout = outputBuffer();
  const code = await run([
    "auth", "import-env", "--env-file", envPath, "--profile", "fixture",
    "--confirm", "replace:market:fixture", "--output", "json",
  ], { platform: "darwin", stdout: stdout.stream, authStore, feedStore });
  process.exitCode = undefined;
  assert.equal(code, 0);
  assert.deepEqual(await authStore.loadCredentials("fixture"), {
    username: "new@example.invalid",
    password: "new-fixture-password",
  });
  assert.equal(await authStore.loadCookieJar("fixture"), undefined);
  const result = JSON.parse(stdout.read());
  assert.equal(result.data.marketRecordReplaced, true);
  assert.equal(result.data.cookieSessionRecordRemoved, true);
  assert.equal(
    result.next[0].command,
    "cookidoo-axi profile get-localized --profile 'fixture' --output 'json'",
  );
  assert.doesNotMatch(stdout.read(), /(?:old|new)-fixture-password/u);
});

test("market import validates the complete file before accessing account state", async (t) => {
  const adapter = new MemoryAdapter();
  const authStore = new KeychainAuthStore(adapter);
  const feedStore = new FeedCredentialStore(adapter);
  await authStore.saveCredentials("fixture", {
    username: "old@example.invalid",
    password: "old-fixture-password",
  });
  await authStore.saveCookieJar("fixture", new CookieJar());
  const credentialKey = adapter.key(KEYCHAIN_SERVICES.credentials, "fixture");
  const sessionKey = adapter.key(KEYCHAIN_SERVICES.cookieSession, "fixture");
  const originalCredentialSecret = adapter.secrets.get(credentialKey);
  const originalSessionSecret = adapter.secrets.get(sessionKey);

  const root = await mkdtemp(join(tmpdir(), "cookidoo-axi-invalid-import-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const envPath = join(root, "invalid.env");
  await writeFile(envPath, [
    'COOKIDOO_EMAIL="invalid\\nusername"',
    "COOKIDOO_PASSWORD=new-fixture-password",
    "",
  ].join("\n"), { mode: 0o600 });

  adapter.events.length = 0;
  adapter.getCalls.length = 0;
  adapter.setCalls.length = 0;
  adapter.deleteCalls.length = 0;
  const stdout = outputBuffer();
  const code = await run([
    "auth", "import-env", "--env-file", envPath, "--profile", "fixture",
    "--confirm", "replace:market:fixture", "--output", "json",
  ], { platform: "darwin", stdout: stdout.stream, authStore, feedStore });
  process.exitCode = undefined;

  assert.equal(code, 1);
  assert.equal(JSON.parse(stdout.read()).data.error.code, "ENV_CREDENTIALS_MISSING");
  assert.deepEqual(adapter.events, [], "invalid input must not read, delete, or write Keychain");
  assert.equal(adapter.secrets.get(credentialKey), originalCredentialSecret);
  assert.equal(adapter.secrets.get(sessionKey), originalSessionSecret);
});

test("market import removes an orphaned session before storing first credentials", async (t) => {
  const adapter = new MemoryAdapter();
  const authStore = new KeychainAuthStore(adapter);
  const feedStore = new FeedCredentialStore(adapter);
  const jar = new CookieJar();
  await jar.setCookie("session=orphaned-fixture; Secure; HttpOnly; Path=/", "https://cookidoo.pl/");
  await authStore.saveCookieJar("fixture", jar);

  const root = await mkdtemp(join(tmpdir(), "cookidoo-axi-orphan-import-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const envPath = join(root, "credentials.env");
  await writeFile(envPath, [
    "COOKIDOO_EMAIL=new@example.invalid",
    "COOKIDOO_PASSWORD=new-fixture-password",
    "",
  ].join("\n"), { mode: 0o600 });

  adapter.events.length = 0;
  const stdout = outputBuffer();
  const code = await run([
    "auth", "import-env", "--env-file", envPath, "--profile", "fixture", "--output", "json",
  ], { platform: "darwin", stdout: stdout.stream, authStore, feedStore });
  process.exitCode = undefined;

  assert.equal(code, 0);
  assert.deepEqual(adapter.events, [
    { action: "get", service: KEYCHAIN_SERVICES.credentials, account: "fixture" },
    { action: "delete", service: KEYCHAIN_SERVICES.cookieSession, account: "fixture" },
    { action: "set", service: KEYCHAIN_SERVICES.credentials, account: "fixture" },
  ]);
  assert.equal(
    adapter.secrets.has(adapter.key(KEYCHAIN_SERVICES.cookieSession, "fixture")),
    false,
  );
  assert.equal(
    adapter.secrets.has(adapter.key(KEYCHAIN_SERVICES.credentials, "fixture")),
    true,
  );
  const result = JSON.parse(stdout.read()).data;
  assert.equal(result.marketRecordReplaced, false);
  assert.equal(result.cookieSessionRecordRemoved, true);
});

test("market import never commits new credentials when session invalidation fails", async (t) => {
  const adapter = new MemoryAdapter();
  const authStore = new KeychainAuthStore(adapter);
  const feedStore = new FeedCredentialStore(adapter);
  await authStore.saveCredentials("fixture", {
    username: "old@example.invalid",
    password: "old-fixture-password",
  });
  await authStore.saveCookieJar("fixture", new CookieJar());
  const credentialKey = adapter.key(KEYCHAIN_SERVICES.credentials, "fixture");
  const sessionKey = adapter.key(KEYCHAIN_SERVICES.cookieSession, "fixture");
  const originalCredentialSecret = adapter.secrets.get(credentialKey);
  const originalSessionSecret = adapter.secrets.get(sessionKey);

  const root = await mkdtemp(join(tmpdir(), "cookidoo-axi-delete-failure-import-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const envPath = join(root, "replacement.env");
  await writeFile(envPath, [
    "COOKIDOO_EMAIL=new@example.invalid",
    "COOKIDOO_PASSWORD=new-fixture-password",
    "",
  ].join("\n"), { mode: 0o600 });

  adapter.events.length = 0;
  adapter.failDeleteService = KEYCHAIN_SERVICES.cookieSession;
  const stdout = outputBuffer();
  const code = await run([
    "auth", "import-env", "--env-file", envPath, "--profile", "fixture",
    "--confirm", "replace:market:fixture", "--output", "json",
  ], { platform: "darwin", stdout: stdout.stream, authStore, feedStore });
  process.exitCode = undefined;

  assert.equal(code, 1);
  assert.equal(JSON.parse(stdout.read()).data.error.code, "KEYCHAIN_DELETE_FAILED");
  assert.deepEqual(adapter.events, [
    { action: "get", service: KEYCHAIN_SERVICES.credentials, account: "fixture" },
    { action: "delete", service: KEYCHAIN_SERVICES.cookieSession, account: "fixture" },
  ]);
  assert.equal(adapter.secrets.get(credentialKey), originalCredentialSecret);
  assert.equal(adapter.secrets.get(sessionKey), originalSessionSecret);
  assert.doesNotMatch(stdout.read(), /(?:old|new)-fixture-password/u);
});

test("profile removal stops after a partial session-first deletion and preserves recovery credentials", async () => {
  const adapter = new MemoryAdapter();
  const authStore = new KeychainAuthStore(adapter);
  const feedStore = new FeedCredentialStore(adapter);
  await authStore.saveCredentials("fixture", {
    username: "market@example.invalid",
    password: "market-fixture-password",
  });
  await authStore.saveCookieJar("fixture", new CookieJar());
  await feedStore.saveCredentials("fixture", {
    username: "feed-fixture-user",
    password: "feed-fixture-password",
  });

  adapter.events.length = 0;
  adapter.failDeleteService = KEYCHAIN_SERVICES.credentials;
  const stdout = outputBuffer();
  const code = await run([
    "auth", "remove", "--profile", "fixture", "--confirm", "fixture", "--output", "json",
  ], { platform: "darwin", stdout: stdout.stream, authStore, feedStore });
  process.exitCode = undefined;

  assert.equal(code, 1);
  assert.equal(JSON.parse(stdout.read()).data.error.code, "KEYCHAIN_DELETE_FAILED");
  assert.deepEqual(adapter.events, [
    { action: "delete", service: KEYCHAIN_SERVICES.cookieSession, account: "fixture" },
    { action: "delete", service: KEYCHAIN_SERVICES.credentials, account: "fixture" },
  ]);
  assert.equal(
    adapter.secrets.has(adapter.key(KEYCHAIN_SERVICES.cookieSession, "fixture")),
    false,
  );
  assert.equal(
    adapter.secrets.has(adapter.key(KEYCHAIN_SERVICES.credentials, "fixture")),
    true,
  );
  assert.equal(
    adapter.secrets.has(adapter.key(FEED_KEYCHAIN_SERVICE, "fixture")),
    true,
  );
});

test("auth status isolates an invalid feed record and exact-confirmed import can repair it", async (t) => {
  const adapter = new MemoryAdapter();
  const authStore = new KeychainAuthStore(adapter);
  const feedStore = new FeedCredentialStore(adapter);
  await authStore.saveCredentials("fixture", {
    username: "market@example.invalid", password: "market-fixture-password",
  });
  adapter.secrets.set(adapter.key(FEED_KEYCHAIN_SERVICE, "fixture"), "{\"schema\":\"legacy\"}");

  const statusOut = outputBuffer();
  const statusCode = await run([
    "auth", "status", "--inspect", "all", "--profile", "fixture", "--output", "json",
  ], {
    platform: "darwin", stdout: statusOut.stream, authStore, feedStore,
  });
  process.exitCode = undefined;
  assert.equal(statusCode, 0);
  const statusEnvelope = JSON.parse(statusOut.read());
  const status = statusEnvelope.data;
  assert.equal(status.marketCredentialState, "stored-valid");
  assert.equal(status.feedCredentialState, "stored-invalid");
  assert.equal(
    statusEnvelope.next[0].command,
    "cookidoo-axi auth login --profile 'fixture' --output 'json'",
  );

  await authStore.saveCookieJar("fixture", new CookieJar());
  const cachedOut = outputBuffer();
  const cachedCode = await run([
    "auth", "status", "--inspect", "session", "--profile", "fixture", "--output", "json",
  ], {
    platform: "darwin", stdout: cachedOut.stream, authStore, feedStore,
  });
  process.exitCode = undefined;
  assert.equal(cachedCode, 0);
  const cached = JSON.parse(cachedOut.read());
  assert.equal(cached.data.cookieSessionState, "stored-unverified");
  assert.equal(
    cached.next[0].command,
    "cookidoo-axi profile get-localized --profile 'fixture' --output 'json'",
  );

  const root = await mkdtemp(join(tmpdir(), "cookidoo-axi-feed-repair-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const envPath = join(root, "feed.env");
  await writeFile(envPath, [
    "COOKIDOO_FEED_USERNAME=feed-fixture-user",
    "COOKIDOO_FEED_PASSWORD=feed-fixture-password",
    "",
  ].join("\n"), { mode: 0o600 });
  const blockedOut = outputBuffer();
  const blocked = await run([
    "auth", "import-feed-env", "--env-file", envPath, "--profile", "fixture", "--output", "json",
  ], { platform: "darwin", stdout: blockedOut.stream, authStore, feedStore });
  process.exitCode = undefined;
  assert.equal(blocked, 2);
  assert.equal(JSON.parse(blockedOut.read()).data.error.code, "CREDENTIAL_REPLACEMENT_CONFIRMATION_REQUIRED");

  const repairedOut = outputBuffer();
  const repaired = await run([
    "auth", "import-feed-env", "--env-file", envPath, "--profile", "fixture",
    "--confirm", "replace:feed:fixture", "--output", "json",
  ], { platform: "darwin", stdout: repairedOut.stream, authStore, feedStore });
  process.exitCode = undefined;
  assert.equal(repaired, 0);
  assert.equal((await feedStore.loadCredentials("fixture")).username, "feed-fixture-user");
  assert.doesNotMatch(repairedOut.read(), /feed-fixture-(?:user|password)/u);
});

test("CLI rejects typed response drift and marks mutation response drift non-retryable", async () => {
  const readOut = outputBuffer();
  const readCode = await run(["recipe", "get", "r123", "--output", "json"], {
    platform: "darwin",
    stdout: readOut.stream,
    ...cliStores(),
    httpExecute: async (input) => ({
      operationId: input.operation.operationId,
      method: input.operation.method,
      status: 200,
      contentType: "application/json",
      headers: {}, data: "wrong", bodyKind: "json", empty: false,
      attempts: 1, reauthenticated: false,
    }),
  });
  process.exitCode = undefined;
  assert.equal(readCode, 1);
  assert.equal(JSON.parse(readOut.read()).data.error.code, "RESPONSE_CONTRACT_MISMATCH");

  const mutationOut = outputBuffer();
  const id = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
  const mutationCode = await run([
    "created", "update", id, "--name", "offline", "--output", "json",
  ], {
    platform: "darwin",
    stdout: mutationOut.stream,
    ...cliStores(),
    httpExecute: async (input) => ({
      operationId: input.operation.operationId,
      method: input.operation.method,
      status: 200,
      contentType: "application/json",
      headers: {}, data: "wrong", bodyKind: "json", empty: false,
      attempts: 1, reauthenticated: false,
    }),
  });
  process.exitCode = undefined;
  assert.equal(mutationCode, 1);
  const mutationError = JSON.parse(mutationOut.read()).data.error;
  assert.equal(mutationError.code, "RESPONSE_CONTRACT_MISMATCH");
  assert.equal(mutationError.outcome, "response-received");
  assert.equal(mutationError.retrySafe, false);
  assert.ok(mutationError.suggestions.includes("Do not repeat this mutation automatically."));
  const reconcile = mutationError.suggestions.find((value) => value.startsWith("Reconcile with: "));
  assert.ok(reconcile);
  const reconcileArgv = shellArgv(reconcile.slice("Reconcile with: ".length));
  assert.deepEqual(reconcileArgv.slice(0, 4), ["cookidoo-axi", "created", "get", id]);
  assert.equal(
    parseInvocation(reconcileArgv.slice(1), OPENAPI_MANIFEST.operations).kind,
    "operation",
  );
});

test("CLI reports unknown detail contracts as unknown rather than complete", async () => {
  const stdout = outputBuffer();
  const code = await run([
    "organize", "custom-list", "get", "L1", "--output", "json",
  ], {
    platform: "darwin",
    stdout: stdout.stream,
    ...cliStores(),
    httpExecute: async (input) => ({
      operationId: input.operation.operationId,
      method: input.operation.method,
      status: 200,
      contentType: "application/json",
      headers: {}, data: { id: "L1", items: [1, 2] }, bodyKind: "json", empty: false,
      attempts: 1, reauthenticated: false,
    }),
  });
  process.exitCode = undefined;
  assert.equal(code, 0);
  assert.equal(JSON.parse(stdout.read()).completeness.state, "unknown");
});

test("CLI preserves final-page coordinates, links, and provider extension metadata", async () => {
  const stdout = outputBuffer();
  const providerPage = {
    customlists: [{
      id: "L21",
      title: "offline",
      chapters: [],
      listType: "CUSTOMLIST",
      author: "fixture",
    }],
    page: {
      page: 1,
      totalPages: 2,
      totalElements: 21,
      providerPageToken: "page-token",
    },
    links: { self: "/organize/lists?page=1", previous: "/organize/lists?page=0" },
    providerCursor: "cursor-21",
  };
  const code = await run([
    "organize", "custom-list", "list", "--page", "1", "--full", "--output", "json",
  ], {
    platform: "darwin",
    stdout: stdout.stream,
    ...cliStores(),
    httpExecute: async (input) => ({
      operationId: input.operation.operationId,
      method: input.operation.method,
      status: 200,
      contentType: "application/vnd.vorwerk.organize.custom-list.mobile+json",
      headers: {}, data: providerPage, bodyKind: "json", empty: false,
      attempts: 1, reauthenticated: false,
    }),
  });
  process.exitCode = undefined;
  assert.equal(code, 0, stdout.read());
  const output = JSON.parse(stdout.read());
  assert.deepEqual(output.completeness, {
    state: "partial",
    shown: 1,
    total: 21,
    hasMore: false,
  });
  assert.deepEqual(output.context.upstream, {
    page: { ...providerPage.page, providerPageToken: "[REDACTED]" },
    links: providerPage.links,
    providerCursor: "cursor-21",
  });

  const responseSecret = "SYNTHETIC_RESPONSE_URL_SECRET";
  const responseSecretOut = outputBuffer();
  const responseSecretCode = await run([
    "organize", "custom-list", "list", "--page", "1", "--full", "--output", "json",
  ], {
    platform: "darwin",
    stdout: responseSecretOut.stream,
    ...cliStores(),
    httpExecute: async (input) => ({
      operationId: input.operation.operationId,
      method: input.operation.method,
      status: 200,
      contentType: "application/vnd.vorwerk.organize.custom-list.mobile+json",
      headers: {},
      data: {
        ...providerPage,
        customlists: [{
          ...providerPage.customlists[0],
          id: `https://user:${responseSecret}@example.invalid/list`,
        }],
      },
      bodyKind: "json",
      empty: false,
      attempts: 1,
      reauthenticated: false,
    }),
  });
  process.exitCode = undefined;
  assert.equal(responseSecretCode, 0);
  const responseSecretText = responseSecretOut.read();
  assert.doesNotMatch(responseSecretText, new RegExp(responseSecret, "u"));
  const responseSecretResult = JSON.parse(responseSecretText);
  assert.equal(
    responseSecretResult.next.some(({ command }) =>
      command.startsWith("cookidoo-axi organize custom-list get")),
    false,
  );

  const emptyOut = outputBuffer();
  const emptyCode = await run([
    "search", "recipes", "--pagination", "3", "--full", "--output", "json",
  ], {
    platform: "darwin",
    stdout: emptyOut.stream,
    ...cliStores(),
    httpExecute: async (input) => ({
      operationId: input.operation.operationId,
      method: input.operation.method,
      status: 200,
      contentType: "application/json",
      headers: {},
      data: {
        data: [],
        page: { page: 3, totalElements: 21 },
        links: { self: "/search?pagination=3" },
        providerCursor: "cursor-after-results",
      },
      bodyKind: "json",
      empty: false,
      attempts: 1,
      reauthenticated: false,
    }),
  });
  process.exitCode = undefined;
  assert.equal(emptyCode, 0, emptyOut.read());
  const emptyPage = JSON.parse(emptyOut.read());
  assert.deepEqual(emptyPage.completeness, {
    state: "partial",
    shown: 0,
    total: 21,
    hasMore: null,
  });
  assert.deepEqual(emptyPage.context.upstream, {
    page: { page: 3, totalElements: 21 },
    links: { self: "/search?pagination=3" },
    providerCursor: "cursor-after-results",
  });
});

test("known collections use minimal agent-default fields with explicit full escape", async () => {
  const card = {
    id: "r123",
    title: "offline",
    totalTime: 900,
    rating: 4.5,
    numberOfRatings: 10,
    image: "https://example.invalid/image.jpg",
    descriptiveAssets: [{ very: "rich" }],
    publishedAt: "2026-08-18T00:00:00Z",
    providerExtra: "not in the default projection",
  };
  const invoke = async (full) => {
    const stdout = outputBuffer();
    const code = await run([
      "search", "recipes", "--query", "offline", ...(full ? ["--full"] : []),
      "--output", "json",
    ], {
      platform: "darwin", stdout: stdout.stream, ...cliStores(),
      httpExecute: async (input) => ({
        operationId: input.operation.operationId,
        method: input.operation.method,
        status: 200,
        contentType: "application/json",
        headers: {}, data: { data: [card] }, bodyKind: "json", empty: false,
        attempts: 1, reauthenticated: false,
      }),
    });
    process.exitCode = undefined;
    assert.equal(code, 0);
    return JSON.parse(stdout.read());
  };
  const compact = await invoke(false);
  assert.deepEqual(compact.data[0], {
    id: "r123", title: "offline", totalTime: 900, rating: 4.5, numberOfRatings: 10,
  });
  assert.equal(compact.context.projection.mode, "agent-default");
  const full = await invoke(true);
  assert.equal(full.data[0].providerExtra, "not in the default projection");
  assert.deepEqual(full.selection.requested, []);
});

test("unknown feed collections derive a bounded minimal schema from each actual page", async () => {
  const item = {
    id: "event-1",
    type: "recipe-change",
    occurredAt: "2026-08-18T00:00:00Z",
    payload: {
      recipeId: "r123",
      title: "offline",
      richDocument: { provider: "large" },
    },
    providerExtra: "not in the adaptive default projection",
  };
  const cases = [
    ["bootstrapCollectionFeed", ["feed", "bootstrap"]],
    ["getCollectionFeed", ["feed", "list"]],
    ["getCollectionFeedPage", ["feed", "page", "--page-before", "2026-08-18T00:00:00Z"]],
  ];
  for (const [operationId, argv] of cases) {
    const invoke = async (full) => {
      const stdout = outputBuffer();
      const code = await run([...argv, ...(full ? ["--full"] : []), "--output", "json"], {
        platform: "darwin",
        stdout: stdout.stream,
        ...cliStores(),
        httpExecute: async (input) => ({
          operationId: input.operation.operationId,
          method: input.operation.method,
          status: 200,
          contentType: "application/hal+json",
          headers: {},
          data: { items: [item], _links: {} },
          bodyKind: "json",
          empty: false,
          attempts: 1,
          reauthenticated: false,
        }),
      });
      process.exitCode = undefined;
      assert.equal(code, 0, `${operationId}: ${stdout.read()}`);
      return JSON.parse(stdout.read());
    };
    const compact = await invoke(false);
    assert.deepEqual(compact.context.projection, {
      mode: "agent-default",
      strategy: "per-item-adaptive-summary",
      maxScalarFieldsPerItem: 4,
      summarizedItems: 1,
      sourceFieldsOmitted: true,
      fullCommand: compact.context.projection.fullCommand,
    });
    assert.match(compact.context.projection.fullCommand, /^cookidoo-axi feed .+ --full$/u);
    assert.equal(compact.next[0].command, compact.context.projection.fullCommand);
    assert.deepEqual(compact.data[0], {
      id: "event-1",
      payload: { recipeId: "r123" },
      type: "recipe-change",
      occurredAt: "2026-08-18T00:00:00Z",
    });
    const full = await invoke(true);
    assert.equal(full.data[0].providerExtra, "not in the adaptive default projection");
  }
});

test("feed summaries cover every locally shown heterogeneous item beyond the default 20", async () => {
  const items = Array.from({ length: 30 }, (_, index) => index < 20 ? {
    id: `early-${index}`,
    type: "early",
    status: "observed",
    title: `early ${index}`,
    providerExtra: "not selected",
  } : {
    eventId: `late-${index}`,
    kind: "late",
    status: "changed",
    payload: { documentId: `document-${index}`, rich: { omitted: true } },
    providerExtra: "not selected",
  });
  const stdout = outputBuffer();
  const code = await run([
    "feed", "list", "--max-items", "25", "--output", "json",
  ], {
    platform: "darwin",
    stdout: stdout.stream,
    ...cliStores(),
    httpExecute: async (input) => ({
      operationId: input.operation.operationId,
      method: input.operation.method,
      status: 200,
      contentType: "application/hal+json",
      headers: {},
      data: { items, _links: {} },
      bodyKind: "json",
      empty: false,
      attempts: 1,
      reauthenticated: false,
    }),
  });
  process.exitCode = undefined;
  assert.equal(code, 0, stdout.read());
  const result = JSON.parse(stdout.read());
  assert.equal(result.data.length, 25);
  assert.ok(result.data.every((item) => Object.keys(item).length > 0));
  assert.deepEqual(result.data[20], {
    eventId: "late-20",
    payload: { documentId: "document-20" },
    kind: "late",
    status: "changed",
  });
  assert.deepEqual(result.completeness, {
    state: "partial", shown: 25, total: null, hasMore: true,
  });
  assert.equal(result.truncation.availableItems, 30);
  assert.equal(result.truncation.omittedItems, 5);
  assert.equal(result.context.projection.summarizedItems, 25);
  assert.doesNotMatch(JSON.stringify(result.data), /providerExtra|not selected/u);
});

test("rich-only feed items use safe structural descriptors while fields and full stay explicit", async () => {
  const secret = "SYNTHETIC_FEED_SECRET_MUST_NOT_APPEAR";
  const items = [{
    credentials: { token: secret },
    payload: { nested: { deep: "explicit-value" } },
    children: [{ rich: "omitted" }],
  }, [{ nested: "array-content" }], `Bearer ${secret}`];
  const invoke = async (extra) => {
    const stdout = outputBuffer();
    const code = await run(["feed", "bootstrap", ...extra, "--output", "json"], {
      platform: "darwin",
      stdout: stdout.stream,
      ...cliStores(),
      httpExecute: async (input) => ({
        operationId: input.operation.operationId,
        method: input.operation.method,
        status: 200,
        contentType: "application/hal+json",
        headers: {},
        data: { items, _links: {} },
        bodyKind: "json",
        empty: false,
        attempts: 1,
        reauthenticated: false,
      }),
    });
    process.exitCode = undefined;
    assert.equal(code, 0, stdout.read());
    const text = stdout.read();
    assert.doesNotMatch(text, new RegExp(secret, "u"));
    return JSON.parse(text);
  };

  const compact = await invoke([]);
  assert.deepEqual(compact.data, [
    { summary: "object", propertyCount: 3, content: "structure-only" },
    { summary: "array", itemCount: 1, content: "structure-only" },
    { summary: "string", content: "omitted" },
  ]);
  assert.doesNotMatch(JSON.stringify(compact), /credentials|payload|children|token/u);

  const selected = await invoke(["--fields", "payload.nested.deep"]);
  assert.deepEqual(selected.data, [
    { payload: { nested: { deep: "explicit-value" } } }, [{}], {},
  ]);
  assert.deepEqual(selected.selection.requested, ["payload.nested.deep"]);

  const full = await invoke(["--full"]);
  assert.equal(full.data[0].payload.nested.deep, "explicit-value");
  assert.equal(full.data[0].credentials, "[REDACTED]");
  assert.equal(full.redaction.applied, true);
});

test("invalid output options fail before any mutation dispatch", async () => {
  const stdout = outputBuffer();
  let dispatched = 0;
  const code = await run([
    "created", "create", "--recipe-name", "offline", "--fields", "a..b", "--output", "json",
  ], {
    platform: "darwin",
    stdout: stdout.stream,
    ...cliStores(),
    httpExecute: async () => { dispatched += 1; throw new Error("must not dispatch"); },
  });
  process.exitCode = undefined;
  assert.equal(code, 2);
  assert.equal(dispatched, 0);
  assert.equal(JSON.parse(stdout.read()).data.error.code, "INVALID_FIELDS");
});

test("mutation success suggestions are concrete commands that parse", async () => {
  const fixtures = [
    {
      argv: ["organize", "custom-list", "create", "--title", "offline"],
      data: { content: { id: "L1", title: "offline", chapters: [], listType: "CUSTOMLIST", author: "offline" } },
      expected: ["cookidoo-axi", "organize", "custom-list", "get", "L1"],
    },
    {
      argv: ["note", "create", "--recipe-id", "r123", "--text", "offline"],
      data: { text: "offline" },
      expected: ["cookidoo-axi", "note", "get", "r123"],
    },
    {
      argv: ["planning", "add", "--recipe-ids", "r123", "--day-key", "2026-08-18"],
      data: { content: { id: "D1", title: "day", dayKey: "2026-08-18", recipes: [] } },
      expected: ["cookidoo-axi", "planning", "week", "2026-08-18"],
    },
    {
      argv: ["organize", "shared-list", "share", "--custom-list-id", "L1", "--confirm", "custom-list:L1:share"],
      data: { sharedListId: "S1" },
      expected: ["cookidoo-axi", "organize", "shared-list", "get", "S1"],
    },
  ];
  for (const fixture of fixtures) {
    const stdout = outputBuffer();
    const code = await run([...fixture.argv, "--output", "json"], {
      platform: "darwin",
      stdout: stdout.stream,
      ...cliStores(),
      httpExecute: async (input) => ({
        operationId: input.operation.operationId,
        method: input.operation.method,
        status: 200,
        contentType: "application/json",
        headers: {}, data: fixture.data, bodyKind: "json", empty: false,
        attempts: 1, reauthenticated: false,
      }),
    });
    process.exitCode = undefined;
    assert.equal(code, 0, JSON.stringify(fixture.argv));
    const command = JSON.parse(stdout.read()).next[0]?.command;
    const argv = shellArgv(command);
    assert.deepEqual(argv.slice(0, fixture.expected.length), fixture.expected);
    assert.deepEqual(argv.slice(-2), ["--output", "json"]);
    const parsed = parseInvocation(argv.slice(1), OPENAPI_MANIFEST.operations);
    assert.equal(parsed.kind, "operation");
  }
});
