import { constants } from "node:fs";
import { open } from "node:fs/promises";

import { AuthError } from "./errors.js";
import {
  DEFAULT_AUTH_PROFILE,
  type CookidooCredentials,
  normalizeAuthProfile,
} from "./keychain.js";

const DEFAULT_MAX_ENV_BYTES = 64 * 1024;
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const DEFAULT_ENV_CREDENTIAL_NAMES = Object.freeze({
  username: ["COOKIDOO_USERNAME", "COOKIDOO_EMAIL"] as readonly string[],
  password: ["COOKIDOO_PASSWORD"] as readonly string[],
});

export interface EnvCredentialNames {
  readonly username: readonly string[];
  readonly password: readonly string[];
}

export interface CredentialWriter {
  /** Runs before the credential source is opened and must not access secret material. */
  assertAccessAllowed?(): void;
  validateCredentials(credentials: CookidooCredentials): CookidooCredentials;
  saveCredentials(
    profile: string,
    credentials: CookidooCredentials,
    signal?: AbortSignal,
  ): Promise<void>;
}

export type EnvTextReader = (path: string, maxBytes: number) => Promise<string>;

export interface EnvCredentialImportOptions {
  readonly path: string;
  readonly store: CredentialWriter;
  readonly profile?: string;
  readonly names?: EnvCredentialNames;
  readonly maxBytes?: number;
  readonly signal?: AbortSignal;
  readonly readText?: EnvTextReader;
  /** Runs after complete parsing and credential validation, but before the Keychain write. */
  readonly beforeSave?: (result: EnvCredentialImportResult) => Promise<void>;
}

export interface EnvCredentialImportResult {
  readonly profile: string;
  readonly usernameKey: string;
  readonly passwordKey: string;
}

function invalidEnvFile(line?: number): AuthError {
  return new AuthError({
    code: "ENV_FILE_INVALID",
    message: line === undefined
      ? "The credential environment file is invalid."
      : `The credential environment file is invalid at line ${line}.`,
    suggestion: "Use plain KEY=value entries without variable expansion or duplicate keys.",
  });
}

function decodeDoubleQuoted(value: string, line: number): { value: string; consumed: number } {
  let decoded = "";
  for (let index = 1; index < value.length; index += 1) {
    const character = value[index];
    if (character === "\"") return { value: decoded, consumed: index + 1 };
    if (character !== "\\") {
      decoded += character;
      continue;
    }
    index += 1;
    const escaped = value[index];
    if (escaped === undefined) throw invalidEnvFile(line);
    switch (escaped) {
      case "n":
        decoded += "\n";
        break;
      case "r":
        decoded += "\r";
        break;
      case "t":
        decoded += "\t";
        break;
      case "\"":
        decoded += "\"";
        break;
      case "\\":
        decoded += "\\";
        break;
      default:
        decoded += `\\${escaped}`;
        break;
    }
  }
  throw invalidEnvFile(line);
}

function decodeSingleQuoted(value: string, line: number): { value: string; consumed: number } {
  const closing = value.indexOf("'", 1);
  if (closing === -1) throw invalidEnvFile(line);
  return { value: value.slice(1, closing), consumed: closing + 1 };
}

function decodeUnquoted(value: string): string {
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "#" && (index === 0 || /\s/u.test(value[index - 1] ?? ""))) {
      return value.slice(0, index).trimEnd();
    }
  }
  return value.trimEnd();
}

function decodeValue(raw: string, line: number): string {
  const value = raw.trimStart();
  if (value.startsWith("\"") || value.startsWith("'")) {
    const decoded = value.startsWith("\"")
      ? decodeDoubleQuoted(value, line)
      : decodeSingleQuoted(value, line);
    const trailing = value.slice(decoded.consumed).trim();
    if (trailing.length > 0 && !trailing.startsWith("#")) throw invalidEnvFile(line);
    return decoded.value;
  }
  return decodeUnquoted(value);
}

