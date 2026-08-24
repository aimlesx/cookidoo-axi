import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import { CookieJar, type SerializedCookieJar } from "tough-cookie";

import {
  AuthError,
  createCookieFetch,
  DEFAULT_AUTH_PROFILE,
  isAuthError,
  KeychainAuthStore,
  loginStoredProfile,
  normalizeAuthProfile,
  type AuthSessionStore,
  type CookieFetch,
  type FetchImplementation,
  type ProtectedReadVerifier,
} from "../auth/index.js";
import type { PreparedRequest } from "../api/request.js";
import {
  getOperationById,
  OPENAPI_MANIFEST,
  type ManifestOperation,
} from "../api/spec.js";
import { ApiError, type ReconciliationMetadata } from "./errors.js";

export const COOKIDOO_ORIGIN = "https://cookidoo.pl";
export const DEFAULT_HTTP_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
export const DEFAULT_MAX_READ_ATTEMPTS = 3;

const PROFILE_VERIFICATION_PATH = "/community/profile/pl";
const PROFILE_VERIFICATION_MAX_BYTES = 1024 * 1024;
const TRANSIENT_STATUSES = new Set([429, 502, 503, 504]);
const SECRET_REQUEST_HEADERS = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
]);
const FORBIDDEN_REQUEST_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
  "set-cookie",
  "transfer-encoding",
]);
const SAFE_RESPONSE_HEADERS = new Set([
  "content-length",
  "content-type",
  "etag",
  "last-modified",
  "retry-after",
  "x-correlation-id",
  "x-request-id",
]);

export interface BasicCredentials {
  readonly username: string;
  readonly password: string;
}

export interface BasicCredentialContext {
  readonly operationId: string;
  readonly profile: string;
  readonly signal: AbortSignal;
}

/** A deliberately storage-agnostic seam for the feed API's Basic credentials. */
export interface BasicCredentialProvider {
  getCredentials(
    context: BasicCredentialContext,
  ): Promise<BasicCredentials | undefined>;
}

export interface HttpRetryOptions {
  /** Total transport attempts for safe reads, including the first. */
  readonly maxReadAttempts?: number;
  readonly baseDelayMs?: number;
  readonly maximumDelayMs?: number;
}

export interface ExecuteHttpInput {
  readonly request: PreparedRequest;
  readonly operation: ManifestOperation;
  /**
   * Force mutation semantics for a conditionally effectful GET. Such a request
   * receives cookie-auth preflight, is dispatched once, and is never retried.
   */
  readonly mutationLike?: boolean;
  readonly profile?: string;
  readonly language?: string;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly retry?: HttpRetryOptions;
  readonly signal?: AbortSignal;
  readonly fetch?: FetchImplementation;
  readonly authStore?: AuthSessionStore;
  readonly basicCredentials?: BasicCredentialProvider;
}

export type HttpBodyKind = "empty" | "json" | "text";

export interface ExecuteHttpResult {
  readonly operationId: string;
  readonly method: ManifestOperation["method"];
  readonly status: number;
  readonly contentType: string | null;
  readonly headers: Readonly<Record<string, string>>;
  /** `null` for an empty response; JSON null has `bodyKind: "json"`. */
  readonly data: unknown;
  readonly bodyKind: HttpBodyKind;
  readonly empty: boolean;
  readonly attempts: number;
  readonly reauthenticated: boolean;
}

interface RetryPolicy {
  readonly maxReadAttempts: number;
  readonly baseDelayMs: number;
  readonly maximumDelayMs: number;
}

interface CookieSession {
  readonly fetch: CookieFetch;
  readonly jar: CookieJar;
  readonly store: AuthSessionStore;
  readonly profile: string;
  persistenceFingerprint: string;
}

interface AttemptSignal {
  readonly signal: AbortSignal;
  readonly timedOut: () => boolean;
}

interface ParsedBody {
  readonly data: unknown;
  readonly bodyKind: HttpBodyKind;
  readonly empty: boolean;
}

interface DeclaredResponseContract {
  readonly bodyDeclared: boolean;
  readonly jsonMediaTypes: ReadonlySet<string>;
}

const loginFlights = new WeakMap<object, Map<string, Promise<SerializedCookieJar>>>();

/**
 * Execute one canonical OpenAPI operation through the hardened HTTP boundary.
 * Safe reads may retry; every other operation is dispatched at most once.
 */
