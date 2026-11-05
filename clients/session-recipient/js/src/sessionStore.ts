import { DisplayError } from "./errors.js";

/**
 * A relayer session the FF1 minted for this origin: what an Art Computer on FF
 * OS without display grants answers a pairing with. The token is a bearer
 * credential for the legacy relayer's `/api/cast`; it lives only in this
 * origin's `localStorage`, under the key and in the record shape 0.4 wrote, so
 * a session a visitor paired under `@feralfile/play` 0.4 keeps working.
 */
export type StoredRelayerSession = {
  origin: string;
  token: string;
  sessionId: string;
  /** Absent when the device owner kept this site paired until removed. */
  expiresAt?: string;
  persistent?: boolean;
  /** The relayer the FF1 named; the cast falls back to the integrator's `relayerBaseUrl`. */
  relayerBaseUrl?: string;
  storedAt: string;
};

type OptionalStorageGlobals = {
  localStorage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
};

/** The 0.4 key. Do not change it: stored 0.4 sessions are found by it. */
export function ephemeralBrowserSessionStorageKey(origin: string): string {
  return `ff:ephemeral-browser-session:${origin}`;
}

function storage(): OptionalStorageGlobals["localStorage"] {
  try {
    return (globalThis as unknown as OptionalStorageGlobals).localStorage;
  } catch {
    // Reading `localStorage` throws in a sandboxed frame or with site data blocked.
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Parses a stored record as 0.4 did. A record that is malformed, expired, or
 * carries no expiry without the `persistent` marker is not usable.
 */
function parseStoredSession(raw: string, origin: string): StoredRelayerSession | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
  if (!isRecord(value) || value["origin"] !== origin) {
    return undefined;
  }
  const token = nonEmptyString(value["token"]);
  const sessionId = nonEmptyString(value["sessionId"]);
  if (token === undefined || sessionId === undefined) {
    return undefined;
  }
  const persistent = value["persistent"] === true;
  const expiryPresent = value["expiresAt"] !== undefined && value["expiresAt"] !== null;
  const expiresAt = expiryPresent ? nonEmptyString(value["expiresAt"]) : undefined;
  if (expiryPresent) {
    const expiresAtMs = expiresAt === undefined ? Number.NaN : Date.parse(expiresAt);
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
      return undefined;
    }
  } else if (!persistent) {
    return undefined;
  }
  const relayerBaseUrl = nonEmptyString(value["relayerBaseUrl"]);
  return {
    origin,
    token,
    sessionId,
    ...(expiresAt === undefined ? {} : { expiresAt }),
    ...(persistent ? { persistent: true } : {}),
    ...(relayerBaseUrl === undefined ? {} : { relayerBaseUrl }),
    storedAt: nonEmptyString(value["storedAt"]) ?? ""
  };
}

/**
 * Reads the session stored for this origin. A record that can no longer be
 * used is removed, so the next display request pairs instead of holding a
 * token that will never be sent.
 */
export function readStoredRelayerSession(origin: string): StoredRelayerSession | undefined {
  const store = storage();
  if (store === undefined) {
    return undefined;
  }
  const key = ephemeralBrowserSessionStorageKey(origin);
  let raw: string | null;
  try {
    raw = store.getItem(key);
  } catch {
    return undefined;
  }
  if (raw === null) {
    return undefined;
  }
  const session = parseStoredSession(raw, origin);
  if (session === undefined) {
    removeStoredRelayerSession(origin);
  }
  return session;
}

export function storeRelayerSession(session: StoredRelayerSession): void {
  const store = storage();
  try {
    if (store === undefined) {
      throw new Error("no localStorage");
    }
    store.setItem(ephemeralBrowserSessionStorageKey(session.origin), JSON.stringify(session));
  } catch {
    // Never rethrow: a storage error can quote the value, which holds the token.
    throw new DisplayError("localStorage is unavailable; the browser session cannot be stored", "storage_unavailable");
  }
}

/**
 * Removes the origin's session. With `sessionId`, only a record of that
 * session is removed, so a tab holding a stale session never removes the one
 * another tab has just stored.
 */
export function removeStoredRelayerSession(origin: string, sessionId?: string): void {
  const store = storage();
  if (store === undefined) {
    return;
  }
  const key = ephemeralBrowserSessionStorageKey(origin);
  try {
    if (sessionId !== undefined) {
      const raw = store.getItem(key);
      const current = raw === null ? undefined : parseStoredSession(raw, origin);
      if (current !== undefined && current.sessionId !== sessionId) {
        return;
      }
    }
    store.removeItem(key);
  } catch {
    // Storage access can throw in a sandboxed frame; there is nothing to remove then.
  }
}
