/**
 * Stable, matchable error codes for integrators.
 *
 * `error.code` is the contract: match on it, not on message text. Messages
 * stay human-readable and may change between versions; codes do not.
 */
export type PlayErrorCode =
  | "pairing_code_expired"
  | "mint_rejected"
  | "approval_timeout"
  | "session_rejected"
  | "display_failed"
  | "display_rejected"
  | "pairing_canceled"
  /** The FF1 answered with a session instead of a display grant: it needs an FF OS update. */
  | "device_unsupported"
  /** The FF1 no longer knows this grant (factory reset or eviction); the visitor decides whether to pair again. */
  | "device_unrecognized"
  /** IndexedDB is unavailable, so the grant and its keys cannot be kept. */
  | "storage_unavailable"
  /** The FF1 holds as many paired sites as it allows; the owner removes one first. */
  | "too_many_sites";

export class PlayError extends Error {
  readonly code: PlayErrorCode | undefined;

  constructor(message: string, code?: PlayErrorCode) {
    super(message);
    this.name = "PlayError";
    this.code = code;
  }
}