export async function execute(input: ExecuteHttpInput): Promise<ExecuteHttpResult> {
  validatePreparedRequest(input.request, input.operation);
  const profile = normalizeAuthProfile(input.profile ?? DEFAULT_AUTH_PROFILE);
  const timeoutMs = boundedInteger(
    input.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS,
    1,
    300_000,
    "HTTP timeout",
  );
  const maximumBytes = boundedInteger(
    input.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
    1024,
    64 * 1024 * 1024,
    "response size limit",
  );
  const retry = normalizeRetryPolicy(input.retry);
  const fetchImplementation = input.fetch ?? globalThis.fetch;
  const safeRead = input.mutationLike !== true && isSafeRead(input.operation);

  if (input.signal?.aborted === true) {
    throw new ApiError({
      code: "REQUEST_CANCELLED",
      message: "The Cookidoo request was cancelled before it was sent.",
      suggestion: "Retry only if the operation is still needed.",
      retrySafe: safeRead,
      outcome: "not-dispatched",
      details: operationDetails(input.operation, input.request),
    });
  }

  let cookieSession: CookieSession | undefined;
  let reauthenticated = false;
  if (input.operation.security === "cookie") {
    const store = input.authStore ?? new KeychainAuthStore();
    if (safeRead) {
      const loaded = await loadOrLoginCookieSession({
        store,
        profile,
        language: input.language,
        timeoutMs,
        signal: input.signal,
        fetchImplementation,
        retry,
      });
      cookieSession = loaded.session;
      reauthenticated = loaded.loggedIn;
    } else {
      const verified = await verifiedMutationCookieSession({
        store,
        profile,
        language: input.language,
        timeoutMs,
        signal: input.signal,
        fetchImplementation,
        retry,
      });
      cookieSession = verified.session;
      reauthenticated = verified.loggedIn;
    }
  }

  const headers = await requestHeaders({
    request: input.request,
    operation: input.operation,
    profile,
    timeoutMs,
    signal: input.signal,
    basicCredentials: input.basicCredentials,
  });

  if (!safeRead) {
    return executeMutationOnce({
      request: input.request,
      operation: input.operation,
      timeoutMs,
      maximumBytes,
      signal: input.signal,
      fetchImplementation,
      cookieSession,
      headers,
      reauthenticated,
    });
  }

  let attempts = 0;
  let transientAttempts = 0;
  let performedFreshLogin = reauthenticated;
  while (true) {
    attempts += 1;
    const attempt = createAttemptSignal(input.signal, timeoutMs);
    let response: Response;
    try {
      response = await dispatch(
        input.request,
        headers,
        cookieSession?.fetch ?? fetchImplementation,
        attempt.signal,
      );
    } catch {
      if (isAborted(input.signal)) {
        throw readTransportError(input.operation, input.request, false);
      }
      transientAttempts += 1;
      if (transientAttempts >= retry.maxReadAttempts) {
        throw readTransportError(input.operation, input.request, attempt.timedOut());
      }
      await retryDelay(
        retryDelayMilliseconds(transientAttempts, undefined, retry) ?? retry.maximumDelayMs,
        input.signal,
      );
      continue;
    }

    if (cookieSession !== undefined) {
      await persistCookieSession(cookieSession);
    }

    if (
      response.status === 401
      && input.operation.security === "cookie"
      && !performedFreshLogin
    ) {
      await discardResponse(response);
      const store = cookieSession?.store ?? input.authStore ?? new KeychainAuthStore();
      const freshJar = await freshLoginSerialized({
        store,
        profile,
        language: input.language,
        timeoutMs,
        signal: input.signal,
        fetchImplementation,
        retry,
      });
      cookieSession = await createCookieSession(store, profile, freshJar, fetchImplementation);
      performedFreshLogin = true;
      reauthenticated = true;
      continue;
    }

    if (response.status === 303 && declaresResponseStatus(input.operation, 303)) {
      const location = validatedRedirectLocation(response.headers.get("location"));
      await discardResponse(response);
      if (location === undefined) {
        throw new ApiError({
          code: "RESPONSE_REDIRECT_INVALID",
          message: "Cookidoo returned a redirect with an unsafe or missing target.",
          suggestion: "Do not follow the redirect; report a feed contract change if it persists.",
          retrySafe: true,
          outcome: "response-received",
          status: response.status,
          details: operationDetails(input.operation, input.request),
        });
      }
      return responseResult({
        input,
        response,
        body: {
          data: { location },
          bodyKind: "json",
          empty: false,
        },
        attempts,
        reauthenticated,
      });
    }

    if (TRANSIENT_STATUSES.has(response.status)) {
      transientAttempts += 1;
      if (transientAttempts < retry.maxReadAttempts) {
        const retryAfter = response.headers.get("retry-after") ?? undefined;
        const delay = retryDelayMilliseconds(transientAttempts, retryAfter, retry);
        if (delay !== null) {
          await discardResponse(response);
          await retryDelay(delay, input.signal);
          continue;
        }
      }
    }

    if (!isSuccess(response.status)) {
      await discardResponse(response);
      throw responseError(input.operation, input.request, response.status, true);
    }

    const body = await parseResponseBody(response, maximumBytes, {
      operation: input.operation,
      request: input.request,
      mutation: false,
    });
    return responseResult({
      input,
      response,
      body,
      attempts,
      reauthenticated,
    });
  }
}

export const executeHttpRequest = execute;

/**
 * Build the exact protected-read verifier used by fresh-login and mutation
 * preflight. Redirects, HTML, non-2xx results, and malformed JSON are rejected.
 */
