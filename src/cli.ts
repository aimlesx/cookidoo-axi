import { resolve } from "node:path";
import { homedir } from "node:os";

import {
  FeedCredentialStore,
  KeychainAuthStore,
  assertDarwin,
  importCredentialsFromEnvFile,
  loginStoredProfile,
  probeMacOSKeychainBinding,
  type FetchImplementation,
  type KeyringModuleLoader,
} from "./auth/index.js";
import { OPENAPI_MANIFEST, getOperationById, validateResponse } from "./api/spec.js";
import { groupHelp, operationHelp, rootHelp } from "./cli/help.js";
import { parseInvocation } from "./cli/parser.js";
import {
  commandArgument,
  commandLiteral,
  commandLiterals,
  quotePosixArgument,
  renderContextualCommand,
  type CommandToken,
} from "./cli/command.js";
import {
  collectionView,
  hasReproducibleBody,
  operationCatalog,
  operationDescription,
  safeCommand,
} from "./cli/present.js";
import type {
  AuthStatusInspection,
  GlobalOptions,
  OperationListFilter,
  OperationDescriptor,
  ParsedOperationInvocation,
} from "./cli/types.js";
import { OperationalError, UsageError, isCliError } from "./errors.js";
import {
  createCookidooProtectedReadVerifier,
  ApiError,
  execute as executeHttp,
  isApiError,
  type ExecuteHttpInput,
  type ExecuteHttpResult,
} from "./http/index.js";
import { resolveOperationInvocation } from "./operation.js";
import type { ReconciliationGuidance } from "./safety/policy.js";
import {
  OutputBoundaryError,
  containsCredentialLikeText,
  createJsonObject,
  normalizeCollection,
  normalizeDetail,
  sanitizeDiagnostic,
  writeOutput,
  type NextCommandInput,
  type TextOutputStream,
} from "./output/index.js";
import { installCodexIntegration, removeCodexIntegration, sessionStartContext } from "./setup.js";
import { AuthError } from "./auth/errors.js";
import { VERSION } from "./version.js";

const BASE_URL = "https://cookidoo.pl";
const FEED_ENV_NAMES = {
  username: ["COOKIDOO_FEED_USERNAME"] as const,
  password: ["COOKIDOO_FEED_PASSWORD"] as const,
};

export interface RunDependencies {
  readonly executablePath?: string;
  readonly stdout?: TextOutputStream;
  readonly stderr?: TextOutputStream;
  readonly authStore?: KeychainAuthStore;
  readonly feedStore?: FeedCredentialStore;
  readonly fetch?: FetchImplementation;
  readonly httpExecute?: (input: ExecuteHttpInput) => Promise<ExecuteHttpResult>;
  readonly platform?: NodeJS.Platform;
  readonly loadKeyring?: KeyringModuleLoader;
}

