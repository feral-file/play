import type { EphemeralBrowserSession } from "./client.js";
import { findEnvelopeAnswer, openReply, sealRequest, type ReplyClaims } from "./control/codec.js";
import { RelayClient, RelayConnectError, RelayUndeliveredError, type SocketFactory } from "./control/relay-client.js";
import { PlayError } from "./errors.js";
import { deleteStoredDisplayGrant, readStoredDisplayGrant, reserveCounter, type StoredDisplayGrant } from "./grantStore.js";

export type Dp1Playlist = Record<string, unknown>;

export type DisplayDp1PlaylistOptions = {
  session: EphemeralBrowserSession;
  playlist: Dp1Playlist;
  /** Deadline for the whole relay round trip, connecting included. Default 30 s, plus about a second per 24 KB of playlist over 32 KB. */
  timeoutMs?: number;
  /** Opens the relay WebSocket; defaults to the browser's `WebSocket`. */
  socketFactory?: SocketFactory;
};

const defaultTimeoutMs = 30_000;
/** Shown as-is by the wrapped button: the one display_failed a visitor can act on by waiting. */
export const tooManyCastsMessage = "Too many casts at once from this network, or the relay is unreachable. Try again in a moment.";
/** Shown as-is by the wrapped button: the page holds a pairing another tab has since replaced. */
export const pairingReplacedMessage = "This page's pairing was replaced by a newer one. Reload the page and play again.";
/** Bytes a request may carry before the relay's chunk pacing earns it more time. */
const chunkSize = 32_768;
/** A self-revoke is best effort: it gets a short deadline and its outcome is ignored. */
const revokeTimeoutMs = 10_000;
/**
 * How far the counter jumps after a verified `replay` (§14.4). ff-cli resyncs
 * over the LAN instead; the browser has no LAN path, so it moves well past
 * whatever the FF1 has seen and the next cast seals fresh.
 */
const replayCounterJump = 1024;

/**
 * The default deadline, as in ff-cli: a large command gets time to cross the
 * relay's byte ceiling chunk by chunk.
 */
function castDeadline(req: Record<string, unknown>): number {
  const size = JSON.stringify(req).length;
  return defaultTimeoutMs + (size > chunkSize ? Math.ceil(size / 24_000) * 1000 : 0);
}

type OptionalBrowserGlobals = {
  location?: { origin?: unknown };
};

function currentOrigin(): string {
  const origin = (globalThis as unknown as OptionalBrowserGlobals).location?.origin;
  if (typeof origin === "string" && origin.length > 0) {
    return origin;
  }
  throw new Error("origin is required");
}

/** True once a timed grant's `expiresAt` has passed. */
export function grantExpired(record: Pick<StoredDisplayGrant, "expiresAt">, now = Date.now()): boolean {
  return record.expiresAt !== undefined && Date.parse(record.expiresAt) <= now;
}

type CommandOutcome =
  | { kind: "reply"; claims: ReplyClaims }
  | {
      kind: "failed";
      error: Error;
      /** Some channel peer answered a public `unknown_controller`/`bad_envelope`: unverified, so never acted on by itself. */
      unrecognized: boolean;
    };

/**
 * Seals one `cmd` request under the grant's keys and carries it over relay
 * v2: fan out, ACK every frame, chunk over 32 KiB, and pin the first reply
 * that verifies against the pinned profile. The socket is opened for this
 * command and closed right after; a browser never holds an idle relay slot.
 */
