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
  | "pairing_canceled"
  /** The FF1 refused to issue a display grant (`display_grant_unavailable`, no relay v2 endpoint): it needs an FF OS update. */
  | "device_unsupported"
  /**
   * The FF1 no longer knows this grant (factory reset or eviction), or the
   * legacy relayer has no FF1 for this session (`1003`: an FF1 updated to FF
   * OS with display grants, or one that is off); the visitor decides whether
   * to pair again.
   */
  | "device_unrecognized"
  /** IndexedDB (or, for a relayer session, `localStorage`) is unavailable, so the pairing cannot be kept. */
  | "storage_unavailable"
  /** The FF1 holds as many paired sites as it allows; the owner removes one first. */
  | "too_many_sites";

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