export async function run(
  argv: string[],
  dependencies: RunDependencies = {},
): Promise<number> {
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  const operations = OPENAPI_MANIFEST.operations as unknown as readonly OperationDescriptor[];
  let options: GlobalOptions | undefined;
  try {
    assertDarwin(dependencies.platform ?? process.platform);
    const invocation = parseInvocation(argv, [...operations]);
    options = invocation.options;
    const stores = createStores(dependencies);

    switch (invocation.kind) {
      case "root-help":
        writeText(rootHelp([...operations]), stdout);
        return 0;
      case "group-help":
        writeText(groupHelp(invocation.group, [...operations]), stdout);
        return 0;
      case "operation-help":
        writeText(operationHelp(invocation.operation), stdout);
        return 0;
      case "hook-session-start":
        stdout.write(`${JSON.stringify(sessionStartContext(executablePath(dependencies)))}\n`);
        return 0;
      case "home":
        emitHome(
          invocation.options,
          executablePath(dependencies),
          stdout,
        );
        return 0;
      case "operation-list":
        emitOperationList([...operations], invocation.filter, invocation.options, stdout);
        return 0;
      case "operation-describe": {
        const operation = getOperationById(invocation.operationId) as unknown as OperationDescriptor;
        emitDetail(operationDescription(operation), invocation.options, stdout, {
          command: renderUtilityCommand(
            [...commandLiterals(["cookidoo-axi", "operation", "describe"]), commandArgument(invocation.operationId)],
            invocation.options,
          ),
          next: [
            renderFollowUpCommand(
              commandLiterals(["cookidoo-axi", ...operation.command, "--help"]),
              invocation.options,
            ),
          ],
        });
        return 0;
      }
      case "auth-doctor": {
        const result = await probeMacOSKeychainBinding({
          platform: dependencies.platform ?? process.platform,
          ...(dependencies.loadKeyring === undefined ? {} : { loadKeyring: dependencies.loadKeyring }),
        });
        const { binding, ...diagnostic } = result;
        emitDetail({ keychainBinding: binding, ...diagnostic }, invocation.options, stdout, {
          command: renderUtilityCommand(
            commandLiterals(["cookidoo-axi", "auth", "doctor"]),
            invocation.options,
          ),
          next: [profileReadCommand(invocation.options)],
        });
        return 0;
      }
      case "auth-status":
        await emitAuthStatus(
          invocation.options,
          invocation.inspection,
          stores.auth,
          stores.feed,
          stdout,
        );
        return 0;
      case "auth-import-env": {
        let replacing = false;
        let cookieSessionRecordRemoved = false;
        const result = await importCredentialsFromEnvFile({
          path: resolve(invocation.envFile),
          store: stores.auth,
          profile: invocation.options.profile,
          beforeSave: async () => {
            replacing = await assertCredentialImportAllowed(
              stores.auth,
              invocation.options.profile,
              invocation.options.confirm,
              "market",
            );
            // Always invalidate the account-bound session before committing
            // credentials, including when an orphaned session is the only
            // existing record. A deletion failure aborts the credential write.
            cookieSessionRecordRemoved = await stores.auth.deleteCookieJar(
              invocation.options.profile,
            );
          },
        });
        emitDetail({
          result: "stored",
          storage: "macOS Keychain",
          profile: result.profile,
          importedKeys: [result.usernameKey, result.passwordKey],
          sourceFileChanged: false,
          secretValuesReturned: false,
          marketRecordReplaced: replacing,
          cookieSessionRecordRemoved,
        }, invocation.options, stdout, {
          command: "cookidoo-axi auth import-env",
          next: [profileReadCommand(invocation.options)],
          allowFullCommand: false,
        });
        return 0;
      }
      case "auth-import-feed-env": {
        await assertCredentialImportAllowed(
          stores.feed,
          invocation.options.profile,
          invocation.options.confirm,
          "feed",
        );
        const result = await importCredentialsFromEnvFile({
          path: resolve(invocation.envFile),
          store: stores.feed,
          profile: invocation.options.profile,
          names: FEED_ENV_NAMES,
        });
        emitDetail({
          result: "stored",
          storage: "macOS Keychain (separate feed namespace)",
          profile: result.profile,
          importedKeys: [result.usernameKey, result.passwordKey],
          credentialAcquisitionDocumented: false,
          sourceFileChanged: false,
          secretValuesReturned: false,
        }, invocation.options, stdout, {
          command: "cookidoo-axi auth import-feed-env",
          next: [renderFollowUpCommand(
            commandLiterals(["cookidoo-axi", "feed", "bootstrap"]),
            invocation.options,
          )],
          allowFullCommand: false,
        });
        return 0;
      }
      case "auth-login": {
        const result = await loginStoredProfile({
          profile: invocation.options.profile,
          store: stores.auth,
          baseUrl: BASE_URL,
          language: invocation.options.lang,
          redirectAfterLogin: "/community/profile/pl",
          verifyProtectedRead: createCookidooProtectedReadVerifier(),
          timeoutMs: invocation.options.timeoutMs,
          ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
        });
        emitDetail({
          result: "authenticated",
          profile: result.profile,
          session: "verified protected read",
          storage: "macOS Keychain cookie jar",
        }, invocation.options, stdout, {
          command: "cookidoo-axi auth login",
          next: [profileReadCommand(invocation.options)],
          allowFullCommand: false,
        });
        return 0;
      }
      case "auth-clear-session": {
        const expected = `session:${invocation.options.profile}`;
        requireExactConfirmation(invocation.options.confirm, expected, "cached session removal");
        const deleted = await stores.auth.deleteCookieJar(invocation.options.profile);
        emitDetail({
          result: deleted ? "removed" : "already_absent",
          profile: invocation.options.profile,
          credentialsPreserved: true,
        }, invocation.options, stdout, {
          command: "cookidoo-axi auth clear-session",
          next: [profileReadCommand(invocation.options)],
          allowFullCommand: false,
        });
        return 0;
      }
      case "auth-remove": {
        requireExactConfirmation(
          invocation.options.confirm,
          invocation.options.profile,
          "Keychain profile removal",
        );
        const deleted = await stores.auth.deleteProfile(invocation.options.profile);
        const feedCredentialsDeleted = await stores.feed.deleteCredentials(invocation.options.profile);
        emitDetail({
          profile: deleted.profile,
          marketCredentialRecordRemoved: deleted.credentialsDeleted,
          cookieSessionRecordRemoved: deleted.cookieSessionDeleted,
          feedCredentialRecordRemoved: feedCredentialsDeleted,
        }, invocation.options, stdout, {
          command: "cookidoo-axi auth remove",
          next: [renderFollowUpCommand([
            ...commandLiterals(["cookidoo-axi", "auth", "import-env", "--env-file"]),
            commandArgument(".env"),
          ], invocation.options)],
          allowFullCommand: false,
        });
        return 0;
      }
      case "setup-codex": {
        const result = await installCodexIntegration({
          directory: invocation.directory,
          executablePath: executablePath(dependencies),
        });
        emitDetail(result, invocation.options, stdout, {
          command: "cookidoo-axi setup codex",
          allowFullCommand: false,
        });
        return 0;
      }
      case "setup-remove": {
        const result = await removeCodexIntegration({
          directory: invocation.directory,
          ...(invocation.options.confirm === undefined
            ? {}
            : { confirm: invocation.options.confirm }),
        });
        emitDetail(result, invocation.options, stdout, {
          command: "cookidoo-axi setup remove",
          allowFullCommand: false,
        });
        return 0;
      }
      case "operation":
        await executeOperation(invocation, stores, dependencies, stdout);
        return 0;
    }
  } catch (error) {
    const exitCode = errorExitCode(error);
    writeStructuredError(error, stdout, options?.output ?? inferredOutput(argv), exitCode);
    if (options?.debug === true) writeDebugDiagnostic(error, stderr);
    process.exitCode = exitCode;
    return exitCode;
  }
}

