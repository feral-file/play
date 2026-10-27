import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { requestEphemeralSession } from "../src/client.js";
import { PlayError } from "../src/errors.js";
import { deleteStoredDisplayGrant, readStoredDisplayGrant, replaceStoredDisplayGrant, reserveCounter } from "../src/grantStore.js";
import { brokerBaseUrl, fakeBroker } from "./fakeBroker.js";
import { removeIndexedDb, resetIndexedDb, seedGrant } from "./grants.js";

const testOrigin = "https://nft.example";

beforeEach(() => {
  resetIndexedDb();
  Object.defineProperty(globalThis, "location", { configurable: true, value: { origin: testOrigin } });
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, "location");
});

describe("display grant store", () => {
  it("keeps the grant, its keys and the counter as one record per origin", async () => {
    const { record } = await seedGrant(testOrigin);
    const stored = await readStoredDisplayGrant(testOrigin);
    expect(stored?.ctl).toBe(record.ctl);
    expect(stored?.sigKey).toBeInstanceOf(CryptoKey);
    expect(stored?.sigKey.extractable).toBe(false);
    expect(await readStoredDisplayGrant("https://other.example")).toBeUndefined();
    await deleteStoredDisplayGrant(testOrigin);
    expect(await readStoredDisplayGrant(testOrigin)).toBeUndefined();
  });

  it("deletes only a record of the given ctl, so a stale tab never removes a fresh grant", async () => {
    const { record: fresh } = await seedGrant(testOrigin);
    await deleteStoredDisplayGrant(testOrigin, "stale-ctl");
    expect((await readStoredDisplayGrant(testOrigin))?.ctl).toBe(fresh.ctl);
    await deleteStoredDisplayGrant(testOrigin, fresh.ctl);
    expect(await readStoredDisplayGrant(testOrigin)).toBeUndefined();
  });

  it("returns the displaced record when a grant is replaced", async () => {
    const { record: first } = await seedGrant(testOrigin);
    const second = await seedGrant("https://other.example");
    expect(await replaceStoredDisplayGrant({ ...second.record, origin: testOrigin })).toMatchObject({ ctl: first.ctl });
    expect((await readStoredDisplayGrant(testOrigin))?.ctl).toBe(second.record.ctl);
  });

  it("refuses a record whose ctl is not the thumbprint of its signing key", async () => {
    const { record } = await seedGrant(testOrigin);
    await expect(replaceStoredDisplayGrant({ ...record, ctl: "S2bVJ1g34d-xMnRk7wxaTtosj_vyZVYY4ywk4R4UEDY" })).rejects.toThrow(/ctl/);
    expect((await readStoredDisplayGrant(testOrigin))?.ctl).toBe(record.ctl);
  });

  it("reserves counters atomically across concurrent callers", async () => {
    await seedGrant(testOrigin);
    // Several tabs sealing at once: every reservation runs in its own
    // readwrite transaction, so no two draw the same counter.
    const reserved = await Promise.all(Array.from({ length: 50 }, () => reserveCounter(testOrigin)));
    const counters = reserved.map((record) => record?.ctr);
    expect(new Set(counters).size).toBe(50);
    expect(Math.min(...(counters as number[]))).toBe(1);
    expect(Math.max(...(counters as number[]))).toBe(50);
    expect((await readStoredDisplayGrant(testOrigin))?.ctr).toBe(50);
  });

  it("jumps the counter by the requested amount", async () => {
    await seedGrant(testOrigin, { ctr: 7 });
    expect((await reserveCounter(testOrigin, 1024))?.ctr).toBe(1031);
    expect(await reserveCounter("https://other.example")).toBeUndefined();
  });

  it("reserves nothing for a ctl that is no longer the stored grant", async () => {
    const { record } = await seedGrant(testOrigin, { ctr: 3 });
    expect(await reserveCounter(testOrigin, 1, "stale-ctl")).toBeUndefined();
    expect((await readStoredDisplayGrant(testOrigin))?.ctr).toBe(3);
    expect((await reserveCounter(testOrigin, 1, record.ctl))?.ctr).toBe(4);
  });

  it("fails pairing with storage_unavailable without IndexedDB", async () => {
    removeIndexedDb();
    const broker = await fakeBroker();
    await expect(requestEphemeralSession({ brokerBaseUrl, fetchImpl: broker.fetchImpl })).rejects.toMatchObject({ code: "storage_unavailable" });
    expect(broker.fetchImpl).not.toHaveBeenCalled();
  });

  it("fails pairing with storage_unavailable when storage is disabled", async () => {
    const broker = await fakeBroker();
    const error = await requestEphemeralSession({ brokerBaseUrl, storage: false, fetchImpl: broker.fetchImpl }).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(PlayError);
    expect((error as PlayError).code).toBe("storage_unavailable");
  });
});
