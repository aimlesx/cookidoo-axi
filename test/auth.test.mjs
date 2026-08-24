import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CookieJar } from "tough-cookie";

import { importCredentialsFromEnvFile } from "../dist/auth/env.js";
import { FEED_KEYCHAIN_SERVICE, FeedCredentialStore } from "../dist/auth/feed.js";
import {
  KEYCHAIN_SERVICES,
  KeychainAuthStore,
  createMacOSKeychainAdapter,
  normalizeAuthProfile,
} from "../dist/auth/keychain.js";
import {
  createCookieFetch,
  loadStoredSession,
  loginStoredProfile,
  loginWithBrowserSession,
} from "../dist/auth/login.js";

function authCode(code) {
  return (error) => {
    assert.equal(error?.name, "AuthError");
    assert.equal(error?.code, code);
    return true;
  };
}

class MemoryAdapter {
  secrets = new Map();
  calls = [];

  key(service, account) {
    return `${service}\u0000${account}`;
  }

  async getSecret(service, account) {
    this.calls.push(["get", service, account]);
    return this.secrets.get(this.key(service, account));
  }

  async setSecret(service, account, secret) {
    this.calls.push(["set", service, account]);
    this.secrets.set(this.key(service, account), secret);
  }

  async deleteSecret(service, account) {
    this.calls.push(["delete", service, account]);
    return this.secrets.delete(this.key(service, account));
  }

  async listAccounts(service) {
    this.calls.push(["list", service]);
    return [...this.secrets.keys()]
      .filter((key) => key.startsWith(`${service}\u0000`))
      .map((key) => key.slice(service.length + 1));
  }
}

test("profile normalization rejects injection-shaped names", () => {
  assert.equal(normalizeAuthProfile("agent.profile-1"), "agent.profile-1");
  for (const bad of ["", " leading", "../escape", "line\nbreak", "x".repeat(65)]) {
    assert.throws(() => normalizeAuthProfile(bad), authCode("INVALID_PROFILE"));
  }
});

test("Keychain store round-trips credentials and cookie jars through an injected adapter", async () => {
  const adapter = new MemoryAdapter();
  const store = new KeychainAuthStore(adapter);
  await store.saveCredentials("fixture", {
    username: "  offline@example.invalid  ",
    password: "fixture-password",
  });
  assert.deepEqual(await store.loadCredentials("fixture"), {
    username: "offline@example.invalid",
    password: "fixture-password",
  });

  const credentialSecret = adapter.secrets.get(adapter.key(KEYCHAIN_SERVICES.credentials, "fixture"));
  assert.equal(typeof credentialSecret, "string");
  assert.match(credentialSecret, /cookidoo-axi\.credentials/u);

  const jar = new CookieJar();
  await jar.setCookie("offline_session=fixture-cookie; Secure; HttpOnly; Path=/", "https://cookidoo.pl/");
  await store.saveCookieJar("fixture", jar);
  const loadedJar = await store.loadCookieJar("fixture");
  assert.ok(loadedJar instanceof CookieJar);
  assert.match(await loadedJar.getCookieString("https://cookidoo.pl/"), /offline_session=fixture-cookie/u);

  adapter.secrets.set(adapter.key(KEYCHAIN_SERVICES.credentials, "bad profile"), "ignored");
  assert.deepEqual(await store.listProfiles(), [{
    profile: "fixture",
    hasCredentials: true,
    hasCookieSession: true,
  }]);

  assert.deepEqual(await store.deleteProfile("fixture"), {
    profile: "fixture",
    credentialsDeleted: true,
    cookieSessionDeleted: true,
  });
  assert.equal(await store.loadCredentials("fixture"), undefined);
});

