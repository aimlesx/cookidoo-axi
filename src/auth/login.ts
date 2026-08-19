import makeFetchCookie from "fetch-cookie";
import { CookieJar } from "tough-cookie";

import { AuthError, isAuthError } from "./errors.js";
import {
  type CookidooCredentials,
  type KeychainAuthStore,
  normalizeAuthProfile,
} from "./keychain.js";

const DEFAULT_GATEWAY = "https://cookidoo.pl";
const DEFAULT_IDENTITY_HOSTS = [
  "ciam.prod.cookidoo.vorwerk-digital.com",
  "eu.login.vorwerk.com",
] as const;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_REDIRECTS = 20;
const DEFAULT_MAX_LOGIN_PAGE_BYTES = 1024 * 1024;
const LANGUAGE_PATTERN = /^[a-z]{2}(?:-[A-Z]{2})?$/;

export type FetchImplementation = typeof globalThis.fetch;

export type CookieFetch = (
  input: string | URL | Request,
  init?: RequestInit & { readonly maxRedirect?: number },
) => Promise<Response>;

export interface ProtectedReadVerificationContext {
  readonly fetch: CookieFetch;
  readonly signal: AbortSignal;
  readonly gatewayOrigin: string;
}

/** Return true only after an authenticated, protected read has succeeded. */
export type ProtectedReadVerifier = (
  context: ProtectedReadVerificationContext,
) => Promise<boolean>;

export interface BrowserLoginOptions {
  readonly credentials: CookidooCredentials;
  readonly baseUrl?: string | URL;
  readonly language?: string;
  readonly redirectAfterLogin?: string;
  readonly expectedLoginHosts?: readonly string[];
  readonly verifyProtectedRead?: ProtectedReadVerifier;
  readonly jar?: CookieJar;
  readonly fetch?: FetchImplementation;
  readonly timeoutMs?: number;
  readonly maxRedirects?: number;
  readonly maxLoginPageBytes?: number;
  readonly signal?: AbortSignal;
}

export interface BrowserLoginResult {
  readonly jar: CookieJar;
  readonly gatewayOrigin: string;
  readonly verification: "verified" | "not-requested";
}

export interface AuthSessionStore {
  loadCredentials(profile: string, signal?: AbortSignal): Promise<CookidooCredentials | undefined>;
  saveCookieJar(profile: string, jar: CookieJar, signal?: AbortSignal): Promise<void>;
  loadCookieJar(profile: string, signal?: AbortSignal): Promise<CookieJar | undefined>;
}

export interface StoredProfileLoginOptions
  extends Omit<BrowserLoginOptions, "credentials" | "jar" | "verifyProtectedRead"> {
  readonly profile: string;
  readonly store: AuthSessionStore;
  readonly verifyProtectedRead: ProtectedReadVerifier;
}

export interface StoredProfileLoginResult {
  readonly profile: string;
  readonly gatewayOrigin: string;
  readonly verification: "verified";
}

export interface LoadStoredSessionOptions {
  readonly profile: string;
  readonly store: Pick<KeychainAuthStore, "loadCookieJar">;
  readonly fetch?: FetchImplementation;
  readonly signal?: AbortSignal;
}

export interface StoredSession {
  readonly profile: string;
  readonly jar: CookieJar;
  readonly fetch: CookieFetch;
}

interface ParsedLoginForm {
  readonly action: string;
  readonly method: "post";
  readonly requestId: string;
  readonly requestIdName: string;
  readonly usernameName: string;
  readonly passwordName: string;
  readonly controls: ReadonlyMap<string, string>;
}

function createSecureCookieJar(): CookieJar {
  return new CookieJar(undefined, {
    rejectPublicSuffixes: true,
    looseMode: false,
    prefixSecurity: "strict",
    allowSpecialUseDomain: false,
    allowSecureOnLocal: false,
  });
}

export function createCookieFetch(
  jar: CookieJar,
  fetchImplementation: FetchImplementation = globalThis.fetch,
): CookieFetch {
  return makeFetchCookie(fetchImplementation, jar, false) as unknown as CookieFetch;
}