function parseEnvText(text: string): ReadonlyMap<string, string> {
  if (text.includes("\0")) throw invalidEnvFile();
  const entries = new Map<string, string>();
  const lines = text.replace(/^\uFEFF/u, "").split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    let line = lines[index]?.trimStart() ?? "";
    if (line.length === 0 || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice("export ".length).trimStart();
    const equals = line.indexOf("=");
    if (equals <= 0) throw invalidEnvFile(lineNumber);
    const key = line.slice(0, equals).trim();
    if (!ENV_KEY_PATTERN.test(key) || entries.has(key)) throw invalidEnvFile(lineNumber);
    entries.set(key, decodeValue(line.slice(equals + 1), lineNumber));
  }
  return entries;
}

async function readEnvTextSafely(path: string, maxBytes: number): Promise<string> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw new AuthError({
      code: "ENV_FILE_UNSAFE",
      message: "The credential environment file could not be opened safely.",
      suggestion: "Use a regular, non-symlink file readable only from the local machine.",
    });
  }

  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > maxBytes || (metadata.mode & 0o077) !== 0) {
      throw new AuthError({
        code: "ENV_FILE_UNSAFE",
        message: "The credential environment file must be bounded, regular, and readable only by its owner.",
        suggestion: `Use a regular file no larger than ${maxBytes} bytes with mode 0600.`,
      });
    }
    const bytes = await handle.readFile();
    try {
      if (bytes.byteLength > maxBytes) {
        throw new AuthError({
          code: "ENV_FILE_UNSAFE",
          message: "The credential environment file exceeds the size limit.",
          suggestion: `Use a file no larger than ${maxBytes} bytes.`,
        });
      }
      try {
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw invalidEnvFile();
      }
    } finally {
      bytes.fill(0);
    }
  } finally {
    await handle.close();
  }
}

function selectCredential(
  entries: ReadonlyMap<string, string>,
  candidates: readonly string[],
): { key: string; value: string } | undefined {
  const matches = candidates.filter((key) => entries.has(key));
  if (matches.length > 1) throw invalidEnvFile();
  const key = matches[0];
  if (key === undefined) return undefined;
  return { key, value: entries.get(key) ?? "" };
}

/**
 * Parse a bounded .env file without executing a shell or expanding variables,
 * then write the selected credentials directly to the profile's Keychain
 * secret. The function has no logging hooks and returns key names only.
 */
export async function importCredentialsFromEnvFile(
  options: EnvCredentialImportOptions,
): Promise<EnvCredentialImportResult> {
  const profile = normalizeAuthProfile(options.profile ?? DEFAULT_AUTH_PROFILE);
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_ENV_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1024 * 1024) {
    throw new AuthError({
      code: "ENV_FILE_UNSAFE",
      message: "The credential environment-file size limit is invalid.",
      suggestion: "Use a limit between 1 byte and 1 MiB.",
    });
  }
  const names = options.names ?? DEFAULT_ENV_CREDENTIAL_NAMES;
  if (names.username.length === 0 || names.password.length === 0) {
    throw new AuthError({
      code: "ENV_CREDENTIALS_MISSING",
      message: "Credential environment-variable names are missing.",
      suggestion: "Configure at least one username key and one password key.",
    });
  }
  for (const name of [...names.username, ...names.password]) {
    if (!ENV_KEY_PATTERN.test(name)) throw invalidEnvFile();
  }

  options.store.assertAccessAllowed?.();
  const text = await (options.readText ?? readEnvTextSafely)(options.path, maxBytes);
  const entries = parseEnvText(text);
  const username = selectCredential(entries, names.username);
  const password = selectCredential(entries, names.password);
  if (username === undefined || password === undefined || username.value.length === 0 || password.value.length === 0) {
    throw new AuthError({
      code: "ENV_CREDENTIALS_MISSING",
      message: "The credential environment file does not contain both required credentials.",
      suggestion: "Add exactly one configured username key and one configured password key.",
    });
  }

  const credentials = options.store.validateCredentials({
    username: username.value,
    password: password.value,
  });
  const result = { profile, usernameKey: username.key, passwordKey: password.key };
  await options.beforeSave?.(result);
  await options.store.saveCredentials(
    profile,
    credentials,
    options.signal,
  );
  return result;
}