async function executeOperation(
  invocation: ParsedOperationInvocation,
  stores: { auth: KeychainAuthStore; feed: FeedCredentialStore },
  dependencies: RunDependencies,
  stdout: TextOutputStream,
): Promise<void> {
  const resolved = await resolveOperationInvocation(invocation, BASE_URL);
  const command = safeCommand(invocation);
  if (resolved.safety.dryRun) {
    emitDetail({
      dryRun: true,
      operationId: invocation.operation.operationId,
      request: resolved.publicRequest,
      safety: {
        classification: resolved.safety.classification,
        allowed: resolved.safety.allowed,
        execute: false,
        authenticationPerformed: false,
        networkPerformed: false,
        confirmationTarget: resolved.safety.confirmationTarget,
        requirements: resolved.safety.requirements,
      },
      reconciliation: resolved.safety.reconciliation,
    }, invocation.options, stdout, {
      command: `${command} --dry-run`,
      next: dryRunNext(invocation, resolved.safety),
      allowFullCommand: hasSafeReproducibleInvocation(invocation),
    });
    return;
  }

  let result: ExecuteHttpResult;
  try {
    result = await (dependencies.httpExecute ?? executeHttp)({
      request: resolved.request,
      operation: invocation.operation as never,
      ...(invocation.operation.method === "GET" && resolved.safety.classification.mutation
        ? { mutationLike: true }
        : {}),
      profile: invocation.options.profile,
      language: invocation.options.lang,
      timeoutMs: invocation.options.timeoutMs,
      authStore: stores.auth,
      basicCredentials: {
        getCredentials: ({ profile, signal }) => stores.feed.loadCredentials(profile, signal),
      },
      ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
    });
  } catch (error) {
    if (!isApiError(error) || resolved.safety.reconciliation === null) throw error;
    const exactCommand = policyReconciliationCommand(
      invocation,
      resolved.safety.reconciliation.authoritativeRead,
      resolved.body,
    );
    throw new ApiError({
      code: error.code,
      message: error.message,
      retrySafe: error.retrySafe,
      outcome: error.outcome,
      ...(error.status === undefined ? {} : { status: error.status }),
      ...(error.reconciliation === undefined ? {} : { reconciliation: error.reconciliation }),
      suggestions: [
        "Do not repeat this mutation automatically.",
        ...(exactCommand === null ? [] : [`Reconcile with: ${exactCommand}`]),
      ],
      details: {
        ...(error.details ?? {}),
        policyReconciliation: {
          strategy: resolved.safety.reconciliation.strategy,
          ambiguity: resolved.safety.reconciliation.ambiguity,
          command: exactCommand,
        },
      },
    });
  }
  const mutation = resolved.safety.classification.mutation;
  try {
    assertProviderResponse(invocation, result);
    const responseContext = {
      operationId: result.operationId,
      status: result.status,
      contentType: result.contentType,
      attempts: result.attempts,
      reauthenticated: result.reauthenticated,
      evidence: invocation.operation.status,
      responseShape: invocation.operation.responseShape,
      request: {
        method: resolved.request.method,
        url: resolved.request.url.toString(),
      },
    };
    const next = responseNext(
      invocation,
      resolved.safety.reconciliation,
      resolved.body,
      result.data,
    );
    const view = collectionView(result.data, invocation.operation.operationId);
    if (view !== undefined) {
      const agentDefault = invocation.options.fields === undefined && !invocation.options.full
        ? defaultCollectionPresentation(
            invocation.operation.operationId,
            view.items,
            invocation.options.maxItems,
          )
        : undefined;
      const defaultFields = agentDefault?.kind === "fields" ? agentDefault.fields : undefined;
      const presentedItems = agentDefault?.items ?? view.items;
      const summaryFullCommand = agentDefault?.kind === "summary" &&
          hasSafeReproducibleInvocation(invocation)
        ? safeCommand({
            ...invocation,
            options: { ...invocation.options, full: true },
          })
        : null;
      const context = {
        ...responseContext,
        upstream: view.envelope,
        ...(agentDefault === undefined ? {} : {
          projection: agentDefault.kind === "fields"
            ? { mode: "agent-default", fields: agentDefault.fields }
            : {
                mode: "agent-default",
                strategy: "per-item-adaptive-summary",
                maxScalarFieldsPerItem: MAX_UNKNOWN_FEED_SUMMARY_FIELDS,
                summarizedItems: Math.min(view.items.length, invocation.options.maxItems),
                sourceFieldsOmitted: true,
                ...(summaryFullCommand === null ? {} : { fullCommand: summaryFullCommand }),
              },
        }),
      };
      const outputNext: readonly NextCommandInput[] = summaryFullCommand === null
        ? next
        : [{
            command: summaryFullCommand,
            description: "Show original feed items without adaptive summaries.",
          }, ...next];
      const envelope = normalizeCollection(presentedItems, {
        command,
        maxItems: invocation.options.maxItems,
        full: invocation.options.full,
        ...(invocation.options.fields !== undefined
          ? { fields: invocation.options.fields }
          : defaultFields === undefined ? {} : { fields: defaultFields }),
        total: view.total,
        hasMore: view.hasMore,
        context,
        next: outputNext,
        allowFullCommand: !mutation && hasSafeReproducibleInvocation(invocation),
      });
      writeOutput(envelope, { format: invocation.options.output, stdout });
      return;
    }
    const value = result.empty && invocation.operation.method !== "GET"
      ? { result: "success", responseBody: null }
      : result.data;
    emitDetail(value, invocation.options, stdout, {
      command,
      context: responseContext,
      next,
      allowFullCommand: !mutation && hasSafeReproducibleInvocation(invocation),
      sourceCompleteness: responseCompleteness(invocation.operation.responseShape),
    });
  } catch (error) {
    if (!mutation || (isApiError(error) && error.outcome === "response-received")) throw error;
    throw mutationResponseFailure(
      invocation,
      result,
      resolved.body,
      resolved.safety.reconciliation,
      error,
    );
  }
}

function createStores(dependencies: RunDependencies): {
  auth: KeychainAuthStore;
  feed: FeedCredentialStore;
} {
  const auth = dependencies.authStore ?? new KeychainAuthStore();
  const feed = dependencies.feedStore ?? new FeedCredentialStore(auth.adapter);
  return { auth, feed };
}

function emitHome(
  options: GlobalOptions,
  executable: string,
  stdout: TextOutputStream,
): void {
  emitDetail({
    tool: "cookidoo-axi",
    version: VERSION,
    platform: "macOS",
    executable: collapseHomePath(executable),
    market: BASE_URL,
    openapiCoverage: { operations: OPENAPI_MANIFEST.operations.length, mapped: 58 },
    output: { default: "toon", maxItems: options.maxItems, stringPreviewCharacters: 500 },
    auth: {
      profile: options.profile,
      state: "not-checked-on-home",
      inspectStoredSessionWith: renderFollowUpCommand(
        commandLiterals(["cookidoo-axi", "auth", "status", "--inspect", "session"]),
        options,
      ),
      verifyWith: profileReadCommand(options),
      storage: "macOS Keychain",
    },
    safety: {
      mutationRetries: "disabled",
      advertisedOnlyMutations: "blocked by default",
      guardedActions: "exact confirmation required",
      dryRun: "auth-free and network-free",
    },
  }, options, stdout, {
    command: renderUtilityCommand([commandLiteral("cookidoo-axi")], options),
    next: [
      renderFollowUpCommand(commandLiterals(["cookidoo-axi", "operation", "list"]), options),
      profileReadCommand(options),
    ],
  });
}