test("profile deletion is sequential and preserves credentials when session deletion fails", async () => {
  class FailingDeleteAdapter extends MemoryAdapter {
    failService;

    async deleteSecret(service, account) {
      this.calls.push(["delete", service, account]);
      if (service === this.failService) throw new Error("synthetic offline deletion failure");
      return this.secrets.delete(this.key(service, account));
    }
  }

  const sessionFailure = new FailingDeleteAdapter();
  const sessionFailureStore = new KeychainAuthStore(sessionFailure);
  await sessionFailureStore.saveCredentials("fixture", {
    username: "offline@example.invalid",
    password: "fixture-password",
  });
  await sessionFailureStore.saveCookieJar("fixture", new CookieJar());
  sessionFailure.calls.length = 0;
  sessionFailure.failService = KEYCHAIN_SERVICES.cookieSession;

  await assert.rejects(
    sessionFailureStore.deleteProfile("fixture"),
    /synthetic offline deletion failure/u,
  );
  assert.deepEqual(sessionFailure.calls, [[
    "delete", KEYCHAIN_SERVICES.cookieSession, "fixture",
  ]]);
  assert.equal(
    sessionFailure.secrets.has(sessionFailure.key(KEYCHAIN_SERVICES.cookieSession, "fixture")),
    true,
  );
  assert.equal(
    sessionFailure.secrets.has(sessionFailure.key(KEYCHAIN_SERVICES.credentials, "fixture")),
    true,
  );

  const credentialFailure = new FailingDeleteAdapter();
  const credentialFailureStore = new KeychainAuthStore(credentialFailure);
  await credentialFailureStore.saveCredentials("fixture", {
    username: "offline@example.invalid",
    password: "fixture-password",
  });
  await credentialFailureStore.saveCookieJar("fixture", new CookieJar());
  credentialFailure.calls.length = 0;
  credentialFailure.failService = KEYCHAIN_SERVICES.credentials;

  await assert.rejects(
    credentialFailureStore.deleteProfile("fixture"),
    /synthetic offline deletion failure/u,
  );
  assert.deepEqual(credentialFailure.calls, [
    ["delete", KEYCHAIN_SERVICES.cookieSession, "fixture"],
    ["delete", KEYCHAIN_SERVICES.credentials, "fixture"],
  ]);
  assert.equal(
    credentialFailure.secrets.has(credentialFailure.key(KEYCHAIN_SERVICES.cookieSession, "fixture")),
    false,
  );
  assert.equal(
    credentialFailure.secrets.has(credentialFailure.key(KEYCHAIN_SERVICES.credentials, "fixture")),
    true,
  );
});

test("corrupt Keychain records fail with fixed diagnostics that omit secret material", async () => {
  const adapter = new MemoryAdapter();
  const store = new KeychainAuthStore(adapter);
  adapter.secrets.set(
    adapter.key(KEYCHAIN_SERVICES.credentials, "fixture"),
    '{"password":"do-not-reflect-this","schema":"wrong"}',
  );
  await assert.rejects(
    store.loadCredentials("fixture"),
    (error) => {
      assert.equal(error.code, "KEYCHAIN_DATA_INVALID");
      assert.doesNotMatch(`${error.message} ${error.suggestion}`, /do-not-reflect-this/u);
      return true;
    },
  );
});

test("macOS adapter guards platform before loading native code and supports injected native fakes", async () => {
  let loaded = false;
  assert.throws(
    () => createMacOSKeychainAdapter({
      platform: "linux",
      loadKeyring: async () => {
        loaded = true;
        throw new Error("must not load");
      },
    }),
    authCode("UNSUPPORTED_PLATFORM"),
  );
  assert.equal(loaded, false);

  const native = new Map();
  let loadCount = 0;
  let exposedCredentials;
  class AsyncEntry {
    constructor(service, account) {
      this.key = `${service}\u0000${account}`;
    }
    async getPassword() { return native.get(this.key) ?? null; }
    async setPassword(value) { native.set(this.key, value); }
    async deleteCredential() { return native.delete(this.key); }
  }
  const adapter = createMacOSKeychainAdapter({
    platform: "darwin",
    environment: {},
    loadKeyring: async () => {
      loadCount += 1;
      return {
        AsyncEntry,
        async findCredentialsAsync(service) {
          exposedCredentials = [...native.entries()]
            .filter(([key]) => key.startsWith(`${service}\u0000`))
            .map(([key, password]) => ({ account: key.slice(service.length + 1), password }));
          return exposedCredentials;
        },
      };
    },
  });
  await adapter.setSecret("fixture.service", "fixture", "native-secret");
  assert.equal(await adapter.getSecret("fixture.service", "fixture"), "native-secret");
  assert.equal(await adapter.getSecret("fixture.service", "missing"), undefined);
  assert.deepEqual(await adapter.listAccounts("fixture.service"), ["fixture"]);
  assert.equal(exposedCredentials[0].password, "");
  assert.equal(loadCount, 1);
  assert.equal(await adapter.deleteSecret("fixture.service", "fixture"), true);
});