export function createCookidooProtectedReadVerifier(
  options: {
    readonly retry?: HttpRetryOptions;
    readonly maximumBytes?: number;
  } = {},
): ProtectedReadVerifier {
  const retry = normalizeRetryPolicy(options.retry);
  const maximumBytes = boundedInteger(
    options.maximumBytes ?? PROFILE_VERIFICATION_MAX_BYTES,
    1024,
    PROFILE_VERIFICATION_MAX_BYTES,
    "profile verification size limit",
  );
  return async ({ fetch, signal, gatewayOrigin }) => {
    if (gatewayOrigin !== COOKIDOO_ORIGIN || signal.aborted) return false;
    let transientAttempts = 0;
    while (true) {
      let response: Response;
      try {
        response = await fetch(new URL(PROFILE_VERIFICATION_PATH, COOKIDOO_ORIGIN), {
          method: "GET",
          redirect: "manual",
          signal,
          headers: { accept: "application/json,application/*+json" },
        });
      } catch {
        transientAttempts += 1;
        if (signal.aborted || transientAttempts >= retry.maxReadAttempts) return false;
        await retryDelay(
          retryDelayMilliseconds(transientAttempts, undefined, retry) ?? retry.maximumDelayMs,
          signal,
        );
        continue;
      }
      if (TRANSIENT_STATUSES.has(response.status)) {
        transientAttempts += 1;
        if (transientAttempts < retry.maxReadAttempts) {
          const retryAfter = response.headers.get("retry-after") ?? undefined;
          const delay = retryDelayMilliseconds(transientAttempts, retryAfter, retry);
          if (delay !== null) {
            await discardResponse(response);
            await retryDelay(delay, signal);
            continue;
          }
        }
      }
      if (response.status !== 200 || !isJsonMediaType(response.headers.get("content-type"))) {
        await discardResponse(response);
        return false;
      }
      try {
        const bytes = await readBoundedBytes(response, maximumBytes);
        if (bytes.byteLength === 0) return false;
        const parsed = parseJsonBytes(bytes);
        return isVerifiedCommunityProfile(parsed);
      } catch {
        return false;
      }
    }
  };
}

function isVerifiedCommunityProfile(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const profile = value as Record<string, unknown>;
  if (typeof profile.id !== "string" || profile.id.length === 0) return false;
  if (typeof profile.userInfo !== "object" || profile.userInfo === null ||
      Array.isArray(profile.userInfo)) return false;
  const userInfo = profile.userInfo as Record<string, unknown>;
  return typeof userInfo.username === "string" && userInfo.username.length > 0;
}

interface CookieSessionOptions {
  readonly store: AuthSessionStore;
  readonly profile: string;
  readonly language: string | undefined;
  readonly timeoutMs: number;
  readonly signal: AbortSignal | undefined;
  readonly fetchImplementation: FetchImplementation;
  readonly retry: RetryPolicy;
}

async function loadOrLoginCookieSession(
  options: CookieSessionOptions,
): Promise<{ readonly session: CookieSession; readonly loggedIn: boolean }> {
  const jar = await options.store.loadCookieJar(options.profile, options.signal);
  if (jar !== undefined) {
    return {
      session: await createCookieSession(
        options.store,
        options.profile,
        jar,
        options.fetchImplementation,
      ),
      loggedIn: false,
    };
  }
  const freshJar = await freshLoginSerialized(options);
  return {
    session: await createCookieSession(
      options.store,
      options.profile,
      freshJar,
      options.fetchImplementation,
    ),
    loggedIn: true,
  };
}

async function verifiedMutationCookieSession(
  options: CookieSessionOptions,
): Promise<{ readonly session: CookieSession; readonly loggedIn: boolean }> {
  let loaded = await loadOrLoginCookieSession(options);
  if (loaded.loggedIn) return loaded;

  const verificationAttempt = createAttemptSignal(options.signal, options.timeoutMs);
  const verified = await createCookidooProtectedReadVerifier({ retry: options.retry })({
    fetch: loaded.session.fetch,
    signal: verificationAttempt.signal,
    gatewayOrigin: COOKIDOO_ORIGIN,
  });
  await persistCookieSession(loaded.session);
  if (verified) return loaded;

  if (options.signal?.aborted === true) {
    throw new ApiError({
      code: "REQUEST_CANCELLED",
      message: "Authentication verification was cancelled before the mutation was sent.",
      suggestion: "Retry after confirming that the mutation is still needed.",
      retrySafe: false,
      outcome: "not-dispatched",
      details: { profile: options.profile },
    });
  }
  const freshJar = await freshLoginSerialized(options);
  loaded = {
    session: await createCookieSession(
      options.store,
      options.profile,
      freshJar,
      options.fetchImplementation,
    ),
    loggedIn: true,
  };
  return loaded;
}

async function freshLoginSerialized(options: CookieSessionOptions): Promise<CookieJar> {
  let profileFlights = loginFlights.get(options.store);
  if (profileFlights === undefined) {
    profileFlights = new Map<string, Promise<SerializedCookieJar>>();
    loginFlights.set(options.store, profileFlights);
  }
  const existing = profileFlights.get(options.profile);
  if (existing !== undefined) {
    const serialized = await waitForPromise(existing, options.signal);
    return deserializeCookieJar(serialized);
  }

  const verifier = createCookidooProtectedReadVerifier({ retry: options.retry });
  const flight = captureFreshLoginJar(options, verifier);
  profileFlights.set(options.profile, flight);
  try {
    return deserializeCookieJar(await flight);
  } finally {
    if (profileFlights.get(options.profile) === flight) {
      profileFlights.delete(options.profile);
    }
  }
}