async function emitAuthStatus(
  options: GlobalOptions,
  inspection: AuthStatusInspection,
  auth: KeychainAuthStore,
  feed: FeedCredentialStore,
  stdout: TextOutputStream,
): Promise<void> {
  type RecordName = Exclude<AuthStatusInspection, "none" | "all">;
  type RecordState = "not-checked" | "missing" | "stored-invalid" | "stored-valid" | "stored-unverified";
  const requested: RecordName[] = inspection === "all"
    ? ["market", "session", "feed"]
    : inspection === "none" ? [] : [inspection];
  const states: Record<RecordName, RecordState> = {
    market: "not-checked",
    session: "not-checked",
    feed: "not-checked",
  };
  for (const record of requested) {
    if (record === "market") {
      states.market = await inspectKeychainRecord(
        () => auth.loadCredentials(options.profile),
        "stored-valid",
      );
    } else if (record === "session") {
      states.session = await inspectKeychainRecord(
        () => auth.loadCookieJar(options.profile),
        "stored-unverified",
      );
    } else {
      states.feed = await inspectKeychainRecord(
        () => feed.loadCredentials(options.profile),
        "stored-valid",
      );
    }
  }
  emitDetail({
    profile: options.profile,
    inspection,
    marketCredentialState: states.market,
    cookieSessionState: states.session,
    feedCredentialState: states.feed,
    keychainAccess: requested.length === 0 ? "not-requested" : "explicitly-requested",
    keychainRecordsRead: requested.length,
    promptExpectation: requested.length === 0
      ? "none requested"
      : `macOS policy-dependent; up to ${requested.length} separate item authorizations`,
    sessionVerification: "performed only by a protected read",
    secretValuesReturned: false,
    storage: "macOS Keychain",
  }, options, stdout, {
    command: renderUtilityCommand([
      ...commandLiterals(["cookidoo-axi", "auth", "status"]),
      ...(inspection === "none"
        ? []
        : [commandLiteral("--inspect"), commandArgument(inspection)]),
    ], options),
    next: authStatusNext(options, inspection, states),
  });
}

function authStatusNext(
  options: GlobalOptions,
  inspection: AuthStatusInspection,
  states: Readonly<Record<"market" | "session" | "feed", string>>,
): string[] {
  const profile = () => profileReadCommand(options);
  const status = (record: "session" | "market") => renderFollowUpCommand([
    ...commandLiterals(["cookidoo-axi", "auth", "status", "--inspect"]),
    commandArgument(record),
  ], options);
  if (inspection === "none") {
    return [
      profile(),
      status("session"),
    ];
  }
  if (states.market === "missing" || states.market === "stored-invalid") {
    return [renderFollowUpCommand([
      ...commandLiterals(["cookidoo-axi", "auth", "import-env", "--env-file"]),
      commandArgument(".env"),
    ], options)];
  }
  if (states.session === "stored-unverified") {
    return [profile()];
  }
  if (states.session === "missing") {
    return states.market === "stored-valid"
      ? [renderFollowUpCommand(commandLiterals(["cookidoo-axi", "auth", "login"]), options)]
      : [status("market")];
  }
  if (states.feed === "missing" || states.feed === "stored-invalid") {
    return [renderFollowUpCommand([
      ...commandLiterals(["cookidoo-axi", "auth", "import-feed-env", "--env-file"]),
      commandArgument("./feed.env"),
    ], options)];
  }
  return [profile()];
}

function emitOperationList(
  operations: OperationDescriptor[],
  filter: OperationListFilter,
  options: GlobalOptions,
  stdout: TextOutputStream,
): void {
  const query = filter.query?.toLocaleLowerCase("en-US");
  const completeCatalog = operationCatalog(operations);
  const catalogEntries = completeCatalog.operations as readonly {
    readonly operationId?: unknown;
    readonly risks?: unknown;
    readonly requiresAllowUnverified?: unknown;
    readonly taskCommands?: unknown;
  }[];
  const catalogByOperationId = new Map(
    catalogEntries
      .filter((entry): entry is typeof entry & { readonly operationId: string } =>
        typeof entry.operationId === "string")
      .map((entry) => [entry.operationId, entry]),
  );
  const matching = operations.filter((operation) => {
    if (filter.group !== undefined && operation.command[0] !== filter.group) return false;
    const catalogEntry = catalogByOperationId.get(operation.operationId);
    if (filter.risk !== undefined) {
      if (filter.risk === "unverified") {
        if (catalogEntry?.requiresAllowUnverified !== true) return false;
      } else {
        const expected = filter.risk === "write" ? "private-write" : filter.risk;
        if (!Array.isArray(catalogEntry?.risks) || !catalogEntry.risks.includes(expected)) {
          return false;
        }
      }
    }
    if (query !== undefined) {
      const taskCommands = Array.isArray(catalogEntry?.taskCommands)
        ? catalogEntry.taskCommands.filter((entry): entry is string => typeof entry === "string")
        : [];
      const haystack = [
        operation.operationId,
        operation.command.join(" "),
        ...taskCommands,
        operation.tag,
        operation.summary,
      ]
        .join(" ")
        .toLocaleLowerCase("en-US");
      if (!haystack.includes(query)) return false;
    }
    return true;
  });
  const catalog = operationCatalog(matching);
  const items = catalog.operations as unknown[];
  const commandTokens: CommandToken[] = commandLiterals(["cookidoo-axi", "operation", "list"]);
  if (filter.group !== undefined) {
    commandTokens.push(commandLiteral("--group"), commandArgument(filter.group));
  }
  if (filter.risk !== undefined) {
    commandTokens.push(commandLiteral("--risk"), commandArgument(filter.risk));
  }
  if (filter.query !== undefined) {
    commandTokens.push(commandLiteral("--query"), commandArgument(filter.query));
  }
  const envelope = normalizeCollection(items, {
    command: renderUtilityCommand(commandTokens, options),
    maxItems: options.maxItems,
    full: options.full,
    ...(options.fields !== undefined
      ? { fields: options.fields }
      : options.full ? {} : { fields: [
          "operationId",
          "command",
          "taskCommands",
          "method",
          "auth",
          "risk",
          "risks",
          "requiresAllowUnverified",
          "summary",
        ] }),
    total: matching.length,
    hasMore: false,
    context: {
      coverage: catalog.coverage,
      source: catalog.source,
      availableOperations: operations.length,
      matchedOperations: matching.length,
      filter,
    },
    next: matching[0] === undefined ? [] : [renderFollowUpCommand([
        ...commandLiterals(["cookidoo-axi", "operation", "describe"]),
        commandArgument(matching[0].operationId),
      ], options)],
  });
  writeOutput(envelope, { format: options.output, stdout });
}