test("macOS adapter fails before native Keychain access inside the Codex Seatbelt sandbox", async () => {
  let loaded = false;
  const adapter = createMacOSKeychainAdapter({
    platform: "darwin",
    environment: { CODEX_SANDBOX: "seatbelt" },
    loadKeyring: async () => {
      loaded = true;
      throw new Error("must not load");
    },
  });

  for (const access of [
    () => adapter.getSecret("fixture.service", "fixture"),
    () => adapter.setSecret("fixture.service", "fixture", "synthetic-secret"),
    () => adapter.deleteSecret("fixture.service", "fixture"),
    () => adapter.listAccounts("fixture.service"),
  ]) {
    await assert.rejects(access, (error) => {
      assert.equal(error?.code, "KEYCHAIN_SANDBOXED");
      assert.match(error?.message ?? "", /Codex Seatbelt sandbox/u);
      assert.match(error?.suggestion ?? "", /outside the sandbox/u);
      assert.doesNotMatch(`${error?.message} ${error?.suggestion}`, /synthetic-secret/u);
      return true;
    });
  }
  assert.equal(loaded, false);
});

for (const [namespace, Store] of [
  ["market", KeychainAuthStore],
  ["feed", FeedCredentialStore],
]) {
  test(`${namespace} environment import rejects Seatbelt before reading the credential source`, async () => {
    let loaded = false;
    let read = false;
    const store = new Store(createMacOSKeychainAdapter({
      platform: "darwin",
      environment: { CODEX_SANDBOX: "seatbelt" },
      loadKeyring: async () => {
        loaded = true;
        throw new Error("must not load");
      },
    }));

    await assert.rejects(
      importCredentialsFromEnvFile({
        path: "/synthetic/credential-source-must-not-be-opened.env",
        store,
        readText: async () => {
          read = true;
          return [
            "COOKIDOO_EMAIL=offline@example.invalid",
            "COOKIDOO_PASSWORD=synthetic-secret",
          ].join("\n");
        },
      }),
      authCode("KEYCHAIN_SANDBOXED"),
    );
    assert.equal(read, false);
    assert.equal(loaded, false);
  });
}

test("environment import accepts bounded regular fixtures and returns key names only", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cookidoo-axi-env-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const envPath = join(root, "fixture.env");
  await writeFile(envPath, [
    "# wholly synthetic credentials",
    "export COOKIDOO_EMAIL='offline@example.invalid'",
    'COOKIDOO_PASSWORD="fixture\\tpassword"',
    "UNRELATED=$HOME-is-not-expanded",
    "",
  ].join("\n"), { mode: 0o600 });

  const writes = [];
  const result = await importCredentialsFromEnvFile({
    path: envPath,
    profile: "fixture",
    store: {
      validateCredentials(credentials) { return credentials; },
      async saveCredentials(profile, credentials) { writes.push({ profile, credentials }); },
    },
  });
  assert.deepEqual(result, {
    profile: "fixture",
    usernameKey: "COOKIDOO_EMAIL",
    passwordKey: "COOKIDOO_PASSWORD",
  });
  assert.deepEqual(writes, [{
    profile: "fixture",
    credentials: { username: "offline@example.invalid", password: "fixture\tpassword" },
  }]);
  assert.doesNotMatch(JSON.stringify(result), /offline|fixture\tpassword/u);
});

