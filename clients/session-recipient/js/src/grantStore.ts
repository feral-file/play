import type { DeviceProfile } from "./control/codec.js";
import { thumbprint, type PublicJwk } from "./control/jwk.js";
import { PlayError } from "./errors.js";

/**
 * The display grant stored for one site origin: the grant the FF1 issued,
 * the non-extractable keys it was issued to, and the request counter. The
 * three are one record, always written and deleted together, so a key can
 * never outlive its grant or be reused under a new one.
 */
export type StoredDisplayGrant = {
  origin: string;
  deviceId: string;
  ctl: string;
  profile: DeviceProfile;
  relayV2Endpoint: string;
  /** Absent when the owner kept the site paired until removed. */
  expiresAt?: string;
  persistent: boolean;
  sigKey: CryptoKey;
  /** The public half of `sigKey`; `ctl` must be its thumbprint. */
  sigPublic: PublicJwk;
  encKey: CryptoKey;
  /** Last request counter used; the next request takes `ctr + 1`. */
  ctr: number;
  storedAt: string;
};

export const displayGrantDatabaseName = "ff-play";
export const displayGrantStoreName = "displayGrants";
const databaseVersion = 1;

type OptionalIndexedDbGlobals = {
  indexedDB?: IDBFactory;
};

function storageUnavailable(): PlayError {
  return new PlayError("IndexedDB is unavailable; display grants cannot be stored", "storage_unavailable");
}

export function hasIndexedDb(): boolean {
  return (globalThis as unknown as OptionalIndexedDbGlobals).indexedDB !== undefined;
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => { resolve(req.result); };
    req.onerror = () => { reject(storageUnavailable()); };
  });
}

function completion(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => { resolve(); };
    tx.onerror = () => { reject(storageUnavailable()); };
    tx.onabort = () => { reject(storageUnavailable()); };
  });
}

async function openDatabase(): Promise<IDBDatabase> {
  const factory = (globalThis as unknown as OptionalIndexedDbGlobals).indexedDB;
  if (factory === undefined) {
    throw storageUnavailable();
  }
  let open: IDBOpenDBRequest;
  try {
    open = factory.open(displayGrantDatabaseName, databaseVersion);
  } catch {
    // A sandboxed or storage-partitioned frame can throw on open.
    throw storageUnavailable();
  }
  open.onupgradeneeded = () => {
    open.result.createObjectStore(displayGrantStoreName, { keyPath: "origin" });
  };
  return request(open);
}

/** Runs one transaction on the grant store and closes the database after it. */
async function withStore<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => Promise<T>): Promise<T> {
  const db = await openDatabase();
  try {
    const tx = db.transaction(displayGrantStoreName, mode);
    const done = completion(tx);
    const result = await work(tx.objectStore(displayGrantStoreName));
    await done;
    return result;
  } finally {
    db.close();
  }
}

function isStoredGrant(value: unknown): value is StoredDisplayGrant {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record["origin"] === "string" &&
    typeof record["deviceId"] === "string" &&
    typeof record["ctl"] === "string" &&
    typeof record["relayV2Endpoint"] === "string" &&
    typeof record["ctr"] === "number" &&
    typeof record["sigKey"] === "object" &&
    typeof record["sigPublic"] === "object" &&
    typeof record["encKey"] === "object"
  );
}

/**
 * A record whose `ctl` is not the thumbprint of its own signing key would
 * seal envelopes the FF1 cannot attribute; it fails here, locally, instead.
 */
async function checkedGrant(value: unknown): Promise<StoredDisplayGrant | undefined> {
  if (!isStoredGrant(value)) {
    return undefined;
  }
  if ((await thumbprint(value.sigPublic)) !== value.ctl) {
    throw new PlayError("stored display grant ctl does not match its signing key", "display_failed");
  }
  return value;
}

export async function readStoredDisplayGrant(origin: string): Promise<StoredDisplayGrant | undefined> {
  return checkedGrant(await withStore("readonly", (store) => request(store.get(origin))));
}

/**
 * Writes the grant for its origin and returns the record it replaced, if
 * any, read in the same `readwrite` transaction: when two tabs pair at once,
 * each learns exactly which grant it displaced.
 */
export async function replaceStoredDisplayGrant(record: StoredDisplayGrant): Promise<StoredDisplayGrant | undefined> {
  await checkedGrant(record);
  return withStore("readwrite", async (store) => {
    const previous: unknown = await request(store.get(record.origin));
    await request(store.put(record));
    return isStoredGrant(previous) ? previous : undefined;
  });
}

/**
 * Deletes the origin's grant. With `ctl`, only a record of that ctl is
 * deleted, in one transaction, so a tab holding a stale grant never removes
 * the fresh one another tab has just stored.
 */
export function deleteStoredDisplayGrant(origin: string, ctl?: string): Promise<void> {
  return withStore("readwrite", async (store) => {
    if (ctl !== undefined) {
      const value: unknown = await request(store.get(origin));
      if (!isStoredGrant(value) || value.ctl !== ctl) {
        return;
      }
    }
    await request(store.delete(origin));
  });
}

/**
 * Reserves the next request counter for this origin's grant and returns the
 * record as of that reservation. The read, increment and write happen inside
 * one `readwrite` transaction, so two tabs sealing at once never draw the
 * same counter, and a counter is spent whether or not the request is sent.
 * With `ctl`, nothing is reserved unless the stored grant is that one: a tab
 * casting with a grant another tab has since replaced gets undefined, never
 * a counter of the newer grant.
 */
export function reserveCounter(origin: string, by = 1, ctl?: string): Promise<StoredDisplayGrant | undefined> {
  return withStore("readwrite", async (store) => {
    const value: unknown = await request(store.get(origin));
    if (!isStoredGrant(value) || (ctl !== undefined && value.ctl !== ctl)) {
      return undefined;
    }
    const record: StoredDisplayGrant = { ...value, ctr: value.ctr + by };
    await request(store.put(record));
    return record;
  });
}
