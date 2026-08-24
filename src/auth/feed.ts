import { AuthError } from "./errors.js";
import {
  createMacOSKeychainAdapter,
  normalizeAuthProfile,
  type CookidooCredentials,
  type KeychainAdapter,
} from "./keychain.js";

export const FEED_KEYCHAIN_SERVICE = "cookidoo-axi.feed-credentials.v1";

const FEED_SCHEMA = "cookidoo-axi.feed-credentials";
const FEED_VERSION = 1;

function validateFeedCredentials(credentials: CookidooCredentials): CookidooCredentials {
  const username = credentials.username.trim();
  if (
    username.length === 0 || username.length > 1024 || /[\0\r\n]/u.test(username) ||
    credentials.password.length === 0 || credentials.password.length > 16_384
  ) {
    throw new AuthError({
      code: "ENV_CREDENTIALS_MISSING",
      message: "Collection-feed Basic credentials are missing or invalid.",
      suggestion: "Import the independently supplied feed username and password into Keychain.",
    });
  }
  return { username, password: credentials.password };
}

/** Separate Keychain namespace for the feed specification's undocumented Basic credentials. */
export class FeedCredentialStore {
  constructor(readonly adapter: KeychainAdapter = createMacOSKeychainAdapter()) {}

  /** Fail before acquiring credential material when Keychain is sandbox-isolated. */
  assertAccessAllowed(): void {
    this.adapter.assertAccessAllowed?.();
  }

  /** Validate and normalize feed credentials without reading or writing Keychain. */
  validateCredentials(credentials: CookidooCredentials): CookidooCredentials {
    return validateFeedCredentials(credentials);
  }

  async saveCredentials(
    profile: string,
    credentials: CookidooCredentials,
    signal?: AbortSignal,
  ): Promise<void> {
    const account = normalizeAuthProfile(profile);
    const value = this.validateCredentials(credentials);
    await this.adapter.setSecret(FEED_KEYCHAIN_SERVICE, account, JSON.stringify({
      schema: FEED_SCHEMA,
      version: FEED_VERSION,
      username: value.username,
      password: value.password,
    }), signal);
  }

  async loadCredentials(
    profile: string,
    signal?: AbortSignal,
  ): Promise<CookidooCredentials | undefined> {
    const account = normalizeAuthProfile(profile);
    const secret = await this.adapter.getSecret(FEED_KEYCHAIN_SERVICE, account, signal);
    if (secret === undefined) return undefined;
    try {
      const parsed: unknown = JSON.parse(secret);
      if (
        typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) &&
        (parsed as Record<string, unknown>).schema === FEED_SCHEMA &&
        (parsed as Record<string, unknown>).version === FEED_VERSION &&
        typeof (parsed as Record<string, unknown>).username === "string" &&
        typeof (parsed as Record<string, unknown>).password === "string"
      ) {
        return this.validateCredentials({
          username: (parsed as Record<string, unknown>).username as string,
          password: (parsed as Record<string, unknown>).password as string,
        });
      }
    } catch {
      // Emit the fixed diagnostic below; never include the stored value.
    }
    throw new AuthError({
      code: "KEYCHAIN_DATA_INVALID",
      message: "Stored collection-feed credentials are invalid.",
      suggestion: "Remove the profile and import the feed credentials again.",
    });
  }

  async hasCredentials(profile: string, signal?: AbortSignal): Promise<boolean> {
    return (await this.loadCredentials(profile, signal)) !== undefined;
  }

  async deleteCredentials(profile: string, signal?: AbortSignal): Promise<boolean> {
    return this.adapter.deleteSecret(
      FEED_KEYCHAIN_SERVICE,
      normalizeAuthProfile(profile),
      signal,
    );
  }
}