function emitDetail(
  value: unknown,
  options: GlobalOptions,
  stdout: TextOutputStream,
  input: {
    command: string;
    context?: unknown;
    next?: readonly NextCommandInput[];
    allowFullCommand?: boolean;
    sourceCompleteness?: "complete" | "partial" | "unknown";
  },
): void {
  const envelope = normalizeDetail(value, {
    command: input.command,
    full: options.full,
    maxItems: options.maxItems,
    ...(options.fields === undefined ? {} : { fields: options.fields }),
    ...(input.context === undefined ? {} : { context: input.context }),
    ...(input.next === undefined ? {} : { next: input.next }),
    ...(input.allowFullCommand === undefined
      ? {}
      : { allowFullCommand: input.allowFullCommand }),
    ...(input.sourceCompleteness === undefined
      ? {}
      : { sourceCompleteness: input.sourceCompleteness }),
  });
  writeOutput(envelope, { format: options.output, stdout });
}

function dryRunNext(
  invocation: ParsedOperationInvocation,
  safety: {
    allowed: boolean;
    confirmationTarget: string | null;
    classification: { requiresConfirmation: boolean };
    requirements: readonly { code: string; satisfied: boolean }[];
  },
): NextCommandInput[] {
  const next: NextCommandInput[] = [{
    command: renderFollowUpCommand([
      ...commandLiterals(["cookidoo-axi", "operation", "describe"]),
      commandArgument(invocation.operation.operationId),
    ], invocation.options),
    description: "Inspect the generated contract and safety metadata.",
  }];
  if (!hasSafeReproducibleInvocation(invocation)) return next;
  if (
    invocation.options.target !== undefined &&
    safety.confirmationTarget !== null &&
    invocation.options.target !== safety.confirmationTarget
  ) {
    // The dry-run plan already explains the target mismatch. Re-emitting the
    // conflicting explicit target with the derived confirmation would produce
    // a command that is guaranteed to fail before dispatch.
    return next;
  }
  let executeCommand = safeCommand(invocation);
  if (safety.requirements.some((item) => item.code === "allow-unverified" && !item.satisfied)) {
    executeCommand += " --allow-unverified";
  }
  if (safety.classification.requiresConfirmation && safety.confirmationTarget !== null) {
    next.push({
      command: `${executeCommand} --confirm ${quotePosixArgument(safety.confirmationTarget)}`,
      description: "Execute with the exact derived confirmation target.",
    });
  } else if (safety.allowed || safety.requirements.every((item) => item.code === "allow-unverified")) {
    next.push({
      command: executeCommand,
      description: "Execute the validated request once without automatic mutation retries.",
    });
  }
  return next;
}

function assertProviderResponse(
  invocation: ParsedOperationInvocation,
  result: ExecuteHttpResult,
): void {
  const validation = validateResponse(
    invocation.operation.operationId,
    result.status,
    result.data,
    { contentType: result.contentType, empty: result.empty },
  );
  if (validation.ok) return;
  throw new OperationalError({
    code: "RESPONSE_CONTRACT_MISMATCH",
    message: `The response for ${validation.operationId} does not match its generated OpenAPI contract.`,
    suggestion: "Do not infer missing fields or repeat a mutation; inspect the safe contract issues.",
    details: {
      operationId: validation.operationId,
      status: validation.status,
      contentType: result.contentType,
      issues: validation.issues,
    },
  });
}

function mutationResponseFailure(
  invocation: ParsedOperationInvocation,
  result: ExecuteHttpResult,
  body: unknown,
  reconciliation: ReconciliationGuidance | null,
  cause: unknown,
): ApiError {
  const contractMismatch = isCliError(cause) && cause.code === "RESPONSE_CONTRACT_MISMATCH";
  const command = reconciliation === null
    ? null
    : policyReconciliationCommand(invocation, reconciliation.authoritativeRead, body, result.data);
  return new ApiError({
    code: contractMismatch ? "RESPONSE_CONTRACT_MISMATCH" : "MUTATION_RESPONSE_PRESENTATION_FAILED",
    message: contractMismatch
      ? `The ${invocation.operation.operationId} mutation returned a response that does not match its generated contract.`
      : `The ${invocation.operation.operationId} mutation returned a response, but the result could not be safely presented.`,
    retrySafe: false,
    outcome: "response-received",
    status: result.status,
    suggestions: [
      "Do not repeat this mutation automatically.",
      ...(command === null ? [] : [`Reconcile with: ${command}`]),
    ],
    details: {
      operationId: invocation.operation.operationId,
      causeCode: isCliError(cause) || cause instanceof OutputBoundaryError
        ? cause.code : "INTERNAL_OUTPUT_FAILURE",
      ...(contractMismatch && isCliError(cause) && cause.details !== undefined
        ? { contract: cause.details }
        : {}),
      policyReconciliation: reconciliation === null ? null : {
        strategy: reconciliation.strategy,
        ambiguity: reconciliation.ambiguity,
        command,
      },
    },
  });
}

function responseNext(
  invocation: ParsedOperationInvocation,
  reconciliation: ReconciliationGuidance | null,
  body: unknown,
  data: unknown,
): NextCommandInput[] {
  const next: NextCommandInput[] = [];
  if (reconciliation !== null) {
    const command = policyReconciliationCommand(
      invocation,
      reconciliation.authoritativeRead,
      body,
      data,
    );
    if (command !== null) {
      next.push({ command, description: reconciliation.strategy });
    }
  } else {
    const itemCommand = collectionItemCommand(invocation, data);
    if (itemCommand !== null) {
      next.push({
        command: itemCommand,
        description: "Read the first returned resource by its exact provider ID.",
      });
    }
  }
  if (
    invocation.operation.responseShape !== "typed" ||
    !["observed", "corroborated"].includes(invocation.operation.status)
  ) {
    next.push({
      command: renderFollowUpCommand([
        ...commandLiterals(["cookidoo-axi", "operation", "describe"]),
        commandArgument(invocation.operation.operationId),
      ], invocation.options),
      description: "Inspect this operation's partial or uncertain response contract.",
    });
  }
  return next;
}