async function captureFreshLoginJar(
  options: CookieSessionOptions,
  verifier: ProtectedReadVerifier,
): Promise<SerializedCookieJar> {
  let persistedJar: SerializedCookieJar | undefined;
  const capturingStore: AuthSessionStore = {
    loadCredentials(profile, signal) {
      return options.store.loadCredentials(profile, signal);
    },
    loadCookieJar(profile, signal) {
      return options.store.loadCookieJar(profile, signal);
    },
    async saveCookieJar(profile, jar, signal) {
      const serialized = await serializeCookieJar(jar);
      await options.store.saveCookieJar(profile, jar, signal);
      persistedJar = serialized;
    },
  };
  await loginStoredProfile({
    profile: options.profile,
    store: capturingStore,
    baseUrl: COOKIDOO_ORIGIN,
    redirectAfterLogin: PROFILE_VERIFICATION_PATH,
    verifyProtectedRead: verifier,
    fetch: options.fetchImplementation,
    timeoutMs: options.timeoutMs,
    ...(options.language === undefined ? {} : { language: options.language }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  if (persistedJar === undefined) {
    throw cookieSerializationError();
  }
  return persistedJar;
}

async function createCookieSession(
  store: AuthSessionStore,
  profile: string,
  jar: CookieJar,
  fetchImplementation: FetchImplementation,
): Promise<CookieSession> {
  return {
    fetch: createCookieFetch(jar, fetchImplementation),
    jar,
    store,
    profile,
    persistenceFingerprint: await cookiePersistenceFingerprint(jar),
  };
}

async function persistCookieSession(session: CookieSession): Promise<void> {
  const fingerprint = await cookiePersistenceFingerprint(session.jar);
  if (fingerprint === session.persistenceFingerprint) return;
  await session.store.saveCookieJar(session.profile, session.jar);
  session.persistenceFingerprint = fingerprint;
}

async function cookiePersistenceFingerprint(jar: CookieJar): Promise<string> {
  const serialized = await serializeCookieJar(jar);
  const { cookies, ...configuration } = serialized;
  const stableCookies = cookies.map((cookie) => {
    const persistentCookie = Object.fromEntries(
      Object.entries(cookie).filter(([key]) => key !== "lastAccessed"),
    );
    return stableJson(persistentCookie);
  }).sort();
  const canonical = JSON.stringify([stableJson(configuration), stableCookies]);
  return createHash("sha256").update(canonical).digest("base64url");
}

async function serializeCookieJar(jar: CookieJar): Promise<SerializedCookieJar> {
  try {
    return await jar.serialize();
  } catch {
    throw cookieSerializationError();
  }
}

async function deserializeCookieJar(serialized: SerializedCookieJar): Promise<CookieJar> {
  try {
    return await CookieJar.deserialize(serialized);
  } catch {
    throw cookieSerializationError();
  }
}

function cookieSerializationError(): AuthError {
  return new AuthError({
    code: "KEYCHAIN_DATA_INVALID",
    message: "The Cookidoo cookie session could not be serialized safely.",
    suggestion: "Create a fresh authenticated session and retry.",
  });
}

function stableJson(value: unknown): string {
  return JSON.stringify(canonicalJsonValue(value)) ?? "null";
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (typeof value !== "object" || value === null) return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = canonicalJsonValue((value as Record<string, unknown>)[key]);
  }
  return sorted;
}

interface MutationExecutionOptions {
  readonly request: PreparedRequest;
  readonly operation: ManifestOperation;
  readonly timeoutMs: number;
  readonly maximumBytes: number;
  readonly signal: AbortSignal | undefined;
  readonly fetchImplementation: FetchImplementation;
  readonly cookieSession: CookieSession | undefined;
  readonly headers: Headers;
  readonly reauthenticated: boolean;
}

async function executeMutationOnce(
  options: MutationExecutionOptions,
): Promise<ExecuteHttpResult> {
  const attempt = createAttemptSignal(options.signal, options.timeoutMs);
  if (attempt.signal.aborted) {
    throw new ApiError({
      code: "REQUEST_CANCELLED",
      message: "The Cookidoo mutation was cancelled before it was sent.",
      suggestion: "Retry only after confirming that the mutation is still needed.",
      retrySafe: false,
      outcome: "not-dispatched",
      details: operationDetails(options.operation, options.request),
    });
  }

  let response: Response;
  try {
    response = await dispatch(
      options.request,
      options.headers,
      options.cookieSession?.fetch ?? options.fetchImplementation,
      attempt.signal,
    );
  } catch {
    throw ambiguousMutationError(
      options.operation,
      options.request,
      attempt.timedOut() ? "timed out" : "lost its transport connection",
    );
  }

  if (options.cookieSession !== undefined) {
    try {
      await persistCookieSession(options.cookieSession);
    } catch {
      await discardResponse(response);
      throw mutationResponseError({
        code: "MUTATION_SESSION_PERSIST_FAILED",
        message: "The mutation received a response, but the rotated session could not be saved.",
        operation: options.operation,
        request: options.request,
        status: response.status,
      });
    }
  }

  if (!isSuccess(response.status)) {
    await discardResponse(response);
    if (response.status >= 500) {
      throw ambiguousMutationError(
        options.operation,
        options.request,
        `received HTTP ${response.status}`,
        response.status,
      );
    }
    throw responseError(options.operation, options.request, response.status, false);
  }

  let body: ParsedBody;
  try {
    body = await parseResponseBody(response, options.maximumBytes, {
      operation: options.operation,
      request: options.request,
      mutation: true,
    });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw mutationResponseError({
      code: "MUTATION_RESPONSE_UNREADABLE",
      message: "The mutation succeeded, but its response could not be read safely.",
      operation: options.operation,
      request: options.request,
      status: response.status,
    });
  }
  return {
    operationId: options.operation.operationId,
    method: options.operation.method,
    status: response.status,
    contentType: normalizedContentType(response.headers.get("content-type")),
    headers: safeResponseHeaders(response.headers),
    data: body.data,
    bodyKind: body.bodyKind,
    empty: body.empty,
    attempts: 1,
    reauthenticated: options.reauthenticated,
  };
}

interface RequestHeaderOptions {
  readonly request: PreparedRequest;
  readonly operation: ManifestOperation;
  readonly profile: string;
  readonly timeoutMs: number;
  readonly signal: AbortSignal | undefined;
  readonly basicCredentials: BasicCredentialProvider | undefined;
}

async function requestHeaders(options: RequestHeaderOptions): Promise<Headers> {
  const headers = new Headers();
  for (const [name, value] of Object.entries(options.request.headers)) {
    const normalized = name.trim().toLowerCase();
    if (SECRET_REQUEST_HEADERS.has(normalized)) {
      throw new ApiError({
        code: "SECRET_HEADER_REJECTED",
        message: "Authentication headers must come from the approved credential provider.",
        suggestion: "Remove the raw secret header and use the selected auth profile.",
        retrySafe: true,
        outcome: "not-dispatched",
        details: operationDetails(options.operation, options.request),
      });
    }
    if (FORBIDDEN_REQUEST_HEADERS.has(normalized)) {
      throw new ApiError({
        code: "UNSAFE_HEADER_REJECTED",
        message: `The managed request header '${normalized}' cannot be overridden.`,
        suggestion: "Remove the header and let cookidoo-axi manage the HTTP request.",
        retrySafe: true,
        outcome: "not-dispatched",
        details: operationDetails(options.operation, options.request),
      });
    }
    headers.set(name, value);
  }
  headers.set("user-agent", "cookidoo-axi/0.1");

  if (options.operation.security !== "basic") return headers;
  if (options.basicCredentials === undefined) {
    throw new ApiError({
      code: "BASIC_CREDENTIALS_NOT_CONFIGURED",
      message: "This feed operation requires a Basic credential provider.",
      suggestion: "Configure the feed credential provider before using Basic-auth operations.",
      retrySafe: true,
      outcome: "not-dispatched",
      details: operationDetails(options.operation, options.request),
    });
  }
  const attempt = createAttemptSignal(options.signal, options.timeoutMs);
  let credentials: BasicCredentials | undefined;
  try {
    credentials = await options.basicCredentials.getCredentials({
      operationId: options.operation.operationId,
      profile: options.profile,
      signal: attempt.signal,
    });
  } catch (error) {
    if (isAuthError(error)) throw error;
    throw new ApiError({
      code: "BASIC_CREDENTIALS_UNAVAILABLE",
      message: "Feed credentials could not be loaded.",
      suggestion: "Check the configured feed credential provider and retry.",
      retrySafe: true,
      outcome: "not-dispatched",
      details: operationDetails(options.operation, options.request),
    });
  }
  if (credentials === undefined || !validBasicCredentials(credentials)) {
    throw new ApiError({
      code: "BASIC_CREDENTIALS_INVALID",
      message: "Feed credentials are missing or invalid.",
      suggestion: "Store a non-empty username and password in the feed credential provider.",
      retrySafe: true,
      outcome: "not-dispatched",
      details: operationDetails(options.operation, options.request),
    });
  }
  const encoded = Buffer.from(`${credentials.username}:${credentials.password}`, "utf8");
  try {
    headers.set("authorization", `Basic ${encoded.toString("base64")}`);
  } finally {
    encoded.fill(0);
  }
  return headers;
}

function validBasicCredentials(value: BasicCredentials): boolean {
  return value.username.length > 0
    && value.username.length <= 320
    && value.password.length > 0
    && value.password.length <= 16_384
    && !/[:\0\r\n]/u.test(value.username)
    && !/[\0\r\n]/u.test(value.password);
}

async function dispatch(
  request: PreparedRequest,
  headers: Headers,
  fetchImplementation: FetchImplementation | CookieFetch,
  signal: AbortSignal,
): Promise<Response> {
  return fetchImplementation(request.url, {
    method: request.method,
    headers,
    ...(request.body === undefined ? {} : { body: request.body }),
    redirect: "manual",
    signal,
  });
}

interface ResponseParseContext {
  readonly operation: ManifestOperation;
  readonly request: PreparedRequest;
  readonly mutation: boolean;
}

async function parseResponseBody(
  response: Response,
  maximumBytes: number,
  context: ResponseParseContext,
): Promise<ParsedBody> {
  const contract = declaredResponseContract(context.operation, response.status);
  if (contract === undefined) {
    await discardResponse(response);
    throw unexpectedSuccessResponse(
      context,
      response.status,
      safeContentTypeForDiagnostics(response.headers.get("content-type")),
    );
  }

  const contentType = normalizedContentType(response.headers.get("content-type"));
  if (
    contract.bodyDeclared
    && (
      contentType === null
      || !isJsonMediaType(contentType)
      || !contract.jsonMediaTypes.has(contentType)
    )
  ) {
    await discardResponse(response);
    throw unexpectedSuccessResponse(
      context,
      response.status,
      safeContentTypeForDiagnostics(response.headers.get("content-type")),
    );
  }

  let bytes: Uint8Array;
  try {
    bytes = await readBoundedBytes(response, maximumBytes);
  } catch {
    if (context.mutation) {
      throw mutationResponseError({
        code: "MUTATION_RESPONSE_UNREADABLE",
        message: "The mutation received a success response, but its body could not be read safely.",
        operation: context.operation,
        request: context.request,
        status: response.status,
      });
    }
    throw new ApiError({
      code: "RESPONSE_BODY_UNREADABLE",
      message: "The Cookidoo response could not be read within the safety limit.",
      suggestion: "Narrow the request or retry the safe read.",
      retrySafe: true,
      outcome: "response-received",
      status: response.status,
      details: operationDetails(context.operation, context.request),
    });
  }
  if (bytes.byteLength === 0) {
    if (contract.bodyDeclared) {
      throw unexpectedSuccessResponse(context, response.status, contentType);
    }
    return { data: null, bodyKind: "empty", empty: true };
  }

  if (!contract.bodyDeclared || looksLikeHtml(bytes)) {
    throw unexpectedSuccessResponse(context, response.status, contentType);
  }
  try {
    return { data: parseJsonBytes(bytes), bodyKind: "json", empty: false };
  } catch {
    throw context.mutation
      ? mutationResponseError({
          code: "MUTATION_RESPONSE_JSON_INVALID",
          message: "The mutation received a success response with malformed JSON.",
          operation: context.operation,
          request: context.request,
          status: response.status,
        })
      : new ApiError({
          code: "RESPONSE_JSON_INVALID",
          message: "Cookidoo returned malformed JSON.",
          suggestion: "Retry the safe read; report a contract change if it persists.",
          retrySafe: true,
          outcome: "response-received",
          status: response.status,
          details: operationDetails(context.operation, context.request),
        });
  }
}

function declaredResponseContract(
  operation: ManifestOperation,
  status: number,
): DeclaredResponseContract | undefined {
  const canonical = getOperationById(operation.operationId);
  const statusKey = String(status);
  if (!Object.hasOwn(canonical.responses, statusKey)) return undefined;
  const response = resolveDeclaredResponse(canonical.responses[statusKey]);
  if (response === undefined) return undefined;
  if (response.content === undefined) {
    return { bodyDeclared: false, jsonMediaTypes: new Set() };
  }
  if (!isRecord(response.content)) return undefined;
  const mediaTypes = Object.keys(response.content)
    .map((mediaType) => normalizedContentType(mediaType))
    .filter((mediaType): mediaType is string => mediaType !== null && isJsonMediaType(mediaType));
  return {
    bodyDeclared: Object.keys(response.content).length > 0,
    jsonMediaTypes: new Set(mediaTypes),
  };
}

function resolveDeclaredResponse(
  value: unknown,
): Readonly<Record<string, unknown>> | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.$ref !== "string") return value;
  const prefix = "#/components/responses/";
  if (!value.$ref.startsWith(prefix)) return undefined;
  const name = value.$ref.slice(prefix.length)
    .replaceAll("~1", "/")
    .replaceAll("~0", "~");
  const resolved = OPENAPI_MANIFEST.components.responses[name];
  return isRecord(resolved) ? resolved : undefined;
}

