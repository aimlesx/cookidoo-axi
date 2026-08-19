import type { CliErrorInit } from "../errors.js";
import { OperationalError } from "../errors.js";

export type ApiOutcome =
  | "not-dispatched"
  | "unknown"
  | "response-received";

export interface ReconciliationMetadata {
  readonly required: boolean;
  readonly operationId: string;
  readonly method: string;
  readonly resourcePath: string;
  readonly guidance: string;
}

export interface ApiErrorInit extends CliErrorInit {
  readonly status?: number;
  readonly retrySafe: boolean;
  readonly outcome: ApiOutcome;
  readonly reconciliation?: ReconciliationMetadata;
}

/**
 * A sanitized transport error suitable for structured CLI output.
 *
 * Provider bodies, HTML, response status text, request headers, cookies,
 * credentials, and native error messages must never be placed in this error.
 */
export class ApiError extends OperationalError {
  readonly status: number | undefined;
  readonly retrySafe: boolean;
  readonly outcome: ApiOutcome;
  readonly reconciliation: ReconciliationMetadata | undefined;

  constructor(init: ApiErrorInit) {
    const details = {
      ...(init.details ?? {}),
      outcome: init.outcome,
      retrySafe: init.retrySafe,
      ...(init.status === undefined ? {} : { status: init.status }),
      ...(init.reconciliation === undefined
        ? {}
        : { reconciliation: init.reconciliation }),
    };
    super({
      code: init.code,
      message: init.message,
      ...(init.suggestion === undefined ? {} : { suggestion: init.suggestion }),
      ...(init.suggestions === undefined ? {} : { suggestions: init.suggestions }),
      details,
    });
    this.name = "ApiError";
    this.status = init.status;
    this.retrySafe = init.retrySafe;
    this.outcome = init.outcome;
    this.reconciliation = init.reconciliation;
  }
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}
