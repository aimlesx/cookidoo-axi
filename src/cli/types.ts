export type OutputFormat = "toon" | "json";

export interface ParameterDescriptor {
  name: string;
  in: "path" | "query" | "header" | "cookie";
  required: boolean;
  description?: string;
  schema: Record<string, unknown>;
}

export interface OperationDescriptor {
  operationId: string;
  command: string[];
  tag: string;
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  summary: string;
  description?: string;
  parameters: ParameterDescriptor[];
  requestBody: null | {
    required: boolean;
    content: Record<string, {
      schema: Record<string, unknown>;
      bodyProperties: Record<string, Record<string, unknown>>;
      example?: unknown;
    }>;
  };
  responses: Record<string, unknown>;
  security: "public" | "cookie" | "basic" | "none";
  status: string;
  responseShape: string;
  risk: {
    effect: string;
    destructive: boolean;
    externallyVisible: boolean;
    exercised: boolean;
  };
}

export interface GlobalOptions {
  output: OutputFormat;
  profile: string;
  lang: string;
  timeoutMs: number;
  fields?: string[];
  maxItems: number;
  full: boolean;
  dryRun: boolean;
  confirm?: string;
  target?: string;
  allowUnverified: boolean;
  debug: boolean;
}

export type AuthStatusInspection = "none" | "session" | "market" | "feed" | "all";

export interface OperationListFilter {
  readonly group?: string;
  readonly risk?: "read" | "write" | "destructive" | "external" | "device" | "unverified";
  readonly query?: string;
}

export interface ParsedOperationInvocation {
  kind: "operation";
  operation: OperationDescriptor;
  rawOperation: boolean;
  operationMode?: "created-edit" | "created-publish" | "created-unpublish" | "created-import";
  pageBeforeUnit?: "seconds" | "milliseconds";
  path: Record<string, string>;
  query: Record<string, string | number | boolean>;
  headers: Record<string, string>;
  bodyInput?: string;
  bodyFields: Array<{
    path: string;
    value: string;
    array: boolean;
    schema?: Record<string, unknown>;
    flag?: string;
  }>;
  filters: Array<{ key: string; value: string }>;
  options: GlobalOptions;
}

export type ParsedInvocation =
  | ParsedOperationInvocation
  | { kind: "home"; options: GlobalOptions }
  | { kind: "root-help"; options: GlobalOptions }
  | { kind: "group-help"; group: string[]; options: GlobalOptions }
  | { kind: "operation-help"; operation: OperationDescriptor; options: GlobalOptions }
  | { kind: "operation-list"; filter: OperationListFilter; options: GlobalOptions }
  | { kind: "operation-describe"; operationId: string; options: GlobalOptions }
  | { kind: "auth-doctor"; options: GlobalOptions }
  | { kind: "auth-status"; inspection: AuthStatusInspection; options: GlobalOptions }
  | { kind: "auth-import-env"; envFile: string; options: GlobalOptions }
  | { kind: "auth-import-feed-env"; envFile: string; options: GlobalOptions }
  | { kind: "auth-login"; options: GlobalOptions }
  | { kind: "auth-remove"; options: GlobalOptions }
  | { kind: "auth-clear-session"; options: GlobalOptions }
  | { kind: "setup-codex"; directory: string; options: GlobalOptions }
  | { kind: "setup-remove"; directory: string; options: GlobalOptions }
  | { kind: "hook-session-start"; options: GlobalOptions };
