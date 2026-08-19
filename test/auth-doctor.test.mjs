import assert from "node:assert/strict";
import test from "node:test";

import { FeedCredentialStore } from "../dist/auth/feed.js";
import {
  KeychainAuthStore,
  probeMacOSKeychainBinding,
} from "../dist/auth/keychain.js";
import { groupHelp } from "../dist/cli/help.js";
import { parseInvocation } from "../dist/cli/parser.js";
import { OPENAPI_MANIFEST } from "../dist/api/spec.js";

async function run(...arguments_) {
  const cli = await import("../dist/cli.js");
  return cli.run(...arguments_);
}

function nativeFixture(onConstruct = () => {}) {
  class AsyncEntry {
    constructor() { onConstruct(); }
    async getPassword() { return null; }
    async setPassword() {}
    async deleteCredential() { return false; }
  }
  return {
    AsyncEntry,
    async findCredentialsAsync() { return []; },
  };
}

function outputBuffer() {
  let value = "";
  return {
    stream: { write(chunk) { value += String(chunk); } },
    read: () => value,
  };
}

test("binding probe validates exports without constructing or accessing a Keychain entry", async () => {
  let loads = 0;
  let constructions = 0;
  const result = await probeMacOSKeychainBinding({
    platform: "darwin",
    loadKeyring: async () => {
      loads += 1;
      return nativeFixture(() => { constructions += 1; });
    },
  });

  assert.equal(loads, 1);
  assert.equal(constructions, 0);
  assert.deepEqual(result, {
    binding: "loaded",
    platform: "darwin",
    architecture: process.arch,
    nodeApiVersion: process.versions.napi ?? "unavailable",
    requiredExports: [
      "AsyncEntry",
      "AsyncEntry.prototype.getPassword",
      "AsyncEntry.prototype.setPassword",
      "AsyncEntry.prototype.deleteCredential",
      "findCredentialsAsync",
    ],
    keychainAccess: "not-requested",
    keychainRecordsRead: 0,
    keychainRecordsWritten: 0,
    networkRequests: 0,
  });
});

test("binding probe guards the platform and sanitizes incompatible native modules", async () => {
  let loads = 0;
  await assert.rejects(
    probeMacOSKeychainBinding({
      platform: "linux",
      loadKeyring: async () => {
        loads += 1;
        return nativeFixture();
      },
    }),
    (error) => error?.code === "UNSUPPORTED_PLATFORM",
  );
  assert.equal(loads, 0);

  const sentinel = "SYNTHETIC_NATIVE_FAILURE_DO_NOT_REFLECT";
  await assert.rejects(
    probeMacOSKeychainBinding({
      platform: "darwin",
      loadKeyring: async () => ({
        AsyncEntry: class {},
        findCredentialsAsync: sentinel,
      }),
    }),
    (error) => {
      assert.equal(error?.code, "KEYCHAIN_UNAVAILABLE");
      assert.doesNotMatch(`${error?.message} ${error?.suggestion}`, new RegExp(sentinel, "u"));
      return true;
    },
  );
});

test("auth doctor is a bounded prompt-free CLI command with structured evidence", async () => {
  const parsed = parseInvocation(["auth", "doctor", "--output", "json"], OPENAPI_MANIFEST.operations);
  assert.equal(parsed.kind, "auth-doctor");
  assert.throws(
    () => parseInvocation(["auth", "doctor", "extra"], OPENAPI_MANIFEST.operations),
    (error) => error?.code === "EXTRA_ARGUMENT",
  );
  const help = groupHelp(["auth", "doctor"], OPENAPI_MANIFEST.operations);
  assert.match(help, /reads and\s+writes exactly zero Keychain records/u);
  assert.match(help, /performs no network request/u);

  const keychainCalls = [];
  const adapter = {
    async getSecret() { keychainCalls.push("read"); throw new Error("must not read"); },
    async setSecret() { keychainCalls.push("write"); throw new Error("must not write"); },
    async deleteSecret() { keychainCalls.push("delete"); throw new Error("must not delete"); },
    async listAccounts() { keychainCalls.push("list"); throw new Error("must not list"); },
  };
  const stdout = outputBuffer();
  let constructions = 0;
  let networkCalls = 0;
  const code = await run(["auth", "doctor", "--output", "json"], {
    platform: "darwin",
    stdout: stdout.stream,
    authStore: new KeychainAuthStore(adapter),
    feedStore: new FeedCredentialStore(adapter),
    loadKeyring: async () => nativeFixture(() => { constructions += 1; }),
    fetch: async () => { networkCalls += 1; throw new Error("must not fetch"); },
    httpExecute: async () => { networkCalls += 1; throw new Error("must not dispatch"); },
  });
  process.exitCode = undefined;

  assert.equal(code, 0);
  assert.deepEqual(keychainCalls, []);
  assert.equal(constructions, 0);
  assert.equal(networkCalls, 0);
  const result = JSON.parse(stdout.read());
  assert.equal(result.data.keychainBinding, "loaded");
  assert.equal("binding" in result.data, false);
  assert.equal(result.data.platform, "darwin");
  assert.equal(result.data.architecture, process.arch);
  assert.equal(result.data.nodeApiVersion, process.versions.napi ?? "unavailable");
  assert.equal(result.data.keychainAccess, "not-requested");
  assert.equal(result.data.keychainRecordsRead, 0);
  assert.equal(result.data.keychainRecordsWritten, 0);
  assert.equal(result.data.networkRequests, 0);
});
