import { CookieJar, type SerializedCookieJar } from "tough-cookie";

import { AuthError } from "./errors.js";
import { assertDarwin } from "./platform.js";

export const DEFAULT_AUTH_PROFILE = "default";

export const KEYCHAIN_SERVICES = Object.freeze({
  credentials: "cookidoo-axi.credentials.v1",
  cookieSession: "cookidoo-axi.cookie-session.v1",
});

const PROFILE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CREDENTIAL_SCHEMA = "cookidoo-axi.credentials";
const COOKIE_SCHEMA = "cookidoo-axi.cookie-session";
const SECRET_VERSION = 1;

export interface CookidooCredentials {
  readonly username: string;
  readonly password: string;
}

export interface AuthProfileSummary {
  readonly profile: string;
  readonly hasCredentials: boolean;
  readonly hasCookieSession: boolean;
}

export interface DeletedAuthProfile {
  readonly profile: string;
  readonly credentialsDeleted: boolean;
  readonly cookieSessionDeleted: boolean;
}

export interface KeychainAdapter {
  /** Fail without touching Keychain when the current process cannot access it safely. */
  assertAccessAllowed?(): void;
  getSecret(service: string, account: string, signal?: AbortSignal): Promise<string | undefined>;
  setSecret(service: string, account: string, secret: string, signal?: AbortSignal): Promise<void>;
  deleteSecret(service: string, account: string, signal?: AbortSignal): Promise<boolean>;
  listAccounts(service: string, signal?: AbortSignal): Promise<readonly string[]>;
}

interface NativeAsyncEntry {
  getPassword(signal?: AbortSignal | null): Promise<string | null | undefined>;
  setPassword(password: string, signal?: AbortSignal | null): Promise<void>;
  deleteCredential(signal?: AbortSignal | null): Promise<boolean>;
}

interface NativeCredential {
  account: string;
  password: string;
}

export interface KeyringModule {
  readonly AsyncEntry: new (service: string, username: string) => NativeAsyncEntry;
  findCredentialsAsync(
    service: string,
    target?: string | null,
    signal?: AbortSignal | null,
  ): Promise<NativeCredential[]>;
}

export type KeyringModuleLoader = () => Promise<KeyringModule>;

export interface MacOSKeychainAdapterOptions {
  readonly platform?: NodeJS.Platform;
  readonly environment?: NodeJS.ProcessEnv;
  readonly loadKeyring?: KeyringModuleLoader;
}

export interface MacOSKeychainBindingProbe {
  readonly binding: "loaded";
  readonly platform: "darwin";
  readonly architecture: NodeJS.Architecture;
  readonly nodeApiVersion: string;
  readonly requiredExports: readonly [
    "AsyncEntry",
    "AsyncEntry.prototype.getPassword",
    "AsyncEntry.prototype.setPassword",
    "AsyncEntry.prototype.deleteCredential",
    "findCredentialsAsync",
  ];
  readonly keychainAccess: "not-requested";
  readonly keychainRecordsRead: 0;
  readonly keychainRecordsWritten: 0;
  readonly networkRequests: 0;
}

function isMissingNativeEntry(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; name?: unknown };
  return [candidate.code, candidate.name].some((value) => (
    typeof value === "string" && ["NoEntry", "NO_ENTRY", "NotFound", "NOT_FOUND"].includes(value)
  ));
}

async function loadDefaultKeyring(): Promise<KeyringModule> {
  return import("@napi-rs/keyring");
}

/**
 * Load and inspect the native binding without constructing an entry.
 *
 * Merely importing the module and inspecting its exports cannot request a
 * Keychain item authorization. This is suitable for package-install smoke
 * tests because it also performs no network access.
 */