function collectionItemCommand(
  invocation: ParsedOperationInvocation,
  data: unknown,
): string | null {
  const first = collectionView(data, invocation.operation.operationId)?.items[0];
  const operationId = invocation.operation.operationId;
  if (first === undefined) return null;
  if (["getRecipeCluster", "getRecipeClusterV2"].includes(operationId)) {
    const id = nestedString(first, [["recipe_id"]]);
    return id !== undefined && /^r[0-9]+$/u.test(id)
      ? renderFollowUpCommand([
          ...commandLiterals(["cookidoo-axi", "recipe", "get"]), commandArgument(id),
        ], invocation.options) : null;
  }
  if (["search", "searchStripe"].includes(operationId)) {
    const id = nestedString(first, [["id"], ["objectID"]]);
    return id !== undefined && /^r[0-9]+$/u.test(id)
      ? renderFollowUpCommand([
          ...commandLiterals(["cookidoo-axi", "recipe", "get"]), commandArgument(id),
        ], invocation.options) : null;
  }
  if (operationId === "listCreatedRecipes") {
    const id = nestedString(first, [["recipeId"]]);
    return id !== undefined && /^[0-9A-HJKMNP-TV-Z]{26}$/iu.test(id)
      ? renderFollowUpCommand([
          ...commandLiterals(["cookidoo-axi", "created", "get"]), commandArgument(id),
        ], invocation.options) : null;
  }
  if (operationId === "listCustomLists") {
    const id = nestedString(first, [["id"]]);
    return id === undefined ? null : renderFollowUpCommand([
      ...commandLiterals(["cookidoo-axi", "organize", "custom-list", "get"]),
      commandArgument(id),
    ], invocation.options);
  }
  return null;
}

function authoritativeReadCommand(
  invocation: ParsedOperationInvocation,
  command: readonly string[],
  body: unknown,
  data?: unknown,
): string | null {
  const joined = command.join(" ");
  const path = invocation.path;
  if (joined === "created list") {
    return renderFollowUpCommand(commandLiterals(["cookidoo-axi", "created", "list"]), invocation.options);
  }
  if (joined === "created get") {
    const id = usableArgument(path.customerRecipeId) ?? nestedString(data, [
      ["recipeId"], ["id"], ["content", "recipeId"], ["content", "id"],
    ]);
    return id === undefined
      ? renderFollowUpCommand(commandLiterals(["cookidoo-axi", "created", "list"]), invocation.options)
      : renderFollowUpCommand([
          ...commandLiterals(["cookidoo-axi", "created", "get"]), commandArgument(id),
        ], invocation.options);
  }
  if (joined === "organize custom-list get") {
    const record = asRecord(body);
    const id = usableArgument(path.listId) ?? nestedString(data, [
      ["id"], ["listId"], ["content", "id"], ["content", "listId"],
    ]) ?? usableArgument(record?.targetListId) ?? usableArgument(record?.srcListId);
    return id === undefined
      ? renderFollowUpCommand(
          commandLiterals(["cookidoo-axi", "organize", "custom-list", "list"]),
          invocation.options,
        )
      : renderFollowUpCommand([
          ...commandLiterals(["cookidoo-axi", "organize", "custom-list", "get"]),
          commandArgument(id),
        ], invocation.options);
  }
  if (joined === "organize managed-list list") {
    return renderFollowUpCommand(
      commandLiterals(["cookidoo-axi", "organize", "managed-list", "list"]),
      invocation.options,
    );
  }
  if (joined === "organize shared-list get") {
    const id = usableArgument(path.sharedListId) ?? nestedString(data, [
      ["sharedListId"], ["id"], ["content", "sharedListId"], ["content", "id"],
    ]);
    return id === undefined
      ? null
      : renderFollowUpCommand([
          ...commandLiterals(["cookidoo-axi", "organize", "shared-list", "get"]),
          commandArgument(id),
        ], invocation.options);
  }
  if (joined === "planning week") {
    const record = asRecord(body);
    const day = [path.dayKey, record?.dayKey, record?.targetDayKey, record?.sourceDayKey]
      .map(usableArgument)
      .find((value) => value !== undefined && /^\d{4}-\d{2}-\d{2}$/u.test(value));
    return day === undefined ? null : renderFollowUpCommand([
      ...commandLiterals(["cookidoo-axi", "planning", "week"]), commandArgument(day),
    ], invocation.options);
  }
  if (joined === "shopping show") {
    return renderFollowUpCommand(commandLiterals(["cookidoo-axi", "shopping", "show"]), invocation.options);
  }
  if (joined === "note get") {
    const id = usableArgument(path.recipeId) ?? usableArgument(asRecord(body)?.recipeId);
    return id === undefined ? null : renderFollowUpCommand([
      ...commandLiterals(["cookidoo-axi", "note", "get"]), commandArgument(id),
    ], invocation.options);
  }
  return null;
}

function policyReconciliationCommand(
  invocation: ParsedOperationInvocation,
  command: readonly string[] | null,
  body: unknown,
  data?: unknown,
): string | null {
  if (command === null) return null;
  return authoritativeReadCommand(invocation, command, body, data);
}

function requireExactConfirmation(
  supplied: string | undefined,
  expected: string,
  action: string,
): void {
  if (supplied !== expected) {
    throw new UsageError(
      "CONFIRMATION_MISMATCH",
      `${action} requires --confirm ${expected}`,
      { suggestions: [`Repeat with --confirm ${expected}`] },
    );
  }
}

async function assertCredentialImportAllowed(
  store: { loadCredentials(profile: string): Promise<unknown | undefined> },
  profile: string,
  confirmation: string | undefined,
  kind: "market" | "feed",
): Promise<boolean> {
  let exists: boolean;
  try {
    exists = (await store.loadCredentials(profile)) !== undefined;
  } catch (error) {
    if (error instanceof AuthError && error.code === "KEYCHAIN_DATA_INVALID") exists = true;
    else throw error;
  }
  if (!exists) return false;
  const expected = `replace:${kind}:${profile}`;
  if (confirmation !== expected) {
    throw new UsageError(
      "CREDENTIAL_REPLACEMENT_CONFIRMATION_REQUIRED",
      `The ${kind} credential record already exists; replacement requires --confirm ${expected}`,
      { suggestions: [`Use a different --profile or repeat with --confirm ${expected}`] },
    );
  }
  return true;
}

