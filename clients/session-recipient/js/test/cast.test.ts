import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { displayDp1Playlist, unpairArtComputer } from "../src/cast.js";
import type { PlayError } from "../src/errors.js";
import { readStoredDisplayGrant, replaceStoredDisplayGrant } from "../src/grantStore.js";
import type { Jwk } from "./control-device.js";
import { captureError } from "./fakeBroker.js";
import { fakeRelay, type FakeSocket } from "./fakeRelay.js";
import { deviceOnRelay, resetIndexedDb, seedGrant } from "./grants.js";

const testOrigin = "https://nft.example";
const playlist = { dpVersion: "1.0.0", title: "cast", items: [] };

beforeEach(() => {
  resetIndexedDb();
  Object.defineProperty(globalThis, "location", { configurable: true, value: { origin: testOrigin } });
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, "location");
});

async function seeded(): Promise<{ ctl: string; sig: Jwk; grants: Record<string, Jwk> }> {
  const { record, sig } = await seedGrant(testOrigin);
  return { ctl: record.ctl, sig, grants: { [record.ctl]: sig } };
}

const session = { deviceId: "FF1-FIXTURE1", ctl: "", persistent: true };

describe("displayDp1Playlist over relay v2", () => {
  it("seals displayPlaylist in the Play shape under the stored keys, fans it out, and closes the socket", async () => {
    const { ctl, grants } = await seeded();
    const relay = deviceOnRelay(grants);
    await displayDp1Playlist({ session, playlist, socketFactory: relay.socketFactory });

    expect(relay.ff1.seen).toHaveLength(1);
    const claims = relay.ff1.seen[0];
    expect(claims).toMatchObject({
      v: 1,
      dev: "FF1-FIXTURE1",
      ctl,
      ctr: 1,
      op: "cmd",
      cmd: "displayPlaylist",
      req: { intent: { action: "now_display" }, dp1_call: playlist }
    });
    expect((claims?.["exp"] as number) - (claims?.["iat"] as number)).toBe(60);
    expect(relay.frames.map((frame) => frame.to)).toEqual(["peers"]);
    expect(relay.sockets).toHaveLength(1);
    expect(relay.sockets[0]?.url).toBe("wss://relay.example/v2/channels/FF1-FIXTURE1/connections");
    expect(relay.sockets[0]?.closed).toBe(true);
    expect((await readStoredDisplayGrant(testOrigin))?.ctr).toBe(1);
  });

  it("seals a fresh envelope with a new counter and rid for every cast", async () => {
    const { grants } = await seeded();
    const relay = deviceOnRelay(grants);
    await displayDp1Playlist({ session, playlist, socketFactory: relay.socketFactory });
    await displayDp1Playlist({ session, playlist, socketFactory: relay.socketFactory });
    expect(relay.ff1.seen.map((claims) => claims["ctr"])).toEqual([1, 2]);
    expect(relay.ff1.seen[0]?.["rid"]).not.toBe(relay.ff1.seen[1]?.["rid"]);
    expect(relay.sockets).toHaveLength(2);
  });

  it("chunks a playlist over 32 KiB and the FF1 still opens it", async () => {
    const { grants } = await seeded();
    const relay = deviceOnRelay(grants);
    const big = { ...playlist, items: Array.from({ length: 400 }, (_, index) => ({ id: String(index), source: `https://art.example/${"x".repeat(100)}` })) };
    await displayDp1Playlist({ session, playlist: big, socketFactory: relay.socketFactory });
    expect(relay.frames.length).toBeGreaterThan(1);
    expect(relay.frames.every((frame) => frame.payload["relayChunk"] !== undefined)).toBe(true);
    expect((relay.ff1.seen[0]?.["req"] as { dp1_call: unknown }).dp1_call).toEqual(big);
  });

  it("ignores a stranger's unverifiable reply and takes the FF1's", async () => {
    const { grants } = await seeded();
    const relay = deviceOnRelay(grants, undefined, [{ id: "conn_stranger", respond: () => ({ v: 1, jwe: "not.a.real.jwe" }) }]);
    await expect(displayDp1Playlist({ session, playlist, socketFactory: relay.socketFactory })).resolves.toBeUndefined();
  });

  it.each([
    { name: "a verified command_failed", answer: { ok: false as const, code: "command_failed" } },
    { name: "a verified permission_denied", answer: { ok: false as const, code: "permission_denied" } },
    { name: "a verified ok with a player refusal", answer: { ok: true as const, res: { ok: false } } }
  ])("maps $name to display_rejected and keeps the grant", async ({ answer }) => {
    const { grants } = await seeded();
    const relay = deviceOnRelay(grants, () => answer);
    const error = await captureError(displayDp1Playlist({ session, playlist, socketFactory: relay.socketFactory }));
    expect((error as PlayError).code).toBe("display_rejected");
    expect(await readStoredDisplayGrant(testOrigin)).toBeDefined();
  });

  it.each(["access_revoked", "expired"])("maps a verified %s to session_rejected and deletes the grant", async (code) => {
    const { grants } = await seeded();
    const relay = deviceOnRelay(grants, () => ({ ok: false, code }));
    const error = await captureError(displayDp1Playlist({ session, playlist, socketFactory: relay.socketFactory }));
    expect((error as PlayError).code).toBe("session_rejected");
    expect(await readStoredDisplayGrant(testOrigin)).toBeUndefined();
  });

  it("maps a verified replay to display_failed, jumps the counter by 1024 and does not resend", async () => {
    const { grants } = await seeded();
    const relay = deviceOnRelay(grants, () => ({ ok: false, code: "replay" }));
    const error = await captureError(displayDp1Playlist({ session, playlist, socketFactory: relay.socketFactory }));
    expect((error as PlayError).code).toBe("display_failed");
    expect(relay.ff1.seen).toHaveLength(1);
    expect((await readStoredDisplayGrant(testOrigin))?.ctr).toBe(1 + 1024);
  });

  it.each(["invalid_request", "rate_limited", "locked"])("maps a verified %s to display_failed", async (code) => {
    const { grants } = await seeded();
    const relay = deviceOnRelay(grants, () => ({ ok: false, code }));
    const error = await captureError(displayDp1Playlist({ session, playlist, socketFactory: relay.socketFactory }));
    expect((error as PlayError).code).toBe("display_failed");
  });

  it.each(["unknown_controller", "bad_envelope"])("maps an unverified public %s with no verified reply to device_unrecognized and keeps the grant", async (code) => {
    await seeded();
    // The FF1 after a factory reset: it does not know the ctl. Nothing can
    // verify the body, so the grant is kept and the visitor decides.
    const relay = fakeRelay({ peers: [{ id: "conn_ff1", respond: () => ({ error: { code } }) }] });
    const error = await captureError(displayDp1Playlist({ session, playlist, socketFactory: relay.socketFactory, timeoutMs: 300 }));
    expect((error as PlayError).code).toBe("device_unrecognized");
    expect(await readStoredDisplayGrant(testOrigin)).toBeDefined();
  });

  it("maps a deadline passed in silence to display_failed", async () => {
    await seeded();
    const relay = fakeRelay({ peers: [{ id: "conn_ff1" }] });
    const error = await captureError(displayDp1Playlist({ session, playlist, socketFactory: relay.socketFactory, timeoutMs: 300 }));
    expect((error as PlayError).code).toBe("display_failed");
    expect(await readStoredDisplayGrant(testOrigin)).toBeDefined();
  });

  it("maps an empty channel (RelayUndeliveredError) to display_failed as offline", async () => {
    await seeded();
    const relay = fakeRelay({ peers: [] });
    const error = await captureError(displayDp1Playlist({ session, playlist, socketFactory: relay.socketFactory }));
    expect((error as PlayError).code).toBe("display_failed");
    expect((error as PlayError).message).toMatch(/offline/);
    expect(await readStoredDisplayGrant(testOrigin)).toBeDefined();
  });

  it("maps a connection the relay refuses before hello (429 capacity or rate limited) to display_failed as too many casts, not offline", async () => {
    await seeded();
    const relay = fakeRelay({ peers: [{ id: "conn_ff1" }], failConnect: 1006 });
    const error = await captureError(displayDp1Playlist({ session, playlist, socketFactory: relay.socketFactory }));
    expect((error as PlayError).code).toBe("display_failed");
    expect((error as PlayError).message).toMatch(/Too many casts/);
    expect((error as PlayError).message).not.toMatch(/offline/);
    // Every connect attempt was refused; nothing was sent and the grant is kept.
    expect(relay.sockets).toHaveLength(3);
    expect(relay.frames).toHaveLength(0);
    expect(await readStoredDisplayGrant(testOrigin)).toBeDefined();
  });

  it("maps a connection that drops after the send (RelayAmbiguousError) to display_failed without resending", async () => {
    await seeded();
    let socket: FakeSocket | undefined;
    const relay = fakeRelay({
      peers: [{
        id: "conn_ff1",
        respond: () => {
          socket?.closeWith(1006);
          return undefined;
        }
      }]
    });
    const socketFactory = (url: string): WebSocket => {
      const created = relay.socketFactory(url);
      socket = created as unknown as FakeSocket;
      return created;
    };
    const error = await captureError(displayDp1Playlist({ session, playlist, socketFactory }));
    expect((error as PlayError).code).toBe("display_failed");
    expect(relay.frames).toHaveLength(1);
    expect(relay.sockets).toHaveLength(1);
  });

  it("fails with display_failed, taking no counter, when another tab replaced the grant before the seal", async () => {
    const { grants } = await seeded();
    const relay = deviceOnRelay(grants);
    const replacement = await seedGrant("https://other.example");
    // The read of the stale record has happened; the replacement lands before the socket is ready.
    const socketFactory = (url: string): WebSocket => {
      void replaceStoredDisplayGrant({ ...replacement.record, origin: testOrigin });
      return relay.socketFactory(url);
    };
    const error = await captureError(displayDp1Playlist({ session, playlist, socketFactory }));
    expect((error as PlayError).code).toBe("display_failed");
    expect(relay.ff1.seen).toHaveLength(0);
    expect((await readStoredDisplayGrant(testOrigin))?.ctr).toBe(0);
  });

  it("throws session_rejected without a stored grant", async () => {
    const relay = fakeRelay({ peers: [] });
    const error = await captureError(displayDp1Playlist({ session, playlist, socketFactory: relay.socketFactory }));
    expect((error as PlayError).code).toBe("session_rejected");
    expect(relay.sockets).toHaveLength(0);
  });

  it("throws session_rejected and deletes a grant past its expiry without opening a socket", async () => {
    await seedGrant(testOrigin, { expiresAt: "2000-01-01T00:00:00.000Z", persistent: false });
    const relay = fakeRelay({ peers: [] });
    const error = await captureError(displayDp1Playlist({ session, playlist, socketFactory: relay.socketFactory }));
    expect((error as PlayError).code).toBe("session_rejected");
    expect(relay.sockets).toHaveLength(0);
    expect(await readStoredDisplayGrant(testOrigin)).toBeUndefined();
  });
});

describe("unpairArtComputer", () => {
  it("sends a self-revoke with the stored keys, then deletes the grant", async () => {
    const { ctl, grants } = await seeded();
    const relay = deviceOnRelay(grants);
    await unpairArtComputer({ socketFactory: relay.socketFactory });
    expect(relay.ff1.seen).toHaveLength(1);
    expect(relay.ff1.seen[0]).toMatchObject({ ctl, cmd: "revokeController", req: { ctl } });
    expect(await readStoredDisplayGrant(testOrigin)).toBeUndefined();
    expect(relay.sockets[0]?.closed).toBe(true);
  });

  it("deletes the grant even when the FF1 is offline", async () => {
    await seeded();
    const relay = fakeRelay({ peers: [] });
    await unpairArtComputer({ socketFactory: relay.socketFactory });
    expect(await readStoredDisplayGrant(testOrigin)).toBeUndefined();
  });

  it("is a no-op without a stored grant", async () => {
    const relay = fakeRelay({ peers: [] });
    await unpairArtComputer({ socketFactory: relay.socketFactory });
    expect(relay.sockets).toHaveLength(0);
  });
});
