import type { JsonValue } from "@toon-format/toon";

import {
  appendJsonPath,
  assertValidUnicode,
  cloneJsonValue,
  createJsonObject,
  isJsonObject,
} from "./json-value.js";

const DEFAULT_SENSITIVE_KEYS = new Set([
  "accesstoken",
  "apikey",
  "authorization",
  "clientsecret",
  "cookie",
  "credential",
  "credentials",
  "csrftoken",
  "idtoken",
  "password",
  "passwd",
  "privatekey",
  "proxyauthorization",
  "refreshtoken",
  "sessioncookie",
  "sessionid",
  "setcookie",
  "token",
  "xapikey",
  "xcsrftoken",
  "xsrftoken",
]);

export const DEFAULT_REDACTION_REPLACEMENT = "[REDACTED]";

export interface SecretRedactionOptions {
  /** Additional exact key names; punctuation and case are ignored. */
  readonly sensitiveKeys?: readonly string[];
  /** Include the conservative built-in credential-key list. Defaults to true. */
  readonly includeDefaults?: boolean;
  readonly replacement?: string;
}

export interface SecretRedactionResult {
  readonly value: JsonValue;
  readonly paths: readonly string[];
}

export function redactSecrets(
  value: JsonValue,
  options: SecretRedactionOptions = {},
  rootPath = "$",
): SecretRedactionResult {
  const replacement = options.replacement ?? DEFAULT_REDACTION_REPLACEMENT;
  assertValidUnicode(replacement, "redaction replacement");
  const sensitiveKeys = createSensitiveKeySet(options);

  const paths: string[] = [];
  return {
    value: redactValue(value, sensitiveKeys, replacement, rootPath, paths),
    paths,
  };
}

/** True when text contains a credential-bearing URL, assignment, header, or flag. */
export function containsCredentialLikeText(
  value: string,
  options: SecretRedactionOptions = {},
): boolean {
  assertValidUnicode(value, "credential scan input");
  const sensitiveKeys = createSensitiveKeySet(options);
  const replacement = options.replacement ?? DEFAULT_REDACTION_REPLACEMENT;
  return redactUrlCredentials(value, sensitiveKeys, replacement).redacted ||
    redactCredentialUrlsInTextInternal(value, sensitiveKeys, replacement).redacted ||
    containsCredentialAssignment(value, sensitiveKeys);
}

/** Redact credential-bearing HTTP(S) URLs embedded anywhere in diagnostic prose. */
export function redactCredentialUrlsInText(
  value: string,
  options: SecretRedactionOptions = {},
): string {
  assertValidUnicode(value, "URL redaction input");
  const sensitiveKeys = createSensitiveKeySet(options);
  const replacement = options.replacement ?? DEFAULT_REDACTION_REPLACEMENT;
  assertValidUnicode(replacement, "redaction replacement");
  return redactCredentialUrlsInTextInternal(value, sensitiveKeys, replacement).value;
}

function createSensitiveKeySet(options: SecretRedactionOptions): Set<string> {
  const sensitiveKeys = new Set<string>();
  if (options.includeDefaults !== false) {
    for (const key of DEFAULT_SENSITIVE_KEYS) sensitiveKeys.add(key);
  }
  for (const key of options.sensitiveKeys ?? []) {
    assertValidUnicode(key, "redaction key");
    sensitiveKeys.add(normalizeSensitiveKey(key));
  }
  return sensitiveKeys;
}

function redactValue(
  value: JsonValue,
  sensitiveKeys: ReadonlySet<string>,
  replacement: string,
  path: string,
  paths: string[],
): JsonValue {
  if (Array.isArray(value)) {
    return value.map((item, index) =>
      redactValue(
        item,
        sensitiveKeys,
        replacement,
        appendJsonPath(path, index),
        paths,
      ),
    );
  }

  if (typeof value === "string") {
    const sanitized = redactUrlCredentials(value, sensitiveKeys, replacement);
    if (sanitized.redacted) {
      paths.push(path);
      return sanitized.value;
    }
    if (
      redactCredentialUrlsInTextInternal(value, sensitiveKeys, replacement).redacted ||
      containsCredentialAssignment(value, sensitiveKeys)
    ) {
      paths.push(path);
      return replacement;
    }
    return value;
  }

  if (!isJsonObject(value)) {
    return cloneJsonValue(value);
  }

  const output = createJsonObject();
  for (const [key, item] of Object.entries(value)) {
    const itemPath = appendJsonPath(path, key);
    if (isSensitiveKey(key, sensitiveKeys)) {
      output[key] = replacement;
      paths.push(itemPath);
    } else {
      output[key] = redactValue(
        item,
        sensitiveKeys,
        replacement,
        itemPath,
        paths,
      );
    }
  }
  return output;
}

