export type BrowserSiloErrorCode =
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "INVALID_REQUEST"
  | "PROFILE_LEASE_CONFLICT"
  | "STALE_FENCE"
  | "CAPACITY_EXHAUSTED"
  | "IDEMPOTENCY_CONFLICT"
  | "LEASE_NOT_ACTIVE"
  | "FEATURE_NOT_AVAILABLE"
  | "BROWSER_START_FAILED"
  | "BROWSER_COMMAND_FAILED"
  | "EVENT_REPLAY_EXPIRED"
  | "TAKEOVER_CONFLICT"
  | "HUMAN_TAKEOVER_ACTIVE";

export class BrowserSiloError extends Error {
  readonly code: BrowserSiloErrorCode;
  readonly status: number;
  readonly details: Record<string, string | number | boolean | null>;

  constructor(
    code: BrowserSiloErrorCode,
    message: string,
    status: number,
    details: Record<string, string | number | boolean | null> = {},
  ) {
    super(message);
    this.name = "BrowserSiloError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}