export async function probeMacOSKeychainBinding(
  options: MacOSKeychainAdapterOptions = {},
): Promise<MacOSKeychainBindingProbe> {
  const platform = options.platform ?? process.platform;
  assertDarwin(platform);
  const loadKeyring = options.loadKeyring ?? loadDefaultKeyring;
  try {
    const keyring = await loadKeyring();
    const entryPrototype = (keyring.AsyncEntry as unknown as {
      readonly prototype?: Partial<NativeAsyncEntry>;
    } | undefined)?.prototype;
    if (
      typeof keyring.AsyncEntry !== "function"
      || typeof entryPrototype?.getPassword !== "function"
      || typeof entryPrototype.setPassword !== "function"
      || typeof entryPrototype.deleteCredential !== "function"
      || typeof keyring.findCredentialsAsync !== "function"
    ) {
      throw new Error("invalid native binding shape");
    }
    return {
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
    };
  } catch {
    throw new AuthError({
      code: "KEYCHAIN_UNAVAILABLE",
      message: "The macOS Keychain native binding could not be loaded or is incompatible.",
      suggestion: "Reinstall cookidoo-axi for this macOS architecture and Node.js version.",
    });
  }
}

/**
 * Create a lazy macOS Keychain adapter backed by @napi-rs/keyring.
 *
 * The native module is not loaded until after the platform guard. No shell
 * command is spawned, so secrets never become process arguments.
 */
export function createMacOSKeychainAdapter(
  options: MacOSKeychainAdapterOptions = {},
): KeychainAdapter {
  assertDarwin(options.platform ?? process.platform);
  const environment = options.environment ?? process.env;
  const loadKeyring = options.loadKeyring ?? loadDefaultKeyring;
  let modulePromise: Promise<KeyringModule> | undefined;

  const assertAccessAllowed = (): void => {
    if (environment.CODEX_SANDBOX === "seatbelt") {
      throw new AuthError({
        code: "KEYCHAIN_SANDBOXED",
        message: "macOS Keychain access is unavailable inside the Codex Seatbelt sandbox.",
        suggestion: "Rerun the same cookidoo-axi command outside the sandbox with command-scoped approval; do not re-import credentials.",
      });
    }
  };

  const load = async (): Promise<KeyringModule> => {
    assertAccessAllowed();
    modulePromise ??= loadKeyring();
    try {
      return await modulePromise;
    } catch {
      modulePromise = undefined;
      throw new AuthError({
        code: "KEYCHAIN_UNAVAILABLE",
        message: "macOS Keychain could not be opened.",
        suggestion: "Allow Keychain access for cookidoo-axi and retry.",
      });
    }
  };

  return {
    assertAccessAllowed,

    async getSecret(service, account, signal) {
      const keyring = await load();
      try {
        const value = await new keyring.AsyncEntry(service, account).getPassword(signal);
        return value === null ? undefined : value;
      } catch (error) {
        if (isMissingNativeEntry(error)) return undefined;
        throw new AuthError({
          code: "KEYCHAIN_READ_FAILED",
          message: "A cookidoo-axi secret could not be read from Keychain.",
          suggestion: "Check Keychain access and the selected auth profile.",
        });
      }
    },

    async setSecret(service, account, secret, signal) {
      const keyring = await load();
      try {
        await new keyring.AsyncEntry(service, account).setPassword(secret, signal);
      } catch {
        throw new AuthError({
          code: "KEYCHAIN_WRITE_FAILED",
          message: "A cookidoo-axi secret could not be saved to Keychain.",
          suggestion: "Unlock Keychain, allow access, and retry.",
        });
      }
    },

    async deleteSecret(service, account, signal) {
      const keyring = await load();
      try {
        return await new keyring.AsyncEntry(service, account).deleteCredential(signal);
      } catch (error) {
        if (isMissingNativeEntry(error)) return false;
        throw new AuthError({
          code: "KEYCHAIN_DELETE_FAILED",
          message: "A cookidoo-axi secret could not be removed from Keychain.",
          suggestion: "Check Keychain access and retry.",
        });
      }
    },

    async listAccounts(service, signal) {
      const keyring = await load();
      try {
        const credentials = await keyring.findCredentialsAsync(service, null, signal);
        const accounts = credentials.map(({ account }) => account);
        for (const credential of credentials) credential.password = "";
        return [...new Set(accounts)].sort();
      } catch {
        throw new AuthError({
          code: "KEYCHAIN_READ_FAILED",
          message: "cookidoo-axi auth profiles could not be listed from Keychain.",
          suggestion: "Check Keychain access and retry.",
        });
      }
    },
  };
}