function redactCredentialUrlsInTextInternal(
  value: string,
  sensitiveKeys: ReadonlySet<string>,
  replacement: string,
): { readonly value: string; readonly redacted: boolean } {
  const urlPattern = /https?:\/\/[^\s"'<>]+/giu;
  let redacted = false;
  const output = value.replace(urlPattern, (candidate) => {
    const result = redactUrlCredentials(candidate, sensitiveKeys, replacement);
    if (result.redacted) redacted = true;
    return result.value;
  });
  return { value: output, redacted };
}

function containsCredentialAssignment(
  value: string,
  sensitiveKeys: ReadonlySet<string>,
): boolean {
  if (/\bBearer\s+\S+/iu.test(value)) return true;

  const assignmentPattern =
    /(?:^|[^A-Za-z0-9])["']?([A-Za-z][A-Za-z0-9_-]{0,63})["']?\s*[:=]/gu;
  for (const match of value.matchAll(assignmentPattern)) {
    if (isSensitiveKey(match[1] as string, sensitiveKeys)) return true;
  }

  const flagPattern = /(?:^|\s)--([A-Za-z][A-Za-z0-9-]{0,63})(?:=|\s)/gu;
  for (const match of value.matchAll(flagPattern)) {
    if (isSensitiveKey(match[1] as string, sensitiveKeys)) return true;
  }
  return false;
}

function redactUrlCredentials(
  value: string,
  sensitiveKeys: ReadonlySet<string>,
  replacement: string,
  depth = 0,
): { readonly value: string; readonly redacted: boolean } {
  if (depth > 3 || !/^https?:\/\//iu.test(value)) return { value, redacted: false };
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { value, redacted: false };
  }
  let redacted = false;
  if (url.username.length > 0 || url.password.length > 0) {
    url.username = replacement;
    url.password = "";
    redacted = true;
  }
  for (const key of [...url.searchParams.keys()]) {
    if (isSensitiveKey(key, sensitiveKeys)) {
      url.searchParams.set(key, replacement);
      redacted = true;
      continue;
    }
    const values = url.searchParams.getAll(key);
    const sanitizedValues = values.map((entry) =>
      redactUrlCredentials(entry, sensitiveKeys, replacement, depth + 1));
    if (sanitizedValues.some((entry) => entry.redacted)) {
      url.searchParams.delete(key);
      for (const entry of sanitizedValues) url.searchParams.append(key, entry.value);
      redacted = true;
    }
  }
  return { value: redacted ? url.toString() : value, redacted };
}

function isSensitiveKey(key: string, sensitiveKeys: ReadonlySet<string>): boolean {
  const normalized = normalizeSensitiveKey(key);
  return (
    sensitiveKeys.has(normalized) ||
    normalized.startsWith("authorization") ||
    normalized.startsWith("password") ||
    normalized.startsWith("credential") ||
    normalized.endsWith("password") ||
    normalized.endsWith("passwd") ||
    normalized.endsWith("secret") ||
    normalized.endsWith("secretkey") ||
    normalized.endsWith("credential") ||
    normalized.endsWith("privatekey") ||
    normalized.endsWith("apikey") ||
    normalized.endsWith("cookie") ||
    normalized.endsWith("sessionid") ||
    normalized.endsWith("token") ||
    /^(?:access|refresh|identity|id|csrf|xsrf)?token$/u.test(normalized)
  );
}

function normalizeSensitiveKey(key: string): string {
  return key.toLowerCase().replaceAll(/[^a-z0-9]/gu, "");
}