function decodeHtmlEntities(value: string): string {
  const named: Readonly<Record<string, string>> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    quot: "\"",
  };
  return value.replace(/&(?:#(\d+)|#x([0-9A-Fa-f]+)|([A-Za-z]+));/gu, (match, decimal, hexadecimal, name) => {
    let codePoint: number | undefined;
    if (typeof decimal === "string") codePoint = Number.parseInt(decimal, 10);
    if (typeof hexadecimal === "string") codePoint = Number.parseInt(hexadecimal, 16);
    if (codePoint !== undefined) {
      if (
        Number.isSafeInteger(codePoint)
        && codePoint >= 0
        && codePoint <= 0x10ffff
        && !(codePoint >= 0xd800 && codePoint <= 0xdfff)
      ) {
        return String.fromCodePoint(codePoint);
      }
      return "\uFFFD";
    }
    if (typeof name === "string") return named[name.toLowerCase()] ?? match;
    return match;
  });
}

function parseAttributes(source: string): ReadonlyMap<string, string> {
  const attributes = new Map<string, string>();
  const pattern = /([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gu;
  for (const match of source.matchAll(pattern)) {
    const rawName = match[1];
    if (rawName === undefined) continue;
    const name = rawName.toLowerCase();
    const rawValue = match[2] ?? match[3] ?? match[4] ?? "";
    attributes.set(name, decodeHtmlEntities(rawValue));
  }
  return attributes;
}

function extractLoginForm(html: string): ParsedLoginForm {
  const candidates: ParsedLoginForm[] = [];
  const formPattern = /<form\b([^>]*)>([\s\S]*?)<\/form\s*>/giu;
  for (const formMatch of html.matchAll(formPattern)) {
    const formAttributes = parseAttributes(formMatch[1] ?? "");
    const body = formMatch[2] ?? "";
    const method = (formAttributes.get("method") ?? "post").toLowerCase();
    if (method !== "post") continue;

    const controls = new Map<string, string>();
    let requestIdName: string | undefined;
    let requestId: string | undefined;
    let usernameName: string | undefined;
    let passwordName: string | undefined;
    for (const inputMatch of body.matchAll(/<input\b([^>]*)>/giu)) {
      const attributes = parseAttributes(inputMatch[1] ?? "");
      if (attributes.has("disabled")) continue;
      const name = attributes.get("name");
      if (name === undefined || name.length === 0) continue;
      const normalizedName = name.toLowerCase();
      const type = (attributes.get("type") ?? "text").toLowerCase();
      const value = attributes.get("value") ?? "";
      if (normalizedName === "requestid") {
        if (requestId !== undefined && requestId !== value) {
          throw new AuthError({
            code: "LOGIN_FORM_INVALID",
            message: "The identity-provider login form contains ambiguous request state.",
            suggestion: "Start a fresh isolated login attempt.",
          });
        }
        requestIdName = name;
        requestId = value;
      }
      if (normalizedName === "username") usernameName = name;
      if (normalizedName === "password") passwordName = name;

      const isCheckControl = type === "checkbox" || type === "radio";
      const excludedType = ["button", "file", "image", "reset", "submit"].includes(type);
      if (!excludedType && (!isCheckControl || attributes.has("checked"))) controls.set(name, value);
    }

    const action = formAttributes.get("action") ?? "";
    if ((requestId === undefined || requestId.length === 0) && action.length > 0) {
      try {
        const actionUrl = new URL(action, "https://invalid.local");
        const actionRequestId = actionUrl.searchParams.get("requestId");
        if (actionRequestId !== null && actionRequestId.length > 0) {
          requestIdName = "requestId";
          requestId = actionRequestId;
        }
      } catch {
        // URL validity is reported later without exposing the provider value.
      }
    }
    if (
      requestId !== undefined
      && requestId.length > 0
      && requestIdName !== undefined
      && usernameName !== undefined
      && passwordName !== undefined
    ) {
      candidates.push({
        action,
        method: "post",
        requestId,
        requestIdName,
        usernameName,
        passwordName,
        controls,
      });
    }
  }

  if (candidates.length !== 1) {
    throw new AuthError({
      code: "LOGIN_FORM_INVALID",
      message: "A unique Cookidoo identity-provider login form was not found.",
      suggestion: "Start a fresh login attempt; the provider flow may have changed.",
    });
  }
  const candidate = candidates[0];
  if (candidate === undefined) {
    throw new AuthError({
      code: "LOGIN_FORM_INVALID",
      message: "The Cookidoo identity-provider login form was not found.",
      suggestion: "Start a fresh login attempt; the provider flow may have changed.",
    });
  }
  return candidate;
}

function normalizeExpectedHosts(hosts: readonly string[]): ReadonlySet<string> {
  const normalized = new Set<string>();
  for (const value of hosts) {
    const hostname = value.trim().toLowerCase().replace(/\.$/u, "");
    if (
      hostname.length === 0
      || hostname.includes("://")
      || /[\s/@?#]/u.test(hostname)
    ) {
      throw new AuthError({
        code: "LOGIN_INPUT_INVALID",
        message: "An expected login host is invalid.",
        suggestion: "Provide exact hostnames without schemes, paths, or wildcards.",
      });
    }
    normalized.add(hostname);
  }
  return normalized;
}

function validateFormAction(
  action: string,
  pageUrl: URL,
  expectedHosts: ReadonlySet<string>,
): URL {
  let actionUrl: URL;
  try {
    actionUrl = new URL(action || pageUrl.href, pageUrl);
  } catch {
    throw new AuthError({
      code: "LOGIN_FORM_INVALID",
      message: "The identity-provider login form action is invalid.",
      suggestion: "Start a fresh isolated login attempt.",
    });
  }
  const hostname = actionUrl.hostname.toLowerCase().replace(/\.$/u, "");
  if (
    actionUrl.protocol !== "https:"
    || (actionUrl.port.length > 0 && actionUrl.port !== "443")
    || actionUrl.username.length > 0
    || actionUrl.password.length > 0
    || !expectedHosts.has(hostname)
  ) {
    throw new AuthError({
      code: "LOGIN_HOST_REJECTED",
      message: "The identity-provider login form action uses an unexpected host.",
      suggestion: "Do not submit credentials; verify the configured first-party login hosts.",
    });
  }
  return actionUrl;
}

function resolveSafeCompletionRedirect(location: string, currentUrl: URL): URL {
  let redirect: URL;
  try {
    redirect = new URL(location, currentUrl);
  } catch {
    throw new AuthError({
      code: "LOGIN_SUBMISSION_FAILED",
      message: "The identity provider returned an invalid completion redirect.",
      suggestion: "Start a fresh isolated login attempt.",
    });
  }
  if (
    redirect.protocol !== "https:"
    || (redirect.port.length > 0 && redirect.port !== "443")
    || redirect.username.length > 0
    || redirect.password.length > 0
  ) {
    throw new AuthError({
      code: "LOGIN_HOST_REJECTED",
      message: "The identity provider returned an unsafe completion redirect.",
      suggestion: "Stop without retrying the credential submission.",
    });
  }
  return redirect;
}

function resolveAllowlistedRedirect(
  location: string,
  currentUrl: URL,
  expectedHosts: ReadonlySet<string>,
): URL {
  const redirect = resolveSafeCompletionRedirect(location, currentUrl);
  const hostname = redirect.hostname.toLowerCase().replace(/\.$/u, "");
  if (!expectedHosts.has(hostname)) {
    throw new AuthError({
      code: "LOGIN_HOST_REJECTED",
      message: "The identity-provider redirect uses an unexpected host.",
      suggestion: "Stop without following the redirect or replaying credentials.",
    });
  }
  return redirect;
}

async function openLoginPage(
  fetchWithCookies: CookieFetch,
  startUrl: URL,
  expectedHosts: ReadonlySet<string>,
  signal: AbortSignal,
  maximumRedirects: number,
): Promise<Response> {
  let currentUrl = startUrl;
  for (let redirectCount = 0; redirectCount <= maximumRedirects; redirectCount += 1) {
    const response = await fetchWithCookies(currentUrl, {
      method: "GET",
      redirect: "manual",
      signal,
      headers: { accept: "text/html,application/xhtml+xml" },
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    if (location === null || redirectCount === maximumRedirects) {
      await response.body?.cancel();
      throw new AuthError({
        code: "LOGIN_PAGE_FAILED",
        message: "The Cookidoo login redirect chain is incomplete or too long.",
        suggestion: "Start a fresh isolated login attempt.",
      });
    }
    const responseUrl = response.url.length > 0 ? new URL(response.url) : currentUrl;
    currentUrl = resolveAllowlistedRedirect(location, responseUrl, expectedHosts);
    await response.body?.cancel();
  }
  throw new AuthError({
    code: "LOGIN_PAGE_FAILED",
    message: "The Cookidoo login redirect limit was reached.",
    suggestion: "Start a fresh isolated login attempt.",
  });
}

async function submitLoginForm(
  fetchWithCookies: CookieFetch,
  actionUrl: URL,
  loginPageUrl: URL,
  body: URLSearchParams,
  signal: AbortSignal,
  maximumRedirects: number,
  expectedHosts: ReadonlySet<string>,
): Promise<Response> {
  let currentUrl = actionUrl;
  let currentMethod: "POST" | "GET" = "POST";
  let response = await fetchWithCookies(currentUrl, {
    method: "POST",
    redirect: "manual",
    signal,
    headers: {
      accept: "text/html,application/xhtml+xml,application/json",
      "content-type": "application/x-www-form-urlencoded",
      origin: loginPageUrl.origin,
      referer: loginPageUrl.href,
    },
    body,
  });

  for (let redirectCount = 0; ; redirectCount += 1) {
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    if (location === null) return response;
    if (redirectCount >= maximumRedirects) break;
    if ((response.status === 307 || response.status === 308) && currentMethod === "POST") {
      throw new AuthError({
        code: "LOGIN_SUBMISSION_FAILED",
        message: "The identity provider requested an unsafe credential replay during redirect.",
        suggestion: "Stop and verify that the first-party login flow has not changed.",
      });
    }
    const responseUrl = response.url.length > 0 ? new URL(response.url) : currentUrl;
    currentUrl = resolveAllowlistedRedirect(location, responseUrl, expectedHosts);
    currentMethod = "GET";
    response = await fetchWithCookies(currentUrl, {
      method: "GET",
      redirect: "manual",
      signal,
      headers: { accept: "text/html,application/xhtml+xml,application/json" },
    });
  }

  throw new AuthError({
    code: "LOGIN_SUBMISSION_FAILED",
    message: "The identity-provider completion redirect limit was reached.",
    suggestion: "Start a fresh isolated login attempt.",
  });
}

function boundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new AuthError({
      code: "LOGIN_INPUT_INVALID",
      message: `The ${label} is invalid.`,
      suggestion: `Use an integer from ${minimum} through ${maximum}.`,
    });
  }
  return value;
}

function createTrajectorySignal(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; timedOut: () => boolean } {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return {
    signal: signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal]),
    timedOut: () => timeoutSignal.aborted && !(signal?.aborted ?? false),
  };
}

async function readBoundedText(response: Response, maximumBytes: number): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const parsed = Number.parseInt(contentLength, 10);
    if (Number.isFinite(parsed) && parsed > maximumBytes) {
      throw new AuthError({
        code: "LOGIN_FORM_INVALID",
        message: "The identity-provider login page exceeds the safety limit.",
        suggestion: "Stop and verify that the provider flow has not changed.",
      });
    }
  }
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      bytes += result.value.byteLength;
      if (bytes > maximumBytes) {
        await reader.cancel();
        throw new AuthError({
          code: "LOGIN_FORM_INVALID",
          message: "The identity-provider login page exceeds the safety limit.",
          suggestion: "Stop and verify that the provider flow has not changed.",
        });
      }
      text += decoder.decode(result.value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } catch (error) {
    if (isAuthError(error)) throw error;
    throw new AuthError({
      code: "LOGIN_FORM_INVALID",
      message: "The identity-provider login page could not be decoded safely.",
      suggestion: "Start a fresh login attempt; the provider flow may have changed.",
    });
  } finally {
    reader.releaseLock();
  }
}