test("environment import rejects symlinks, ambiguity, duplicate keys, NUL, and oversize text", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cookidoo-axi-env-adversarial-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = join(root, "target.env");
  const link = join(root, "link.env");
  const oversized = join(root, "oversized.env");
  await writeFile(target, "COOKIDOO_EMAIL=x@example.invalid\nCOOKIDOO_PASSWORD=y\n", { mode: 0o600 });
  await writeFile(oversized, "COOKIDOO_EMAIL=a\nCOOKIDOO_PASSWORD=b\n", { mode: 0o600 });
  await symlink(target, link);
  let writes = 0;
  const store = {
    validateCredentials(credentials) { return credentials; },
    async saveCredentials() { writes += 1; },
  };
  await assert.rejects(
    importCredentialsFromEnvFile({ path: link, store }),
    authCode("ENV_FILE_UNSAFE"),
  );

  const invalidTexts = [
    "COOKIDOO_USERNAME=a\nCOOKIDOO_EMAIL=b\nCOOKIDOO_PASSWORD=c",
    "COOKIDOO_EMAIL=a\nCOOKIDOO_EMAIL=b\nCOOKIDOO_PASSWORD=c",
    "COOKIDOO_EMAIL=a\u0000b\nCOOKIDOO_PASSWORD=c",
  ];
  for (const text of invalidTexts) {
    await assert.rejects(
      importCredentialsFromEnvFile({ path: "unused", store, readText: async () => text }),
      authCode("ENV_FILE_INVALID"),
    );
  }
  await assert.rejects(
    importCredentialsFromEnvFile({ path: oversized, store, maxBytes: 8 }),
    authCode("ENV_FILE_UNSAFE"),
  );
  await chmod(target, 0o644);
  await assert.rejects(
    importCredentialsFromEnvFile({ path: target, store }),
    authCode("ENV_FILE_UNSAFE"),
  );
  assert.equal(writes, 0);
});

test("feed credentials use a separate Keychain namespace", async () => {
  const adapter = new MemoryAdapter();
  const feed = new FeedCredentialStore(adapter);
  await feed.saveCredentials("fixture", { username: "feed-user", password: "feed-password" });
  assert.equal(adapter.secrets.has(adapter.key(KEYCHAIN_SERVICES.credentials, "fixture")), false);
  assert.equal(adapter.secrets.has(adapter.key(FEED_KEYCHAIN_SERVICE, "fixture")), true);
  assert.deepEqual(await feed.loadCredentials("fixture"), {
    username: "feed-user",
    password: "feed-password",
  });
});

function loginForm(action = "https://ciam.prod.cookidoo.vorwerk-digital.com/session") {
  return `<!doctype html><form method="post" action="${action}">
    <input type="hidden" name="requestId" value="request-fixture">
    <input type="hidden" name="flow" value="offline">
    <input type="text" name="username">
    <input type="password" name="password">
  </form>`;
}

function fakeLoginFetch({ action = "success" } = {}) {
  const calls = [];
  const fetch = async (input, init = {}) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = init.method ?? (input instanceof Request ? input.method : "GET");
    calls.push({ url, method, init });
    if (calls.length === 1) {
      const html = action === "evil-host"
        ? loginForm("https://evil.invalid/collect")
        : loginForm();
      return new Response(html, { status: 200, headers: { "content-type": "text/html" } });
    }
    if (action === "replay-redirect") {
      return new Response(null, {
        status: 307,
        headers: { location: "https://cookidoo.pl/profile" },
      });
    }
    return new Response("ok", { status: 200 });
  };
  return { fetch, calls };
}