async function inspectKeychainRecord(
  load: () => Promise<unknown | undefined>,
  presentState: "stored-valid" | "stored-unverified",
): Promise<"missing" | "stored-invalid" | typeof presentState> {
  try {
    return (await load()) === undefined ? "missing" : presentState;
  } catch (error) {
    if (error instanceof AuthError && error.code === "KEYCHAIN_DATA_INVALID") {
      return "stored-invalid";
    }
    throw error;
  }
}

function writeStructuredError(
  error: unknown,
  stdout: TextOutputStream,
  format: "toon" | "json",
  exitCode: 1 | 2,
): void {
  const code = errorCode(error);
  const known = isCliError(error) || error instanceof AuthError || error instanceof OutputBoundaryError;
  const message = known && error instanceof Error
    ? sanitizeDiagnostic(error.message)
    : "Unexpected internal failure";
  const suggestions = errorSuggestions(error).map(sanitizeDiagnostic);
  const details = isCliError(error) ? error.details : undefined;
  const data = {
    error: {
      code,
      message,
      category: exitCode === 2 ? "usage" : error instanceof AuthError ? "authentication" : "operational",
      exitCode,
      ...(isApiError(error) ? {
        retrySafe: error.retrySafe,
        outcome: error.outcome,
      } : {}),
      ...(suggestions.length === 0 ? {} : { suggestions }),
      ...(details === undefined ? {} : { details }),
    },
  };
  try {
    const envelope = normalizeDetail(data, {
      command: "cookidoo-axi",
      maxItems: 20,
      allowFullCommand: false,
    });
    writeOutput(envelope, { format, stdout });
  } catch {
    const fallback = JSON.stringify({
      error: { code, message, exitCode },
      kind: "error",
    });
    stdout.write(`${fallback}\n`);
  }
}

function writeDebugDiagnostic(error: unknown, stderr: TextOutputStream): void {
  const known = isCliError(error) || error instanceof AuthError || error instanceof OutputBoundaryError;
  if (!known || !(error instanceof Error)) {
    stderr.write("INTERNAL_ERROR: diagnostic suppressed\n");
    return;
  }
  stderr.write(`${sanitizeDiagnostic(error.stack ?? error.message)}\n`);
}

function errorExitCode(error: unknown): 1 | 2 {
  if (isCliError(error)) return error.exitCode;
  if (error instanceof AuthError || error instanceof OutputBoundaryError) return 1;
  return 1;
}

function errorCode(error: unknown): string {
  if (isCliError(error) || error instanceof AuthError ||
      error instanceof OutputBoundaryError) return error.code;
  return "INTERNAL_ERROR";
}

function errorSuggestions(error: unknown): string[] {
  if (isCliError(error)) return [...error.suggestions];
  if (error instanceof AuthError && error.suggestion !== undefined) return [error.suggestion];
  return [];
}

function inferredOutput(argv: readonly string[]): "toon" | "json" {
  for (let index = 0; index < argv.length - 1; index += 1) {
    if (argv[index] === "--output" && argv[index + 1] === "json") return "json";
  }
  return "toon";
}

function writeText(value: string, stdout: TextOutputStream): void {
  stdout.write(`${value}\n`);
}

function executablePath(dependencies: RunDependencies): string {
  return resolve(dependencies.executablePath ?? process.argv[1] ?? "cookidoo-axi");
}

function nestedString(
  value: unknown,
  paths: readonly (readonly string[])[],
): string | undefined {
  for (const path of paths) {
    let current = value;
    for (const segment of path) {
      if (!isObject(current)) {
        current = undefined;
        break;
      }
      current = current[segment];
    }
    const candidate = usableArgument(current);
    if (candidate !== undefined) return candidate;
  }
  return undefined;
}

function usableArgument(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 512 &&
    !/[\p{Cc}\p{Cs}]/u.test(value)
    ? value : undefined;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return isObject(value) ? value : undefined;
}

function responseCompleteness(shape: string): "complete" | "partial" | "unknown" {
  return shape === "typed" ? "complete" : shape === "partial" ? "partial" : "unknown";
}

const UNKNOWN_FEED_OPERATIONS = new Set([
  "bootstrapCollectionFeed",
  "getCollectionFeed",
  "getCollectionFeedPage",
]);
const MAX_UNKNOWN_FEED_SUMMARY_FIELDS = 4;
const MAX_UNKNOWN_FEED_KEYS_INSPECTED = 64;

type AgentDefaultCollectionPresentation =
  | {
      readonly kind: "fields";
      readonly items: readonly unknown[];
      readonly fields: readonly string[];
    }
  | {
      readonly kind: "summary";
      readonly items: readonly unknown[];
    };

function defaultCollectionPresentation(
  operationId: string,
  items: readonly unknown[],
  maxItems: number,
): AgentDefaultCollectionPresentation | undefined {
  const projections: Readonly<Record<string, readonly string[]>> = {
    getRecipeCluster: ["recipe_id", "notation", "quantity", "types"],
    getRecipeClusterV2: ["recipe_id", "languageTag", "notation", "quantity", "types"],
    search: ["id", "objectID", "title", "totalTime", "rating", "numberOfRatings"],
    searchStripe: ["id", "objectID", "title", "totalTime", "rating", "numberOfRatings"],
    searchIngredients: ["title", "highlighted", "occurrencesInRecipes"],
    listCreatedRecipes: [
      "recipeId", "name", "recipeContent.name", "status", "workStatus", "modifiedAt",
    ],
    listCustomLists: ["id", "title", "listType"],
    listManagedLists: ["id", "title", "listType"],
    listSubscriptions: ["active", "expires", "status", "level", "type", "extendedType"],
  };
  const fixed = projections[operationId];
  if (fixed !== undefined) return { kind: "fields", items, fields: fixed };
  if (!UNKNOWN_FEED_OPERATIONS.has(operationId)) return undefined;
  const shown = Math.min(items.length, maxItems);
  return {
    kind: "summary",
    items: [
      ...items.slice(0, shown).map(adaptiveUnknownFeedItemSummary),
      ...Array.from({ length: items.length - shown }, () => null),
    ],
  };
}

