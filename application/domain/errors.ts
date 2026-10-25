export type ErrorCategory =
  | "validation"
  | "authorization"
  | "authentication"
  | "conflict"
  | "identity_mismatch"
  | "unavailable"
  | "unsupported"
  | "requirements_not_met"
  | "timeout"
  | "provider_failure";

export type RetryKind =
  | "read_only_retry"
  | "same_operation_if_deduplicated"
  | "reconcile_first"
  | "manual_action"
  | "never";

export type HubErrorData = {
  readonly code: string;
  readonly category: ErrorCategory;
  readonly message: string;
  readonly retry: RetryKind;
  readonly details?: Readonly<Record<string, string | number | boolean | null>> | undefined;
};

export class HubError extends Error {
  readonly data: HubErrorData;

  constructor(data: HubErrorData) {
    super(data.message);
    this.name = "HubError";
    this.data = data;
  }
}

export const conflict = (code: string, message: string): HubError =>
  new HubError({ code, category: "conflict", message, retry: "manual_action" });

export const forbidden = (message: string): HubError =>
  new HubError({
    code: "forbidden",
    category: "authorization",
    message,
    retry: "never",
  });

export const invalid = (code: string, message: string): HubError =>
  new HubError({ code, category: "validation", message, retry: "never" });

export const unsupported = (code: string, message: string): HubError =>
  new HubError({ code, category: "unsupported", message, retry: "never" });
