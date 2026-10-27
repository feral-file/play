import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { parseProfile } from "../src/control/codec.js";
import { exportPublicJwk, generateAgreementKeyPair, generateSigningKeyPair, thumbprint } from "../src/control/jwk.js";
import { replaceStoredDisplayGrant, type StoredDisplayGrant } from "../src/grantStore.js";
import { FakeFF1, type FakeAnswer, type Jwk } from "./control-device.js";
import { relayV2Endpoint } from "./fakeBroker.js";
import { fakeRelay, type FakePeer } from "./fakeRelay.js";
import { fixtureDevice } from "./fixtures.js";

/** Gives the test a fresh, empty IndexedDB. */
export function resetIndexedDb(): void {
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: new IDBFactory() });
}

export function removeIndexedDb(): void {
  Reflect.deleteProperty(globalThis, "indexedDB");
}

/**
 * Writes a display grant for `origin` with fresh keys, pinned to the fixture
 * FF1, and returns the record plus the public signing key a stub device
 * needs to accept its envelopes.
 */
export async function seedGrant(origin: string, overrides: Partial<StoredDisplayGrant> = {}): Promise<{ record: StoredDisplayGrant; sig: Jwk }> {
  const device = fixtureDevice();
  const sig = await generateSigningKeyPair();
  const enc = await generateAgreementKeyPair();
  const sigPublic = await exportPublicJwk(sig.publicKey);
  const record: StoredDisplayGrant = {
    origin,
    deviceId: device.dev,
    ctl: await thumbprint(sigPublic),
    profile: await parseProfile(device.profile),
    relayV2Endpoint,
    persistent: true,
    sigKey: sig.privateKey,
    sigPublic,
    encKey: enc.privateKey,
    ctr: 0,
    storedAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
  await replaceStoredDisplayGrant(record);
  return { record, sig: sigPublic };
}

/**
 * A stub FF1 on a stub relay channel: the device opens every envelope with
 * the fixture keys, accepts the grants in `grants`, and answers per `decide`.
 */
export function deviceOnRelay(
  grants: Record<string, Jwk>,
  decide?: (claims: Record<string, unknown>) => FakeAnswer,
  extraPeers: FakePeer[] = []
) {
  const ff1 = new FakeFF1(fixtureDevice(), grants, decide);
  const relay = fakeRelay({
    peers: [{ id: "conn_ff1", respond: (message) => ff1.handle(message) }, ...extraPeers]
  });
  return { ff1, ...relay };
}