export function normalizeAuthProfile(profile: string = DEFAULT_AUTH_PROFILE): string {
  if (!PROFILE_PATTERN.test(profile)) {
    throw new AuthError({
      code: "INVALID_PROFILE",
      message: "The auth profile name is invalid.",
      suggestion: "Use 1-64 letters, digits, dots, underscores, or hyphens, starting with a letter or digit.",
    });
  }
  return profile;
}

function validateMarketCredentials(credentials: CookidooCredentials): CookidooCredentials {
  const username = credentials.username.trim();
  if (
    username.length === 0
    || username.length > 320
    || /[\0\r\n]/u.test(username)
    || credentials.password.length === 0
    || credentials.password.length > 16_384
  ) {
    throw new AuthError({
      code: "ENV_CREDENTIALS_MISSING",
      message: "Cookidoo credentials are missing or invalid.",
      suggestion: "Provide a non-empty username and password through the approved credential import path.",
    });
  }
  return { username, password: credentials.password };
}

function parseSecretObject(secret: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(secret);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // The sanitized error below intentionally omits the native/parser message.
  }
  throw new AuthError({
    code: "KEYCHAIN_DATA_INVALID",
    message: "Stored cookidoo-axi authentication data is invalid.",
    suggestion: "Remove the affected auth profile and import credentials again.",
  });
}

export class KeychainAuthStore {
  readonly adapter: KeychainAdapter;

  constructor(adapter: KeychainAdapter = createMacOSKeychainAdapter()) {
    this.adapter = adapter;
  }

  /** Fail before acquiring credential material when Keychain is sandbox-isolated. */
  assertAccessAllowed(): void {
    this.adapter.assertAccessAllowed?.();
  }

  /** Validate and normalize market credentials without reading or writing Keychain. */
  validateCredentials(credentials: CookidooCredentials): CookidooCredentials {
    return validateMarketCredentials(credentials);
  }

  async saveCredentials(
    profile: string,
    credentials: CookidooCredentials,
    signal?: AbortSignal,
  ): Promise<void> {
    const account = normalizeAuthProfile(profile);
    const validated = this.validateCredentials(credentials);
    const secret = JSON.stringify({
      schema: CREDENTIAL_SCHEMA,
      version: SECRET_VERSION,
      username: validated.username,
      password: validated.password,
    });
    await this.adapter.setSecret(KEYCHAIN_SERVICES.credentials, account, secret, signal);
  }

  async loadCredentials(
    profile: string,
    signal?: AbortSignal,
  ): Promise<CookidooCredentials | undefined> {
    const account = normalizeAuthProfile(profile);
    const secret = await this.adapter.getSecret(KEYCHAIN_SERVICES.credentials, account, signal);
    if (secret === undefined) return undefined;
    const parsed = parseSecretObject(secret);
    if (
      parsed.schema !== CREDENTIAL_SCHEMA
      || parsed.version !== SECRET_VERSION
      || typeof parsed.username !== "string"
      || typeof parsed.password !== "string"
    ) {
      throw new AuthError({
        code: "KEYCHAIN_DATA_INVALID",
        message: "Stored cookidoo-axi credentials are invalid.",
        suggestion: "Remove the affected auth profile and import credentials again.",
      });
    }
    return this.validateCredentials({ username: parsed.username, password: parsed.password });
  }

  async deleteCredentials(profile: string, signal?: AbortSignal): Promise<boolean> {
    const account = normalizeAuthProfile(profile);
    return this.adapter.deleteSecret(KEYCHAIN_SERVICES.credentials, account, signal);
  }

