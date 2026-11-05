/**
 * Stable, matchable error codes for integrators.
 *
 * `error.code` is the contract: match on it, not on message text. Messages
 * stay human-readable and may change between versions; codes do not.
 */
export type DisplayErrorCode =
  | "pairing_code_expired"
  | "mint_rejected"
  | "approval_timeout"
  | "session_rejected"
  | "display_failed"
  | "display_rejected"
  | "pairing_canceled";

export class DisplayError extends Error {
  readonly code: DisplayErrorCode | undefined;

  constructor(message: string, code?: DisplayErrorCode) {
    super(message);
    this.name = "DisplayError";
    this.code = code;
  }
}

/** @deprecated Renamed to `DisplayErrorCode` with the move from `@feralfile/play`; removed in 0.6.0. */
export type PlayErrorCode = DisplayErrorCode;

/**
 * @deprecated Renamed to `DisplayError` with the move from `@feralfile/play`;
 * removed in 0.6.0. It is the same class, so
 * `error instanceof PlayError` still matches every error the library throws.
 */
export const PlayError = DisplayError;
/** @deprecated Renamed to `DisplayError`; removed in 0.6.0. */
export type PlayError = DisplayError;
