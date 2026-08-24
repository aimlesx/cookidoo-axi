export type AuthErrorCode =
  | "UNSUPPORTED_PLATFORM"
  | "INVALID_PROFILE"
  | "KEYCHAIN_SANDBOXED"
  | "KEYCHAIN_UNAVAILABLE"
  | "KEYCHAIN_READ_FAILED"
  | "KEYCHAIN_WRITE_FAILED"
  | "KEYCHAIN_DELETE_FAILED"
  | "KEYCHAIN_DATA_INVALID"
  | "CREDENTIALS_NOT_FOUND"
  | "SESSION_NOT_FOUND"
  | "ENV_FILE_UNSAFE"
  | "ENV_FILE_INVALID"
  | "ENV_CREDENTIALS_MISSING"
  | "LOGIN_INPUT_INVALID"
  | "LOGIN_PAGE_FAILED"
  | "LOGIN_FORM_INVALID"
  | "LOGIN_HOST_REJECTED"
  | "LOGIN_SUBMISSION_FAILED"
  | "LOGIN_VERIFICATION_FAILED"
  | "LOGIN_NETWORK_FAILED"
  | "LOGIN_TIMEOUT";

export interface AuthErrorInit {
  readonly code: AuthErrorCode;
  readonly message: string;
  readonly suggestion?: string;
}

/**
 * An intentionally sanitized authentication error.
 *
 * Provider response bodies, HTML, secret values, and native Keychain error
 * messages must never be copied into this error. Callers can safely serialize
 * `toJSON()` to the CLI's structured error output.
 */
export class AuthError extends Error {
  readonly code: AuthErrorCode;
  readonly suggestion: string | undefined;

  constructor(init: AuthErrorInit) {
    super(init.message);
    this.name = "AuthError";
    this.code = init.code;
    this.suggestion = init.suggestion;
  }

  toJSON(): { code: AuthErrorCode; message: string; suggestion?: string } {
    if (this.suggestion === undefined) {
      return { code: this.code, message: this.message };
    }
    return {
      code: this.code,
      message: this.message,
      suggestion: this.suggestion,
    };
  }
}

export function isAuthError(value: unknown): value is AuthError {
  return value instanceof AuthError;
}