function unexpectedSuccessResponse(
  context: ResponseParseContext,
  status: number,
  contentType?: string | null,
): ApiError {
  if (context.mutation) {
    return mutationResponseError({
      code: "MUTATION_RESPONSE_TYPE_UNEXPECTED",
      message: "The mutation received a success response outside its declared response contract.",
      operation: context.operation,
      request: context.request,
      status,
      ...(contentType === undefined ? {} : { contentType }),
    });
  }
  return new ApiError({
    code: "RESPONSE_TYPE_UNEXPECTED",
    message: "Cookidoo returned a success response outside the declared response contract.",
    suggestion: "Retry after verifying that the API contract has not changed.",
    retrySafe: true,
    outcome: "response-received",
    status,
    details: operationDetails(context.operation, context.request),
  });
}

async function readBoundedBytes(response: Response, maximumBytes: number): Promise<Uint8Array> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && /^\d+$/u.test(contentLength)) {
    const declared = Number(contentLength);
    if (Number.isSafeInteger(declared) && declared > maximumBytes) {
      await discardResponse(response);
      throw new Error("bounded response exceeded");
    }
  }
  if (response.body === null) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new Error("bounded response exceeded");
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function parseJsonBytes(bytes: Uint8Array): unknown {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return JSON.parse(text) as unknown;
}