test("browser login submits credentials only to an allowlisted form and verifies a protected read", async () => {
  const fake = fakeLoginFetch();
  let verifierContext;
  const result = await loginWithBrowserSession({
    credentials: { username: "offline@example.invalid", password: "fixture-password" },
    fetch: fake.fetch,
    verifyProtectedRead: async (context) => {
      verifierContext = context;
      return true;
    },
  });
  assert.equal(result.gatewayOrigin, "https://cookidoo.pl");
  assert.equal(result.verification, "verified");
  assert.equal(fake.calls.length, 2);
  assert.match(fake.calls[0].url, /^https:\/\/cookidoo\.pl\/profile\/pl\/login\?/u);
  assert.equal(fake.calls[1].url, "https://ciam.prod.cookidoo.vorwerk-digital.com/session");
  assert.equal(fake.calls[1].method, "POST");
  const submitted = new URLSearchParams(fake.calls[1].init.body);
  assert.equal(submitted.get("requestId"), "request-fixture");
  assert.equal(submitted.get("flow"), "offline");
  assert.equal(submitted.get("username"), "offline@example.invalid");
  assert.equal(submitted.get("password"), "fixture-password");
  assert.equal(verifierContext.gatewayOrigin, "https://cookidoo.pl");
  assert.equal(verifierContext.signal.aborted, false);
});