  async saveCookieJar(
    profile: string,
    jar: CookieJar,
    signal?: AbortSignal,
  ): Promise<void> {
    const account = normalizeAuthProfile(profile);
    let serialized: SerializedCookieJar;
    try {
      serialized = await jar.serialize();
    } catch {
      throw new AuthError({
        code: "KEYCHAIN_DATA_INVALID",
        message: "The Cookidoo cookie session could not be serialized.",
        suggestion: "Create a fresh authenticated session and retry.",
      });
    }
    const secret = JSON.stringify({
      schema: COOKIE_SCHEMA,
      version: SECRET_VERSION,
      jar: serialized,
    });
    await this.adapter.setSecret(KEYCHAIN_SERVICES.cookieSession, account, secret, signal);
  }

  async loadCookieJar(profile: string, signal?: AbortSignal): Promise<CookieJar | undefined> {
    const account = normalizeAuthProfile(profile);
    const secret = await this.adapter.getSecret(KEYCHAIN_SERVICES.cookieSession, account, signal);
    if (secret === undefined) return undefined;
    const parsed = parseSecretObject(secret);
    const jar = parsed.jar;
    if (
      parsed.schema !== COOKIE_SCHEMA
      || parsed.version !== SECRET_VERSION
      || typeof jar !== "object"
      || jar === null
      || !Array.isArray((jar as { cookies?: unknown }).cookies)
    ) {
      throw new AuthError({
        code: "KEYCHAIN_DATA_INVALID",
        message: "Stored cookidoo-axi cookie-session data is invalid.",
        suggestion: "Remove the affected cookie session and log in again.",
      });
    }
    try {
      return await CookieJar.deserialize(jar);
    } catch {
      throw new AuthError({
        code: "KEYCHAIN_DATA_INVALID",
        message: "Stored cookidoo-axi cookie-session data is invalid.",
        suggestion: "Remove the affected cookie session and log in again.",
      });
    }
  }

  async deleteCookieJar(profile: string, signal?: AbortSignal): Promise<boolean> {
    const account = normalizeAuthProfile(profile);
    return this.adapter.deleteSecret(KEYCHAIN_SERVICES.cookieSession, account, signal);
  }

  async listProfiles(signal?: AbortSignal): Promise<readonly AuthProfileSummary[]> {
    const [credentialAccounts, sessionAccounts] = await Promise.all([
      this.adapter.listAccounts(KEYCHAIN_SERVICES.credentials, signal),
      this.adapter.listAccounts(KEYCHAIN_SERVICES.cookieSession, signal),
    ]);
    const credentials = new Set(credentialAccounts.filter((profile) => PROFILE_PATTERN.test(profile)));
    const sessions = new Set(sessionAccounts.filter((profile) => PROFILE_PATTERN.test(profile)));
    const profiles = [...new Set([...credentials, ...sessions])].sort();
    return profiles.map((profile) => ({
      profile,
      hasCredentials: credentials.has(profile),
      hasCookieSession: sessions.has(profile),
    }));
  }

  /** Check only one selected profile; avoids decrypting unrelated Keychain records. */
  async profileStatus(profile: string, signal?: AbortSignal): Promise<AuthProfileSummary> {
    const account = normalizeAuthProfile(profile);
    const [credentials, session] = await Promise.all([
      this.adapter.getSecret(KEYCHAIN_SERVICES.credentials, account, signal),
      this.adapter.getSecret(KEYCHAIN_SERVICES.cookieSession, account, signal),
    ]);
    return {
      profile: account,
      hasCredentials: credentials !== undefined,
      hasCookieSession: session !== undefined,
    };
  }

  async deleteProfile(profile: string, signal?: AbortSignal): Promise<DeletedAuthProfile> {
    const account = normalizeAuthProfile(profile);
    // A cached session is the least recoverable, account-bound record. Remove it
    // first and fail closed: if that deletion fails, retain credentials so the
    // user can inspect or recover the profile without an orphaned session.
    const cookieSessionDeleted = await this.adapter.deleteSecret(
      KEYCHAIN_SERVICES.cookieSession,
      account,
      signal,
    );
    const credentialsDeleted = await this.adapter.deleteSecret(
      KEYCHAIN_SERVICES.credentials,
      account,
      signal,
    );
    return { profile: account, credentialsDeleted, cookieSessionDeleted };
  }
}