function responseResult(options: {
  readonly input: ExecuteHttpInput;
  readonly response: Response;
  readonly body: ParsedBody;
  readonly attempts: number;
  readonly reauthenticated: boolean;
}): ExecuteHttpResult {
  return {
    operationId: options.input.operation.operationId,
    method: options.input.operation.method,
    status: options.response.status,
    contentType: normalizedContentType(options.response.headers.get("content-type")),
    headers: safeResponseHeaders(options.response.headers),
    data: options.body.data,
    bodyKind: options.body.bodyKind,
    empty: options.body.empty,
    attempts: options.attempts,
    reauthenticated: options.reauthenticated,
  };
}

function validatePreparedRequest(request: PreparedRequest, operation: ManifestOperation): void {
  if (
    request.url.origin !== COOKIDOO_ORIGIN
    || request.url.username.length > 0
    || request.url.password.length > 0
    || request.url.hash.length > 0
  ) {
    throw new ApiError({
      code: "UNSAFE_REQUEST_ORIGIN",
      message: "The HTTP boundary accepts only credential-free https://cookidoo.pl requests.",
      suggestion: "Regenerate the request from the canonical OpenAPI operation.",
      retrySafe: true,
      outcome: "not-dispatched",
      details: { operationId: operation.operationId },
    });
  }
  let canonical: ManifestOperation;
  try {
    canonical = getOperationById(operation.operationId);
  } catch {
    throw requestOperationMismatch(operation.operationId);
  }
  if (
    request.operationId !== canonical.operationId
    || request.method !== canonical.method
    || operation.method !== canonical.method
    || operation.path !== canonical.path
    || !pathnameMatchesTemplate(request.url.pathname, canonical.path)
  ) {
    throw requestOperationMismatch(operation.operationId);
  }
}