/**
 * Feed items are intentionally UnknownJson in the partial upstream contract.
 * Summarize every item which the local limit will show rather than guessing a
 * page-global provider schema. Dynamic field names never enter output context.
 */
function adaptiveUnknownFeedItemSummary(item: unknown): unknown {
  if (Array.isArray(item)) {
    return { summary: "array", itemCount: item.length, content: "structure-only" };
  }
  if (!isObject(item)) {
    if (isSafeSummaryScalar(item)) return { summary: typeof item, value: item };
    return { summary: item === null ? "null" : typeof item, content: "omitted" };
  }

  const candidates: Array<{
    readonly path: readonly string[];
    readonly value: string | number | boolean;
    readonly rank: number;
    readonly order: number;
  }> = [];
  let inspected = 0;
  let order = 0;

  const inspect = (value: Readonly<Record<string, unknown>>, prefix: readonly string[]): void => {
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) return;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const name of Object.keys(value)) {
      if (inspected >= MAX_UNKNOWN_FEED_KEYS_INSPECTED) return;
      inspected += 1;
      const descriptor = descriptors[name];
      if (descriptor === undefined || !("value" in descriptor) || !isSafeSummaryKey(name)) continue;
      const path = [...prefix, name];
      const candidate = descriptor.value;
      if (isSafeSummaryScalar(candidate)) {
        candidates.push({
          path,
          value: candidate,
          rank: adaptiveFieldRank(name),
          order: order++,
        });
      } else if (prefix.length === 0 && isObject(candidate)) {
        inspect(candidate, path);
      }
    }
  };
  inspect(item, []);

  const selected = candidates
    .sort((left, right) =>
      left.rank - right.rank || left.path.length - right.path.length || left.order - right.order)
    .slice(0, MAX_UNKNOWN_FEED_SUMMARY_FIELDS);
  if (selected.length === 0) {
    const descriptors = Object.getOwnPropertyDescriptors(item);
    return {
      summary: "object",
      propertyCount: Object.keys(descriptors).length,
      content: "structure-only",
    };
  }

  const summary = createJsonObject();
  for (const candidate of selected) setSummaryValue(summary, candidate.path, candidate.value);
  return summary;
}

function setSummaryValue(
  output: Record<string, unknown>,
  path: readonly string[],
  value: string | number | boolean,
): void {
  let current = output;
  for (const [index, name] of path.entries()) {
    if (index === path.length - 1) {
      current[name] = value;
      return;
    }
    const existing = current[name];
    if (isObject(existing)) {
      current = existing;
      continue;
    }
    const child = createJsonObject();
    current[name] = child;
    current = child;
  }
}

function isSafeSummaryKey(name: string): boolean {
  if (name.length === 0 || name.length > 64 || /[\p{Cc}\p{Cs}]/u.test(name)) return false;
  if (["__proto__", "prototype", "constructor"].includes(name)) return false;
  return !isSensitiveName(name) && !containsCredentialLikeText(`${name}=fixture`);
}

function isSafeSummaryScalar(value: unknown): value is string | number | boolean {
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "boolean") return true;
  if (typeof value !== "string" || /[\p{Cs}]/u.test(value)) return false;
  return !containsCredentialLikeText(value);
}

function adaptiveFieldRank(name: string): number {
  const normalized = name.toLowerCase().replaceAll(/[^a-z0-9]/gu, "");
  if (normalized === "id" || normalized === "ulid"
      || /(?:Id|ID|Ulid|ULID)$/u.test(name)
      || /(?:^|[_-])(?:id|ulid)$/iu.test(name)) return 0;
  if (["type", "kind", "collection", "category"].includes(normalized)) return 1;
  if (["title", "name", "status", "event", "action", "operation"].includes(normalized)
      || normalized.endsWith("at") || normalized.includes("timestamp")) return 2;
  return 3;
}

function hasSafeReproducibleInvocation(invocation: ParsedOperationInvocation): boolean {
  if (!hasReproducibleBody(invocation)) return false;
  const values = [
    ...Object.entries(invocation.path),
    ...Object.entries(invocation.query),
    ...invocation.filters.map(({ key, value }) => [key, value] as const),
    ...invocation.bodyFields.map(({ path, value }) => [path, value] as const),
    ...(invocation.bodyInput === undefined
      ? []
      : [["bodyInput", invocation.bodyInput] as const]),
    ...(invocation.options.target === undefined
      ? []
      : [["target", invocation.options.target] as const]),
  ];
  if (!values.every(([key, value]) => {
    const text = String(value);
    return !isSensitiveName(key) && !/[\p{Cc}\p{Cs}]/u.test(text) &&
      !containsCredentialLikeText(text);
  })) return false;
  return safeCommand(invocation).length <= 1_024;
}

function isSensitiveName(value: string): boolean {
  const normalized = value.toLowerCase().replaceAll(/[^a-z0-9]/gu, "");
  return /(?:authorization|password|passwd|credential|secret|privatekey|apikey|cookie|sessionid|token)$/u
    .test(normalized);
}

function renderUtilityCommand(tokens: readonly CommandToken[], options: GlobalOptions): string {
  return renderContextualCommand(tokens, options, { full: true });
}

function renderFollowUpCommand(tokens: readonly CommandToken[], options: GlobalOptions): string {
  return renderContextualCommand(tokens, options, {
    maxItems: false,
    fields: false,
    full: false,
  });
}

function profileReadCommand(options: GlobalOptions): string {
  return renderFollowUpCommand(
    commandLiterals(["cookidoo-axi", "profile", "get-localized"]),
    options,
  );
}

function collapseHomePath(value: string): string {
  const home = homedir().replace(/\/$/u, "");
  if (value === home) return "~";
  return value.startsWith(`${home}/`) ? `~/${value.slice(home.length + 1)}` : value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