function resolveGateway(baseUrl: string | URL): URL {
  let gateway: URL;
  try {
    gateway = new URL(baseUrl);
  } catch {
    throw new AuthError({
      code: "LOGIN_INPUT_INVALID",
      message: "The Cookidoo gateway URL is invalid.",
      suggestion: "Use the expected HTTPS Cookidoo market origin.",
    });
  }
  if (
    gateway.protocol !== "https:"
    || (gateway.port.length > 0 && gateway.port !== "443")
    || gateway.username.length > 0
    || gateway.password.length > 0
    || gateway.origin !== DEFAULT_GATEWAY
  ) {
    throw new AuthError({
      code: "LOGIN_INPUT_INVALID",
      message: "The Cookidoo gateway must be exactly https://cookidoo.pl.",
      suggestion: "Use the verified Polish Cookidoo market origin.",
    });
  }
  return new URL(gateway.origin);
}

function resolveRedirectTarget(redirectAfterLogin: string, gateway: URL): string {
  if (!redirectAfterLogin.startsWith("/") || redirectAfterLogin.startsWith("//")) {
    throw new AuthError({
      code: "LOGIN_INPUT_INVALID",
      message: "The post-login redirect must be a same-origin relative path.",
      suggestion: "Use a path beginning with one slash, such as /profile.",
    });
  }
  const resolved = new URL(redirectAfterLogin, gateway);
  if (resolved.origin !== gateway.origin) {
    throw new AuthError({
      code: "LOGIN_INPUT_INVALID",
      message: "The post-login redirect must remain on the Cookidoo gateway.",
      suggestion: "Use a same-origin relative path.",
    });
  }
  return `${resolved.pathname}${resolved.search}${resolved.hash}`;
}