function requestOperationMismatch(operationId: string): ApiError {
  return new ApiError({
    code: "REQUEST_OPERATION_MISMATCH",
    message: "The prepared request does not match its canonical OpenAPI operation.",
    suggestion: "Regenerate the request from the canonical OpenAPI manifest.",
    retrySafe: true,
    outcome: "not-dispatched",
    details: { operationId },
  });
}

function pathnameMatchesTemplate(pathname: string, template: string): boolean {
  let pattern = "^";
  let offset = 0;
  for (const match of template.matchAll(/\{[^{}\/]+\}/gu)) {
    const index = match.index;
    pattern += escapeRegularExpression(template.slice(offset, index));
    pattern += "[^/]+";
    offset = index + match[0].length;
  }
  pattern += `${escapeRegularExpression(template.slice(offset))}$`;
  return new RegExp(pattern, "u").test(pathname);
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeRead(operation: ManifestOperation): boolean {
  return operation.method === "GET" && operation.risk.effect === "read";
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function isSuccess(status: number): boolean {
  return status >= 200 && status < 300;
}

function declaresResponseStatus(operation: ManifestOperation, status: number): boolean {
  const canonical = getOperationById(operation.operationId);
  return Object.hasOwn(canonical.responses, String(status));
}

function validatedRedirectLocation(value: string | null): string | undefined {
  if (value === null || value.length === 0 || value.length > 4096) return undefined;
  let location: URL;
  try {
    location = new URL(value);
  } catch {
    return undefined;
  }
  if (
    location.origin !== COOKIDOO_ORIGIN
    || location.username.length > 0
    || location.password.length > 0
    || location.hash.length > 0
  ) {
    return undefined;
  }
  return location.href;
}

function normalizedContentType(value: string | null): string | null {
  const normalized = value?.split(";", 1)[0]?.trim().toLowerCase();
  return normalized === undefined || normalized.length === 0 ? null : normalized;
}

function safeContentTypeForDiagnostics(value: string | null): string | null {
  const normalized = normalizedContentType(value);
  return normalized !== null
    && normalized.length <= 127
    && /^[a-z0-9][a-z0-9!#$%&'*+.^_|~-]*\/[a-z0-9][a-z0-9!#$%&'*+.^_|~-]*$/u.test(normalized)
    ? normalized
    : null;
}

function isJsonMediaType(value: string | null): boolean {
  const normalized = normalizedContentType(value);
  return normalized === "application/json" || normalized?.endsWith("+json") === true;
}

function looksLikeHtml(bytes: Uint8Array): boolean {
  const prefix = new TextDecoder("utf-8", { fatal: false })
    .decode(bytes.subarray(0, Math.min(bytes.byteLength, 256)))
    .trimStart()
    .toLowerCase();
  // No documented operation returns markup, so reject every markup-looking
  // payload rather than risk surfacing an identity-provider HTML fragment.
  return prefix.startsWith("<");
}

function safeResponseHeaders(headers: Headers): Readonly<Record<string, string>> {
  const output: Record<string, string> = {};
  for (const name of SAFE_RESPONSE_HEADERS) {
    const value = headers.get(name);
    if (value !== null && /^[\x20-\x7E]{1,256}$/u.test(value)) output[name] = value;
  }
  return output;
}

function operationDetails(
  operation: ManifestOperation,
  request: PreparedRequest,
): Readonly<Record<string, unknown>> {
  return {
    operationId: operation.operationId,
    method: operation.method,
    resourcePath: request.url.pathname,
  };
}

function reconciliation(
  operation: ManifestOperation,
  request: PreparedRequest,
): ReconciliationMetadata {
  return {
    required: true,
    operationId: operation.operationId,
    method: operation.method,
    resourcePath: request.url.pathname,
    guidance: "Inspect the affected resource with a read operation before deciding whether to issue another mutation.",
  };
}

function ambiguousMutationError(
  operation: ManifestOperation,
  request: PreparedRequest,
  failure: string,
  status?: number,
): ApiError {
  return new ApiError({
    code: "MUTATION_OUTCOME_UNKNOWN",
    message: `The Cookidoo mutation ${failure}; its outcome is unknown.`,
    suggestion: "Do not retry automatically. Reconcile the affected resource with a read first.",
    retrySafe: false,
    outcome: "unknown",
    ...(status === undefined ? {} : { status }),
    reconciliation: reconciliation(operation, request),
    details: operationDetails(operation, request),
  });
}

function mutationResponseError(options: {
  readonly code: string;
  readonly message: string;
  readonly operation: ManifestOperation;
  readonly request: PreparedRequest;
  readonly status: number;
  readonly contentType?: string | null;
}): ApiError {
  return new ApiError({
    code: options.code,
    message: options.message,
    suggestion: "Do not repeat the mutation; read the affected resource to reconcile its state.",
    retrySafe: false,
    outcome: "response-received",
    status: options.status,
    reconciliation: reconciliation(options.operation, options.request),
    details: {
      ...operationDetails(options.operation, options.request),
      ...(options.contentType === undefined ? {} : { contentType: options.contentType }),
    },
  });
}

function responseError(
  operation: ManifestOperation,
  request: PreparedRequest,
  status: number,
  safeRead: boolean,
): ApiError {
  const authenticationFailure = status === 401 || status === 403;
  return new ApiError({
    code: authenticationFailure ? "API_AUTHENTICATION_FAILED" : "API_HTTP_ERROR",
    message: authenticationFailure
      ? `Cookidoo rejected authentication for ${operation.operationId}.`
      : `Cookidoo returned HTTP ${status} for ${operation.operationId}.`,
    suggestion: authenticationFailure
      ? "Refresh the selected auth profile and retry only safe reads."
      : safeRead
        ? "Review the request and retry only if it remains safe."
        : "Do not retry the mutation automatically; inspect resource state first.",
    retrySafe: safeRead,
    outcome: "response-received",
    status,
    ...(safeRead ? {} : { reconciliation: reconciliation(operation, request) }),
    details: operationDetails(operation, request),
  });
}

function readTransportError(
  operation: ManifestOperation,
  request: PreparedRequest,
  timedOut: boolean,
): ApiError {
  return new ApiError({
    code: timedOut ? "REQUEST_TIMEOUT" : "REQUEST_NETWORK_FAILED",
    message: timedOut
      ? "The Cookidoo read timed out."
      : "The Cookidoo read could not reach the API.",
    suggestion: "The read was not a mutation and can be retried.",
    retrySafe: true,
    outcome: "unknown",
    details: operationDetails(operation, request),
  });
}

function normalizeRetryPolicy(input: HttpRetryOptions | undefined): RetryPolicy {
  const maxReadAttempts = boundedInteger(
    input?.maxReadAttempts ?? DEFAULT_MAX_READ_ATTEMPTS,
    1,
    5,
    "read retry attempt limit",
  );
  const baseDelayMs = boundedInteger(input?.baseDelayMs ?? 150, 0, 10_000, "retry base delay");
  const maximumDelayMs = boundedInteger(
    input?.maximumDelayMs ?? 2_000,
    0,
    30_000,
    "retry maximum delay",
  );
  if (baseDelayMs > maximumDelayMs) {
    throw new ApiError({
      code: "INVALID_RETRY_POLICY",
      message: "The retry base delay cannot exceed the maximum delay.",
      suggestion: "Use a base delay no greater than the maximum retry delay.",
      retrySafe: true,
      outcome: "not-dispatched",
    });
  }
  return { maxReadAttempts, baseDelayMs, maximumDelayMs };
}

function retryDelayMilliseconds(
  attempt: number,
  retryAfter: string | undefined,
  policy: RetryPolicy,
): number | null {
  const indicated = parseRetryAfter(retryAfter);
  if (indicated !== undefined) {
    return indicated <= policy.maximumDelayMs ? indicated : null;
  }
  return Math.min(policy.baseDelayMs * (2 ** Math.max(0, attempt - 1)), policy.maximumDelayMs);
}

function parseRetryAfter(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (/^\d+$/u.test(normalized)) return Number(normalized) * 1000;
  const date = Date.parse(normalized);
  if (!Number.isFinite(date)) return undefined;
  return Math.max(0, date - Date.now());
}

async function retryDelay(milliseconds: number, signal: AbortSignal | undefined): Promise<void> {
  if (milliseconds === 0) return;
  if (signal?.aborted === true) {
    throw new ApiError({
      code: "REQUEST_CANCELLED",
      message: "The Cookidoo read was cancelled.",
      suggestion: "Retry the safe read if it is still needed.",
      retrySafe: true,
      outcome: "not-dispatched",
    });
  }
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: ApiError): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (error === undefined) resolve();
      else reject(error);
    };
    const timer = setTimeout(() => {
      finish();
    }, milliseconds);
    const onAbort = (): void => {
      finish(new ApiError({
        code: "REQUEST_CANCELLED",
        message: "The Cookidoo read was cancelled.",
        suggestion: "Retry the safe read if it is still needed.",
        retrySafe: true,
        outcome: "not-dispatched",
      }));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted === true) onAbort();
  });
}

function createAttemptSignal(signal: AbortSignal | undefined, timeoutMs: number): AttemptSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return {
    signal: signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal]),
    timedOut: () => timeoutSignal.aborted && !(signal?.aborted ?? false),
  };
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new ApiError({
      code: "INVALID_HTTP_OPTION",
      message: `The ${label} is invalid.`,
      suggestion: `Use an integer from ${minimum} through ${maximum}.`,
      retrySafe: true,
      outcome: "not-dispatched",
    });
  }
  return value;
}

async function discardResponse(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Cancellation is best-effort and never copied into diagnostics.
  }
}

async function waitForPromise<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) {
    return promise;
  }
  if (signal.aborted) {
    throw new AuthError({
      code: "LOGIN_NETWORK_FAILED",
      message: "The shared Cookidoo login attempt was cancelled.",
      suggestion: "Retry with the selected Keychain profile.",
    });
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (settle: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      settle();
    };
    const onAbort = (): void => {
      finish(() => reject(new AuthError({
        code: "LOGIN_NETWORK_FAILED",
        message: "The shared Cookidoo login attempt was cancelled.",
        suggestion: "Retry with the selected Keychain profile.",
      })));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
    if (signal.aborted) onAbort();
  });
}