test("browser login follows the exact current Vorwerk federation host without widening the allowlist", async () => {
  const calls = [];
  const fetch = async (input, init = {}) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = init.method ?? (input instanceof Request ? input.method : "GET");
    calls.push({ url, method });
    if (calls.length === 1) {
      return new Response(null, {
        status: 302,
        headers: { location: "https://ciam.prod.cookidoo.vorwerk-digital.com/authorize" },
      });
    }
    if (calls.length === 2) {
      return new Response(null, {
        status: 302,
        headers: { location: "https://eu.login.vorwerk.com/login" },
      });
    }
    if (calls.length === 3) {
      return new Response(loginForm(), {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    }
    return new Response("ok", { status: 200 });
  };

  const result = await loginWithBrowserSession({
    credentials: { username: "offline@example.invalid", password: "fixture-password" },
    fetch,
    verifyProtectedRead: async () => true,
  });

  assert.equal(result.verification, "verified");
  assert.equal(calls.length, 4);
  assert.equal(new URL(calls[1].url).hostname, "ciam.prod.cookidoo.vorwerk-digital.com");
  assert.equal(new URL(calls[2].url).hostname, "eu.login.vorwerk.com");
  assert.equal(calls[3].url, "https://ciam.prod.cookidoo.vorwerk-digital.com/session");
  assert.equal(calls[3].method, "POST");
});

test("browser login permits a market 307 only after the credential POST has already become GET", async () => {
  const calls = [];
  const fetch = async (input, init = {}) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = init.method ?? (input instanceof Request ? input.method : "GET");
    calls.push({ url, method, body: init.body });
    if (calls.length === 1) {
      return new Response(loginForm(), {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    }
    if (calls.length === 2) {
      return new Response(null, {
        status: 302,
        headers: { location: "https://cookidoo.pl/oauth2/callback?code=offline&state=offline" },
      });
    }
    if (calls.length === 3) {
      return new Response(null, {
        status: 307,
        headers: { location: "https://cookidoo.pl/community/profile" },
      });
    }
    return new Response("ok", { status: 200 });
  };

  const result = await loginWithBrowserSession({
    credentials: { username: "offline@example.invalid", password: "fixture-password" },
    fetch,
    verifyProtectedRead: async () => true,
  });

  assert.equal(result.verification, "verified");
  assert.deepEqual(calls.map((call) => call.method), ["GET", "POST", "GET", "GET"]);
  assert.equal(calls.filter((call) => call.method === "POST").length, 1);
  assert.equal(calls[2].body, undefined);
  assert.equal(calls[3].body, undefined);
});

test("browser login rejects hostile actions before sending credentials and blocks 307 replay", async () => {
  const secret = "fixture-password-never-reflect";
  const evil = fakeLoginFetch({ action: "evil-host" });
  await assert.rejects(
    loginWithBrowserSession({
      credentials: { username: "offline@example.invalid", password: secret },
      fetch: evil.fetch,
    }),
    (error) => {
      assert.equal(error.code, "LOGIN_HOST_REJECTED");
      assert.doesNotMatch(`${error.message} ${error.suggestion}`, new RegExp(secret, "u"));
      return true;
    },
  );
  assert.equal(evil.calls.length, 1);

  const replay = fakeLoginFetch({ action: "replay-redirect" });
  await assert.rejects(
    loginWithBrowserSession({
      credentials: { username: "offline@example.invalid", password: secret },
      fetch: replay.fetch,
    }),
    authCode("LOGIN_SUBMISSION_FAILED"),
  );
  assert.equal(replay.calls.length, 2);

  const completionCalls = [];
  const externalCompletion = async (input, init = {}) => {
    const url = input instanceof Request ? input.url : String(input);
    completionCalls.push({ url, init });
    if (completionCalls.length === 1) {
      return new Response(loginForm(), { status: 200, headers: { "content-type": "text/html" } });
    }
    return new Response(null, { status: 302, headers: { location: "https://evil.invalid/collect" } });
  };
  await assert.rejects(
    loginWithBrowserSession({
      credentials: { username: "offline@example.invalid", password: secret },
      fetch: externalCompletion,
    }),
    authCode("LOGIN_HOST_REJECTED"),
  );
  assert.equal(completionCalls.length, 2, "the hostile completion must not be followed");

  let attackerCalls = 0;
  await assert.rejects(
    loginWithBrowserSession({
      baseUrl: "https://attacker.invalid",
      credentials: { username: "offline@example.invalid", password: secret },
      fetch: async () => { attackerCalls += 1; throw new Error("must not dispatch"); },
    }),
    authCode("LOGIN_INPUT_INVALID"),
  );
  assert.equal(attackerCalls, 0);
});

test("stored-profile login persists a jar only after protected-read verification", async () => {
  const fake = fakeLoginFetch();
  let saved = 0;
  const store = {
    async loadCredentials(profile) {
      assert.equal(profile, "fixture");
      return { username: "offline@example.invalid", password: "fixture-password" };
    },
    async saveCookieJar(profile, jar) {
      assert.equal(profile, "fixture");
      assert.ok(jar instanceof CookieJar);
      saved += 1;
    },
    async loadCookieJar() { return undefined; },
  };
  const result = await loginStoredProfile({
    profile: "fixture",
    store,
    fetch: fake.fetch,
    verifyProtectedRead: async () => true,
  });
  assert.deepEqual(result, {
    profile: "fixture",
    gatewayOrigin: "https://cookidoo.pl",
    verification: "verified",
  });
  assert.equal(saved, 1);

  const rejected = fakeLoginFetch();
  await assert.rejects(
    loginStoredProfile({
      profile: "fixture",
      store,
      fetch: rejected.fetch,
      verifyProtectedRead: async () => false,
    }),
    authCode("LOGIN_VERIFICATION_FAILED"),
  );
  assert.equal(saved, 1);
});

test("stored session and cookie fetch use injected storage and transport", async () => {
  const missingStore = { async loadCookieJar() { return undefined; } };
  await assert.rejects(
    loadStoredSession({ profile: "fixture", store: missingStore }),
    authCode("SESSION_NOT_FOUND"),
  );

  const jar = new CookieJar();
  await jar.setCookie(
    "offline_session=fixture; Secure; HttpOnly; Path=/",
    "https://cookidoo.pl/",
  );
  const observedCookies = [];
  const fetch = async (_input, init = {}) => {
    observedCookies.push(new Headers(init.headers).get("cookie"));
    return new Response("offline fixture", { status: 200 });
  };
  const session = await loadStoredSession({
    profile: "fixture",
    store: { async loadCookieJar() { return jar; } },
    fetch,
  });
  await session.fetch("https://cookidoo.pl/fixture");
  assert.match(observedCookies[0], /offline_session=fixture/u);

  const direct = createCookieFetch(jar, fetch);
  assert.equal(typeof direct, "function");
});