/**
 * Execute the first-party browser login flow with an isolated cookie jar.
 *
 * A `verified` result is possible only when the caller's protected-read
 * verifier returns true. Cookie names alone are never treated as proof of a
 * valid session.
 */
export async function loginWithBrowserSession(
  options: BrowserLoginOptions,
): Promise<BrowserLoginResult> {
  const gateway = resolveGateway(options.baseUrl ?? DEFAULT_GATEWAY);
  const language = options.language ?? "pl";
  if (!LANGUAGE_PATTERN.test(language)) {
    throw new AuthError({
      code: "LOGIN_INPUT_INVALID",
      message: "The Cookidoo login language is invalid.",
      suggestion: "Use a language such as pl or pl-PL.",
    });
  }
  if (options.credentials.username.trim().length === 0 || options.credentials.password.length === 0) {
    throw new AuthError({
      code: "CREDENTIALS_NOT_FOUND",
      message: "Cookidoo credentials are unavailable.",
      suggestion: "Import credentials into the selected Keychain profile first.",
    });
  }

  const timeoutMs = boundedInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1, 300_000, "login timeout");
  const maxRedirects = boundedInteger(options.maxRedirects ?? DEFAULT_MAX_REDIRECTS, 1, 30, "redirect limit");
  const maxLoginPageBytes = boundedInteger(
    options.maxLoginPageBytes ?? DEFAULT_MAX_LOGIN_PAGE_BYTES,
    1024,
    4 * 1024 * 1024,
    "login-page size limit",
  );
  const redirectAfterLogin = resolveRedirectTarget(options.redirectAfterLogin ?? "/", gateway);
  const expectedHosts = normalizeExpectedHosts([
    gateway.hostname,
    ...DEFAULT_IDENTITY_HOSTS,
    ...(options.expectedLoginHosts ?? []),
  ]);
  const trajectory = createTrajectorySignal(options.signal, timeoutMs);
  const jar = options.jar ?? createSecureCookieJar();
  const cookieFetch = createCookieFetch(jar, options.fetch ?? globalThis.fetch);
  const loginUrl = new URL(`/profile/${encodeURIComponent(language)}/login`, gateway);
  loginUrl.searchParams.set("redirectAfterLogin", redirectAfterLogin);

  try {
    const loginPage = await openLoginPage(
      cookieFetch,
      loginUrl,
      expectedHosts,
      trajectory.signal,
      maxRedirects,
    );
    if (loginPage.status < 200 || loginPage.status >= 400) {
      throw new AuthError({
        code: "LOGIN_PAGE_FAILED",
        message: "The Cookidoo login page could not be opened.",
        suggestion: "Check connectivity and retry without changing credentials.",
      });
    }
    const html = await readBoundedText(loginPage, maxLoginPageBytes);
    const form = extractLoginForm(html);
    const loginPageUrl = new URL(loginPage.url || loginUrl.href);
    const actionUrl = validateFormAction(form.action, loginPageUrl, expectedHosts);
    const body = new URLSearchParams();
    for (const [name, value] of form.controls) body.append(name, value);
    body.set(form.requestIdName, form.requestId);
    body.set(form.usernameName, options.credentials.username);
    body.set(form.passwordName, options.credentials.password);

    const completion = await submitLoginForm(
      cookieFetch,
      actionUrl,
      loginPageUrl,
      body,
      trajectory.signal,
      maxRedirects,
      expectedHosts,
    );
    if (completion.status < 200 || completion.status >= 400) {
      throw new AuthError({
        code: "LOGIN_SUBMISSION_FAILED",
        message: "The identity provider rejected or could not complete the login submission.",
        suggestion: "Verify the stored credentials and start a fresh login attempt.",
      });
    }

    if (options.verifyProtectedRead === undefined) {
      return { jar, gatewayOrigin: gateway.origin, verification: "not-requested" };
    }
    let verified = false;
    try {
      verified = await options.verifyProtectedRead({
        fetch: cookieFetch,
        signal: trajectory.signal,
        gatewayOrigin: gateway.origin,
      });
    } catch {
      throw new AuthError({
        code: "LOGIN_VERIFICATION_FAILED",
        message: "The new Cookidoo session could not be verified with a protected read.",
        suggestion: "Start a fresh isolated login attempt and retry the verification read.",
      });
    }
    if (!verified) {
      throw new AuthError({
        code: "LOGIN_VERIFICATION_FAILED",
        message: "The new Cookidoo session did not pass the protected-read verification.",
        suggestion: "Check the stored credentials and start a fresh isolated login attempt.",
      });
    }
    return { jar, gatewayOrigin: gateway.origin, verification: "verified" };
  } catch (error) {
    if (isAuthError(error)) throw error;
    if (trajectory.signal.aborted) {
      throw new AuthError({
        code: trajectory.timedOut() ? "LOGIN_TIMEOUT" : "LOGIN_NETWORK_FAILED",
        message: trajectory.timedOut()
          ? "The Cookidoo login attempt timed out."
          : "The Cookidoo login attempt was cancelled.",
        suggestion: "Retry with a fresh isolated login attempt.",
      });
    }
    throw new AuthError({
      code: "LOGIN_NETWORK_FAILED",
      message: "The Cookidoo login flow failed before the session could be verified.",
      suggestion: "Check connectivity and retry with a fresh isolated login attempt.",
    });
  }
}