async function sendCommand(
  record: StoredDisplayGrant,
  cmd: string,
  req: Record<string, unknown>,
  reserve: () => Promise<number>,
  timeoutMs: number,
  socketFactory: SocketFactory | undefined
): Promise<CommandOutcome> {
  let client: RelayClient;
  try {
    client = new RelayClient(record.relayV2Endpoint, record.deviceId, socketFactory);
  } catch (error) {
    return { kind: "failed", error: toError(error), unrecognized: false };
  }
  // Outcomes by the reply object that produced them: two replies may verify
  // (an FF1 answering two copies), and only the one that settled the request
  // is the answer.
  const verified = new WeakMap<object, ReplyClaims>();
  let unrecognized = false;
  let reserveError: unknown;
  try {
    const settled = await client.requestPrepared(async () => {
      let ctr: number;
      try {
        ctr = await reserve();
      } catch (error) {
        reserveError = error;
        throw error;
      }
      const sealed = await sealRequest({ profile: record.profile, ctl: record.ctl, sigKey: record.sigKey, ctr, cmd, req });
      const bind = { dev: sealed.claims.dev, gen: sealed.claims.gen, ctl: sealed.claims.ctl, rid: sealed.claims.rid };
      return {
        command: "ff1Envelope",
        request: { v: 1, jwe: sealed.compact },
        verify: async (body) => {
          const answer = findEnvelopeAnswer(body);
          if (answer?.code === "unknown_controller" || answer?.code === "bad_envelope") {
            // Recorded, not trusted: any channel peer can send this body
            // (spec §14.3), so it never deletes the grant on its own.
            unrecognized = true;
            return false;
          }
          if (answer?.jwe === undefined) {
            return false;
          }
          try {
            verified.set(body, await openReply(answer.jwe, sealed.rk, record.profile.sig, bind));
            return true;
          } catch {
            return false;
          }
        }
      };
    }, timeoutMs);
    const claims = verified.get(settled);
    if (claims === undefined) {
      return { kind: "failed", error: new Error("relay settled without a verified reply"), unrecognized };
    }
    return { kind: "reply", claims };
  } catch (error) {
    if (reserveError !== undefined) {
      throw toError(reserveError);
    }
    return { kind: "failed", error: toError(error), unrecognized };
  } finally {
    client.close();
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function resOk(res: unknown): boolean | undefined {
  if (typeof res !== "object" || res === null || Array.isArray(res)) {
    return undefined;
  }
  const ok = (res as Record<string, unknown>)["ok"];
  return typeof ok === "boolean" ? ok : undefined;
}

/**
 * Plays a DP-1 playlist on the paired Art Computer: seals `displayPlaylist`
 * under this origin's display grant and sends it over relay v2. The keys
 * never leave IndexedDB; `session` names the pairing this page obtained.
 */
export async function displayDp1Playlist(options: DisplayDp1PlaylistOptions): Promise<void> {
  const origin = currentOrigin();
  const record = await readStoredDisplayGrant(origin);
  if (record === undefined) {
    throw new PlayError("no display grant is stored for this site", "session_rejected");
  }
  if (grantExpired(record)) {
    await deleteStoredDisplayGrant(origin, record.ctl);
    throw new PlayError("the display grant has expired", "session_rejected");
  }
  // The page casts only with the pairing it obtained: a stale page must not
  // cast to whatever FF1 another tab has paired with since, and the newer
  // grant is left alone (not session_rejected, which would clear it).
  if (record.ctl !== options.session.ctl || record.deviceId !== options.session.deviceId) {
    throw new PlayError(pairingReplacedMessage, "display_failed");
  }
  const req = { intent: { action: "now_display" }, dp1_call: options.playlist };
  const reserve = async (): Promise<number> => {
    const reserved = await reserveCounter(origin, 1, record.ctl);
    if (reserved === undefined) {
      // Gone, or replaced by another tab's pairing: this grant is stale.
      // The next play re-reads the store and casts with the current one.
      throw new PlayError("the display grant was replaced; play again", "display_failed");
    }
    return reserved.ctr;
  };
  const outcome = await sendCommand(record, "displayPlaylist", req, reserve, options.timeoutMs ?? castDeadline(req), options.socketFactory);
  if (outcome.kind === "failed") {
    if (outcome.unrecognized) {
      throw new PlayError("the FF1 no longer recognizes this site's pairing", "device_unrecognized");
    }
    if (outcome.error instanceof RelayConnectError) {
      // The relay refused or dropped the connection before hello. Browsers
      // see no status, and the usual cause is the relay's per-address cap
      // (429 capacity / rate limited) when many tabs cast at once.
      throw new PlayError(tooManyCastsMessage, "display_failed");
    }
    if (outcome.error instanceof RelayUndeliveredError) {
      throw new PlayError("the FF1 is offline", "display_failed");
    }
    throw new PlayError(`display request failed: ${outcome.error.message}`, "display_failed");
  }
  const { claims } = outcome;
  if (claims.ok) {
    if (resOk(claims.res) === false) {
      throw new PlayError("FF1 rejected display request", "display_rejected");
    }
    return;
  }
  switch (claims.code) {
    case "command_failed":
    case "permission_denied":
      throw new PlayError("FF1 rejected display request", "display_rejected");
    case "access_revoked":
    case "expired":
      await deleteStoredDisplayGrant(origin, record.ctl);
      throw new PlayError("the display grant was revoked", "session_rejected");
    case "replay":
      // The same bytes may have reached the FF1 twice (§14.4): an unknown
      // outcome, never resent. Jump past the counters it may have seen.
      await reserveCounter(origin, replayCounterJump, record.ctl);
      throw new PlayError("the FF1 reported a replayed request", "display_failed");
    default:
      throw new PlayError(`the FF1 refused the display request (${claims.code ?? "unknown"})`, "display_failed");
  }
}

/**
 * Best-effort self-revoke of a grant with the keys in `record`, whether or
 * not it is still the stored one. A failed revoke is acceptable: the owner
 * can remove the row under Paired sites.
 */
export async function revokeDisplayGrant(record: StoredDisplayGrant, ctr: number, socketFactory?: SocketFactory): Promise<void> {
  try {
    await sendCommand(record, "revokeController", { ctl: record.ctl }, () => Promise.resolve(ctr), revokeTimeoutMs, socketFactory);
  } catch {
    // Nothing to report: the grant is being abandoned either way.
  }
}

/**
 * Unpairs this site from its Art Computer: sends a best-effort self-revoke
 * with the stored keys, then deletes the grant and keys. The next play pairs
 * again.
 */
export async function unpairArtComputer(options: { socketFactory?: SocketFactory } = {}): Promise<void> {
  const origin = currentOrigin();
  const record = await readStoredDisplayGrant(origin);
  if (record === undefined) {
    return;
  }
  // The counter is reserved through the store while the record is still
  // there, so a cast in another tab cannot reuse it.
  const reserved = await reserveCounter(origin, 1, record.ctl);
  if (reserved !== undefined) {
    await revokeDisplayGrant(reserved, reserved.ctr, options.socketFactory);
  }
  await deleteStoredDisplayGrant(origin, record.ctl);
}