/** Load Keychain credentials, verify the resulting session, then persist only the serialized jar to Keychain. */
export async function loginStoredProfile(
  options: StoredProfileLoginOptions,
): Promise<StoredProfileLoginResult> {
  const profile = normalizeAuthProfile(options.profile);
  const credentials = await options.store.loadCredentials(profile, options.signal);
  if (credentials === undefined) {
    throw new AuthError({
      code: "CREDENTIALS_NOT_FOUND",
      message: "The selected cookidoo-axi profile has no stored credentials.",
      suggestion: "Import credentials into the profile and retry.",
    });
  }
  const result = await loginWithBrowserSession({
    credentials,
    verifyProtectedRead: options.verifyProtectedRead,
    ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    ...(options.language === undefined ? {} : { language: options.language }),
    ...(options.redirectAfterLogin === undefined ? {} : { redirectAfterLogin: options.redirectAfterLogin }),
    ...(options.expectedLoginHosts === undefined ? {} : { expectedLoginHosts: options.expectedLoginHosts }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.maxRedirects === undefined ? {} : { maxRedirects: options.maxRedirects }),
    ...(options.maxLoginPageBytes === undefined ? {} : { maxLoginPageBytes: options.maxLoginPageBytes }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  if (result.verification !== "verified") {
    throw new AuthError({
      code: "LOGIN_VERIFICATION_FAILED",
      message: "The Cookidoo session was not verified and will not be stored.",
      suggestion: "Retry with a protected-read verifier.",
    });
  }
  await options.store.saveCookieJar(profile, result.jar, options.signal);
  return { profile, gatewayOrigin: result.gatewayOrigin, verification: "verified" };
}

export async function loadStoredSession(options: LoadStoredSessionOptions): Promise<StoredSession> {
  const profile = normalizeAuthProfile(options.profile);
  const jar = await options.store.loadCookieJar(profile, options.signal);
  if (jar === undefined) {
    throw new AuthError({
      code: "SESSION_NOT_FOUND",
      message: "The selected cookidoo-axi profile has no stored cookie session.",
      suggestion: "Log in with the profile and retry.",
    });
  }
  return {
    profile,
    jar,
    fetch: createCookieFetch(jar, options.fetch ?? globalThis.fetch),
  };
}
