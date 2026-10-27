import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  legacySessionStorageKey,
  maxRequestedExpiresInSeconds,
  readStoredEphemeralBrowserSession,
  requestEphemeralSession,
  type EphemeralBrowserSession,
  type RequestEphemeralSessionOptions
} from "../src/client.js";
import { base64UrlDecode, decryptChannelMessage, generateBrowserKeyPair } from "../src/crypto.js";
import { PlayError } from "../src/errors.js";
import { readStoredDisplayGrant, replaceStoredDisplayGrant } from "../src/grantStore.js";
import { fakeRelay } from "./fakeRelay.js";
import type { PairingMaterial } from "../src/pairingPayload.js";
import { thumb, type Jwk } from "./control-device.js";
import {
  brokerBaseUrl,
  captureError,
  expectNoSecrets,
  fakeBroker,
  jsonResponse,
  requestUrl,
  type FakeBrokerOptions,
  type ResultKind
} from "./fakeBroker.js";
import { deviceOnRelay, resetIndexedDb, seedGrant } from "./grants.js";

const testOrigin = "https://nft.example";
const algorithmName = "P256-HKDF-SHA256-AES-256-GCM";
let previousLocationDescriptor: PropertyDescriptor | undefined;
let previousFetchDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
  resetIndexedDb();
  previousLocationDescriptor = Object.getOwnPropertyDescriptor(globalThis, "location");
  previousFetchDescriptor = Object.getOwnPropertyDescriptor(globalThis, "fetch");
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { origin: testOrigin }
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  if (previousLocationDescriptor === undefined) {
    Reflect.deleteProperty(globalThis, "location");
  } else {
    Object.defineProperty(globalThis, "location", previousLocationDescriptor);
  }
  if (previousFetchDescriptor === undefined) {
    Reflect.deleteProperty(globalThis, "fetch");
  } else {
    Object.defineProperty(globalThis, "fetch", previousFetchDescriptor);
  }
});

function baseOptions(fetchImpl: typeof fetch, overrides: Partial<RequestEphemeralSessionOptions> = {}): RequestEphemeralSessionOptions {
  return {
    brokerBaseUrl,
    pollIntervalMs: 1,
    fetchImpl,
    ...overrides
  };
}

/** Runs the happy-path mint flow and returns the session plus the decrypted mint request. */
async function runMintFlow(input: {
  requestedExpiresInSeconds?: number;
  result?: ResultKind;
} = {}): Promise<{ session: EphemeralBrowserSession; mintRequest: Record<string, unknown> }> {
  const broker = await fakeBroker(input.result === undefined ? {} : { result: input.result });
  const session = await requestEphemeralSession(baseOptions(broker.fetchImpl, {
    ...(input.requestedExpiresInSeconds === undefined ? {} : { requestedExpiresInSeconds: input.requestedExpiresInSeconds })
  }));
  const mintRequest = broker.mintRequests[0]?.plaintext;
  if (mintRequest === undefined) {
    throw new Error("mint request was never sent");
  }
  return { session, mintRequest };
}

const strippedJwk = { kty: "EC", crv: "P-256", x: expect.any(String) as unknown, y: expect.any(String) as unknown };

describe("requestEphemeralSession", () => {
  it("calls the default global fetch with the global receiver", async () => {
    const broker = await fakeBroker();
    const receiverCheckedFetch = vi.fn(function (this: typeof globalThis, input: Parameters<typeof fetch>[0], init?: RequestInit) {
      expect(this).toBe(globalThis);
      return broker.fetchImpl(input, init);
    });
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: receiverCheckedFetch
    });

    const session = await requestEphemeralSession({ brokerBaseUrl, pollIntervalMs: 1 });

    expect(session.deviceId).toBe("FF1-FIXTURE1");
    expect(receiverCheckedFetch).toHaveBeenCalledTimes(5);
  });

  it("creates a browser channel, hands out pairing material, waits for the peer, and stores the grant with its keys by origin", async () => {
    const broker = await fakeBroker({ waitingPolls: 2 });
    const materials: PairingMaterial[] = [];
    const onPeerJoined = vi.fn();

    const session = await requestEphemeralSession(baseOptions(broker.fetchImpl, {
      browserInfo: { name: "Test Browser", label: "Test Gallery" },
      onPairingMaterial: (material) => {
        expect(onPeerJoined).not.toHaveBeenCalled();
        materials.push(material);
      },
      onPeerJoined
    }));

    const issued = broker.issued[0];
    expect(session).toEqual({ deviceId: "FF1-FIXTURE1", ctl: issued?.ctl, persistent: true });
    const stored = await readStoredDisplayGrant(testOrigin);
    expect(stored).toMatchObject({
      origin: testOrigin,
      deviceId: "FF1-FIXTURE1",
      ctl: issued?.ctl,
      relayV2Endpoint: "https://relay.example",
      persistent: true,
      ctr: 0
    });
    expect(stored?.profile.dev).toBe("FF1-FIXTURE1");
    expect(stored?.sigKey.extractable).toBe(false);
    expect(stored?.encKey.extractable).toBe(false);
    expect(await readStoredDisplayGrant("https://other.example")).toBeUndefined();
    expect(materials).toEqual([{
      appLink: "https://link.feralfile.com/pair?channel=ch_1&token=pt_secret_1",
      shortCode: "123451",
      expiresAt: "2030-01-01T00:00:00.000Z"
    }]);
    expect(onPeerJoined).toHaveBeenCalledTimes(1);

    const createBody = broker.channels[0]?.createBody;
    expect(createBody).toEqual({
      algorithm: algorithmName,
      creatorRole: "browser",
      browserPublicKeyJwk: expect.objectContaining({ kty: "EC", crv: "P-256" }) as unknown,
      origin: testOrigin,
      browserInfo: expect.objectContaining({ name: "Test Browser", label: "Test Gallery" }) as unknown,
      mintRequest: {
        v: 1,
        requestMessageId: expect.stringMatching(/^msg_/) as unknown,
        supportsPersistentSessions: true,
        requestedAt: expect.any(String) as unknown,
        displayGrant: { v: 1, sig: strippedJwk, enc: strippedJwk }
      },
      idleTtlSeconds: 300,
      shortCodeRequested: true
    });
    expect(createBody).not.toHaveProperty("minterPublicKeyJwk");
    expect(broker.requests.map((request) => `${request.init?.method ?? "GET"} ${request.url}`)).toEqual([
      "POST https://pairing.example/v1/channels",
      "GET https://pairing.example/v1/channels/ch_1/messages?afterSeq=0",
      "GET https://pairing.example/v1/channels/ch_1/messages?afterSeq=0",
      "GET https://pairing.example/v1/channels/ch_1/messages?afterSeq=0",
      "POST https://pairing.example/v1/channels/ch_1/messages",
      "GET https://pairing.example/v1/channels/ch_1/messages?afterSeq=0"
    ]);
    expect(broker.closed).toEqual([]);
  });

  it("sends the same stripped display-grant keys in the announced and the encrypted request, under the 1 KiB broker cap", async () => {
    const broker = await fakeBroker();
    await requestEphemeralSession(baseOptions(broker.fetchImpl, { requestedExpiresInSeconds: maxRequestedExpiresInSeconds }));
    const announced = broker.channels[0]?.createBody["mintRequest"] as Record<string, unknown>;
    const encrypted = broker.mintRequests[0]?.plaintext["displayGrant"] as { v: number; sig: Jwk; enc: Jwk };
    expect(encrypted).toEqual(announced["displayGrant"]);
    expect(Object.keys(encrypted.sig).sort()).toEqual(["crv", "kty", "x", "y"]);
    expect(Object.keys(encrypted.enc).sort()).toEqual(["crv", "kty", "x", "y"]);
    expect(encrypted.sig).not.toEqual(encrypted.enc);
    // The grant is issued to thumb(sig), which the library must agree on.
    expect(thumb(encrypted.sig)).toBe((await readStoredDisplayGrant(testOrigin))?.ctl);
    expect(new TextEncoder().encode(JSON.stringify(announced)).length).toBeLessThanOrEqual(1024);
  });

  it("generates fresh grant keys for every pairing attempt", async () => {
    const broker = await fakeBroker({ expiredChannels: 1 });
    await requestEphemeralSession(baseOptions(broker.fetchImpl, { channelRegenerations: 1 }));
    const keysOf = (index: number): unknown => (broker.channels[index]?.createBody["mintRequest"] as Record<string, unknown>)["displayGrant"];
    expect(keysOf(0)).not.toEqual(keysOf(1));
  });

  it("encrypts the mint request to the joined peer with the channel-bound AAD and the browser key it created the channel with", async () => {
    const broker = await fakeBroker();
    await requestEphemeralSession(baseOptions(broker.fetchImpl, { requestedExpiresInSeconds: 600 }));

    const sent = broker.mintRequests[0];
    if (sent === undefined) {
      throw new Error("mint request was never sent");
    }
    const createdKey = broker.channels[0]?.createBody["browserPublicKeyJwk"];
    expect(sent.envelope["sender"]).toBe("browser");
    expect(sent.envelope["recipient"]).toBe("minter");
    expect(sent.envelope["algorithm"]).toBe(algorithmName);
    expect(sent.envelope["senderPublicKeyJwk"]).toEqual(createdKey);
    const aad = JSON.parse(new TextDecoder().decode(base64UrlDecode(sent.envelope["aad"] as string))) as unknown;
    expect(aad).toEqual({
      v: 1,
      channelId: "ch_1",
      messageId: sent.envelope["messageId"],
      seq: 0,
      sender: "browser",
      recipient: "minter",
      algorithm: algorithmName
    });
    expect(sent.plaintext).toEqual({
      v: 1,
      type: "mint_request",
      channelId: "ch_1",
      requestMessageId: sent.envelope["messageId"],
      origin: testOrigin,
      browserInfo: expect.any(Object) as unknown,
      supportsPersistentSessions: true,
      requestedExpiresInSeconds: 600,
      browserPublicKeyJwk: createdKey,
      requestedAt: expect.any(String) as unknown,
      displayGrant: { v: 1, sig: strippedJwk, enc: strippedJwk }
    });

    // Only the minter key the broker reported as the peer can open it.
    const otherKeyPair = await generateBrowserKeyPair();
    await expect(decryptChannelMessage({
      privateKey: otherKeyPair.privateKey,
      peerPublicJwk: createdKey as JsonWebKey,
      channelId: "ch_1",
      messageId: sent.envelope["messageId"] as string,
      seq: 1,
      sender: "browser",
      recipient: "minter",
      algorithm: algorithmName,
      aad: sent.envelope["aad"] as string,
      nonce: sent.envelope["nonce"] as string,
      ciphertext: sent.envelope["ciphertext"] as string
    })).rejects.toThrow();
  });

  it("builds the app link from a configured appLinkBaseUrl", async () => {
    const broker = await fakeBroker();
    const materials: PairingMaterial[] = [];
    await requestEphemeralSession(baseOptions(broker.fetchImpl, {
      appLinkBaseUrl: "feralfile://pair",
      onPairingMaterial: (material) => materials.push(material)
    }));
    expect(materials[0]?.appLink).toBe("feralfile://pair?channel=ch_1&token=pt_secret_1");
  });

  it.each(["javascript:alert(1)", "not a url", "data:text/html,hi"])("rejects appLinkBaseUrl %s before creating a channel", async (appLinkBaseUrl) => {
    const broker = await fakeBroker();
    await expect(requestEphemeralSession(baseOptions(broker.fetchImpl, { appLinkBaseUrl }))).rejects.toThrow(/appLinkBaseUrl/);
    expect(broker.fetchImpl).not.toHaveBeenCalled();
  });

  it.each([14, 301, 1.5])("rejects idleTtlSeconds %s before creating a channel", async (idleTtlSeconds) => {
    const broker = await fakeBroker();
    await expect(requestEphemeralSession(baseOptions(broker.fetchImpl, { idleTtlSeconds }))).rejects.toThrow(/idleTtlSeconds/);
    expect(broker.fetchImpl).not.toHaveBeenCalled();
  });

  it("keeps polling through a network failure while waiting for the peer", async () => {
    const broker = await fakeBroker({ networkFailures: 2 });
    const session = await requestEphemeralSession(baseOptions(broker.fetchImpl));
    expect(session.deviceId).toBe("FF1-FIXTURE1");
  });

  it("rejects a peer that is not the minter", async () => {
    const broker = await fakeBroker({ peer: (publicKeyJwk) => ({ role: "browser", publicKeyJwk }) });
    await expect(requestEphemeralSession(baseOptions(broker.fetchImpl))).rejects.toThrow("poll response invalid");
    expect(broker.mintRequests).toEqual([]);
    expect(broker.closed).toEqual(["ch_1"]);
  });

  it("refuses a broker that did not create a browser channel", async () => {
    const broker = await fakeBroker({
      createResponse: () => jsonResponse({
        channelId: "ch_1",
        minterToken: "mt_secret",
        pairingToken: "pt_secret_1",
        shortCode: "123451",
        expiresAt: "2030-01-01T00:00:00.000Z"
      }, 201)
    });
    const error = await captureError(requestEphemeralSession(baseOptions(broker.fetchImpl)));
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("channel create invalid");
    expectNoSecrets(error);
  });

  it("reports a failed channel create by status only", async () => {
    const broker = await fakeBroker({ createResponse: () => jsonResponse({ error: "rate_limited" }, 429) });
    const error = await captureError(requestEphemeralSession(baseOptions(broker.fetchImpl)));
    expect((error as Error).message).toBe("channel create failed: 429");
    expectNoSecrets(error);
  });

  it("throws pairing_code_expired and closes the channel when it expires before a peer joins", async () => {
    const broker = await fakeBroker({ expiredChannels: 1 });
    const materials: PairingMaterial[] = [];
    const error = await captureError(requestEphemeralSession(baseOptions(broker.fetchImpl, {
      onPairingMaterial: (material) => materials.push(material)
    })));
    expect(error).toBeInstanceOf(PlayError);
    expect((error as PlayError).code).toBe("pairing_code_expired");
    expectNoSecrets(error);
    expect(materials).toHaveLength(1);
    expect(broker.closed).toEqual(["ch_1"]);
  });

  it("expires a channel on the local clock when the broker keeps answering", async () => {
    const broker = await fakeBroker({ waitingPolls: Number.MAX_SAFE_INTEGER });
    const realNow = Date.now.bind(Date);
    let skewMs = 0;
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + skewMs);
    const error = await captureError(requestEphemeralSession(baseOptions(broker.fetchImpl, {
      idleTtlSeconds: 15,
      onPairingMaterial: () => {
        skewMs = 16_000;
      }
    })));
    expect((error as PlayError).code).toBe("pairing_code_expired");
    expect(broker.closed).toEqual(["ch_1"]);
  });

  it("collects a grant the Art Computer delivered while the page was suspended past its local deadline", async () => {
    // The device joined and answered the announced request while the page
    // slept; the broker renewed the channel. The page wakes 16 s after a 15 s
    // channel was created and must read the result, not abandon the channel.
    const broker = await fakeBroker({ answersFromCreate: true, waitingPolls: 0 });
    const realNow = Date.now.bind(Date);
    let skewMs = 0;
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + skewMs);
    const session = await requestEphemeralSession(baseOptions(broker.fetchImpl, {
      idleTtlSeconds: 15,
      onPairingMaterial: () => {
        skewMs = 16_000;
      }
    }));
    expect(session.ctl).toBe(broker.issued[0]?.ctl);
    expect(await readStoredDisplayGrant(testOrigin)).toBeDefined();
    expect(broker.closed).toEqual([]);
    expect(broker.channels).toHaveLength(1);
  });

  it("does the final peer check after a poll that stalled until the local deadline", async () => {
    // The first poll hangs; the device joins and delivers meanwhile. When the
    // deadline aborts the hung poll, the page must look once more, not delete
    // the channel with an approved grant on it.
    const broker = await fakeBroker({ answersFromCreate: true, waitingPolls: 0, stalledPolls: 1 });
    const realNow = Date.now.bind(Date);
    let skewMs = 0;
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + skewMs);
    const session = await requestEphemeralSession(baseOptions(broker.fetchImpl, {
      idleTtlSeconds: 15,
      channelRegenerations: 0,
      onPairingMaterial: () => {
        skewMs = 14_980; // the hung poll is cut off ~20 ms later
      }
    }));
    expect(session.ctl).toBe(broker.issued[0]?.ctl);
    expect(broker.closed).toEqual([]);
    expect(broker.channels).toHaveLength(1);
  });

  it("abandons a channel the device never joined once a page wakes past its local deadline", async () => {
    const broker = await fakeBroker({ waitingPolls: Number.MAX_SAFE_INTEGER });
    const realNow = Date.now.bind(Date);
    let skewMs = 0;
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + skewMs);
    const error = await captureError(requestEphemeralSession(baseOptions(broker.fetchImpl, {
      idleTtlSeconds: 15,
      channelRegenerations: 0,
      onPairingMaterial: () => {
        skewMs = 16_000;
      }
    })));
    expect((error as PlayError).code).toBe("pairing_code_expired");
    // One last look at the broker before giving the channel up.
    const polls = broker.requests.filter((request) => request.url.includes("/messages?"));
    expect(polls.length).toBeGreaterThanOrEqual(1);
    expect(broker.closed).toEqual(["ch_1"]);
  });

  it("replaces an expired channel with a fresh one and fresh pairing material", async () => {
    const broker = await fakeBroker({ expiredChannels: 1 });
    const materials: PairingMaterial[] = [];
    const session = await requestEphemeralSession(baseOptions(broker.fetchImpl, {
      channelRegenerations: 2,
      onPairingMaterial: (material) => materials.push(material)
    }));
    expect(session.deviceId).toBe("FF1-FIXTURE1");
    expect(materials.map((material) => material.appLink)).toEqual([
      "https://link.feralfile.com/pair?channel=ch_1&token=pt_secret_1",
      "https://link.feralfile.com/pair?channel=ch_2&token=pt_secret_2"
    ]);
    expect(materials.map((material) => material.shortCode)).toEqual(["123451", "123452"]);
    expect(broker.closed).toEqual(["ch_1"]);
    // Each channel gets its own browser key pair.
    expect(broker.channels[0]?.createBody["browserPublicKeyJwk"]).not.toEqual(broker.channels[1]?.createBody["browserPublicKeyJwk"]);
    expect(broker.mintRequests.map((request) => request.channelId)).toEqual(["ch_2"]);
  });

  it("gives up with approval_timeout once the replacement channels also expire", async () => {
    const broker = await fakeBroker({ expiredChannels: 3 });
    const materials: PairingMaterial[] = [];
    const error = await captureError(requestEphemeralSession(baseOptions(broker.fetchImpl, {
      channelRegenerations: 2,
      onPairingMaterial: (material) => materials.push(material)
    })));
    expect((error as PlayError).code).toBe("approval_timeout");
    expectNoSecrets(error);
    expect(materials).toHaveLength(3);
    expect(broker.closed).toEqual(["ch_1", "ch_2", "ch_3"]);
  });

  it.each([-1, 6, 0.5])("rejects channelRegenerations %s", async (channelRegenerations) => {
    const broker = await fakeBroker();
    await expect(requestEphemeralSession(baseOptions(broker.fetchImpl, { channelRegenerations }))).rejects.toThrow(/channelRegenerations/);
  });

  it("stops with pairing_canceled and closes the channel when aborted while waiting", async () => {
    const broker = await fakeBroker({ waitingPolls: Number.MAX_SAFE_INTEGER });
    const controller = new AbortController();
    const error = await captureError(requestEphemeralSession(baseOptions(broker.fetchImpl, {
      pollIntervalMs: 5,
      signal: controller.signal,
      onPairingMaterial: () => {
        setTimeout(() => {
          controller.abort();
        }, 20);
      }
    })));
    expect((error as PlayError).code).toBe("pairing_canceled");
    expectNoSecrets(error);
    expect(broker.closed).toEqual(["ch_1"]);
    expect(broker.mintRequests).toEqual([]);
  });

  it("hands out no pairing material when the cancel lands while the channel is created", async () => {
    const broker = await fakeBroker({ waitingPolls: Number.MAX_SAFE_INTEGER });
    const controller = new AbortController();
    // The create call resolves after the visitor has already canceled.
    const fetcher: typeof fetch = async (input, init) => {
      const response = await broker.fetchImpl(input, init);
      const url = input instanceof Request ? input.url : input.toString();
      if (url.endsWith("/v1/channels") && init?.method === "POST") {
        controller.abort();
      }
      return response;
    };
    const materials: unknown[] = [];
    const error = await captureError(requestEphemeralSession(baseOptions(fetcher, {
      pollIntervalMs: 5,
      signal: controller.signal,
      onPairingMaterial: (material) => materials.push(material)
    })));
    expect((error as PlayError).code).toBe("pairing_canceled");
    expect(materials).toEqual([]);
    expect(broker.closed).toEqual(["ch_1"]);
  });

  it("maps a declined approval to mint_rejected without storing", async () => {
    const error = await captureError(runMintFlow({ result: { type: "mint_rejected" } }));
    expect((error as PlayError).code).toBe("mint_rejected");
    expect(await readStoredDisplayGrant(testOrigin)).toBeUndefined();
  });

  it.each([
    { reason: "display_grant_unavailable", code: "device_unsupported" },
    { reason: "too_many_sites", code: "too_many_sites" },
    { reason: "approval_expired", code: "approval_timeout" },
    { reason: "denied", code: "mint_rejected" },
    { reason: "something_new", code: "mint_rejected" }
  ])("maps a mint_rejected reason $reason to $code", async ({ reason, code }) => {
    const error = await captureError(runMintFlow({ result: { type: "mint_rejected", reason } }));
    expect((error as PlayError).code).toBe(code);
    expect(await readStoredDisplayGrant(testOrigin)).toBeUndefined();
  });

  it("throws device_unsupported for a mint_succeeded without a displayGrant and discards the session", async () => {
    // Firmware without display grants ignores the keys and mints a session.
    const error = await captureError(runMintFlow({ result: { type: "mint_succeeded", legacySession: true } }));
    expect((error as PlayError).code).toBe("device_unsupported");
    expectNoSecrets(error);
    expect(await readStoredDisplayGrant(testOrigin)).toBeUndefined();
    expect(globalThis.localStorage).toBeUndefined();
  });

  it.each([
    { type: "mint_succeeded", name: "omits requestMessageId", requestMessageId: null },
    { type: "mint_succeeded", name: "uses a mismatched requestMessageId", requestMessageId: "msg_wrong_request" },
    { type: "mint_rejected", name: "omits requestMessageId", requestMessageId: null },
    { type: "mint_rejected", name: "uses a mismatched requestMessageId", requestMessageId: "msg_wrong_request" }
  ] as const)("rejects a decrypted $type result that $name", async ({ type, requestMessageId }) => {
    await expect(runMintFlow({ result: { type, requestMessageId } })).rejects.toThrow("mint result invalid");
    expect(await readStoredDisplayGrant(testOrigin)).toBeUndefined();
  });

  it.each([
    { name: "malformed", expiresAt: "not-a-date" },
    { name: "already expired", expiresAt: "2000-01-01T00:00:00.000Z" }
  ])("rejects a grant with $name expiresAt without storing", async ({ expiresAt }) => {
    await expect(runMintFlow({ result: { type: "mint_succeeded", expiresAt } })).rejects.toThrow("mint result invalid");
    expect(await readStoredDisplayGrant(testOrigin)).toBeUndefined();
  });

  it.each([
    { name: "a ctl that is not the thumbprint of the keys it sent", result: { ctl: "S2bVJ1g34d-xMnRk7wxaTtosj_vyZVYY4ywk4R4UEDY" } },
    { name: "a profile with an extra member", result: { profile: { v: 1, dev: "FF1-FIXTURE1", gen: "772x9uI4OcVjB0inn2MHLA", sig: {}, enc: {}, extra: 1 } } },
    { name: "a profile whose key carries a private member", result: { profile: undefined } },
    { name: "a relay endpoint with a path", result: { relayV2Endpoint: "https://relay.example/v2" } },
    { name: "a plaintext ws: relay endpoint", result: { relayV2Endpoint: "ws://relay.example" } },
    { name: "a plaintext http: relay endpoint", result: { relayV2Endpoint: "http://relay.example" } },
    { name: "a relay endpoint with credentials", result: { relayV2Endpoint: "https://user:pw@relay.example" } }
  ])("rejects a grant with $name without storing", async ({ result }) => {
    const broker = await fakeBroker();
    const profile = result.profile === undefined && "profile" in result ? { ...broker.device.profile, sig: broker.device.sig } : result.profile;
    const withBroker = await fakeBroker({ result: { type: "mint_succeeded", ...result, ...(profile === undefined ? {} : { profile }) } });
    await expect(requestEphemeralSession(baseOptions(withBroker.fetchImpl))).rejects.toThrow("mint result invalid");
    expect(await readStoredDisplayGrant(testOrigin)).toBeUndefined();
  });

  it("declares support for owner-kept grants in every mint request", async () => {
    const { mintRequest } = await runMintFlow();
    expect(mintRequest["supportsPersistentSessions"]).toBe(true);
  });

  it("sends the requested lifetime in the mint request when set", async () => {
    const { mintRequest } = await runMintFlow({ requestedExpiresInSeconds: 3600 });
    expect(mintRequest["type"]).toBe("mint_request");
    expect(mintRequest["requestedExpiresInSeconds"]).toBe(3600);
  });

  it("omits the requested lifetime when unset", async () => {
    const { mintRequest } = await runMintFlow();
    expect(mintRequest["type"]).toBe("mint_request");
    expect(mintRequest).not.toHaveProperty("requestedExpiresInSeconds");
  });

  it("announces the mint request at create under the id its encrypted copy carries", async () => {
    const broker = await fakeBroker();
    await requestEphemeralSession(baseOptions(broker.fetchImpl, { requestedExpiresInSeconds: 600 }));

    const announced = broker.channels[0]?.createBody["mintRequest"] as Record<string, unknown> | undefined;
    const sent = broker.mintRequests[0];
    if (announced === undefined || sent === undefined) {
      throw new Error("mint request was not announced and sent");
    }
    expect(announced).toEqual({
      v: 1,
      requestMessageId: sent.envelope["messageId"],
      supportsPersistentSessions: true,
      requestedExpiresInSeconds: 600,
      requestedAt: sent.plaintext["requestedAt"],
      displayGrant: sent.plaintext["displayGrant"]
    });
    expect(sent.plaintext["requestMessageId"]).toBe(announced["requestMessageId"]);
  });

  it("collects an answer the Art Computer gave from the announced request before the page sent its copy", async () => {
    const broker = await fakeBroker({ answersFromCreate: true, waitingPolls: 2 });

    const session = await requestEphemeralSession(baseOptions(broker.fetchImpl));

    expect(session.ctl).toBe(broker.issued[0]?.ctl);
    expect(await readStoredDisplayGrant(testOrigin)).toBeDefined();
    // The encrypted copy still goes out for devices that predate announcing,
    // and the answer is read from the start of the channel.
    expect(broker.mintRequests).toHaveLength(1);
    const urls = broker.requests.map((request) => `${request.init?.method ?? "GET"} ${request.url}`);
    expect(urls.at(-1)).toBe("GET https://pairing.example/v1/channels/ch_1/messages?afterSeq=0");
  });

  it("sends the maximum requested lifetime", async () => {
    const { mintRequest } = await runMintFlow({ requestedExpiresInSeconds: maxRequestedExpiresInSeconds });
    expect(mintRequest["requestedExpiresInSeconds"]).toBe(31_536_000);
  });

  it.each([
    0,
    -60,
    1.5,
    Number.NaN,
    maxRequestedExpiresInSeconds + 1,
    2 ** 53,
    1e21,
    Number.POSITIVE_INFINITY
  ])("rejects a requested lifetime of %s", async (requestedExpiresInSeconds) => {
    await expect(runMintFlow({ requestedExpiresInSeconds })).rejects.toThrow("requestedExpiresInSeconds must be a whole number of seconds from 1 to 31536000");
  });

  it("keeps a timed grant with its expiry", async () => {
    const { session } = await runMintFlow({ result: { type: "mint_succeeded", expiresAt: "2030-01-01T00:00:00.000Z" } });
    expect(session).toEqual({ deviceId: "FF1-FIXTURE1", ctl: session.ctl, expiresAt: "2030-01-01T00:00:00.000Z", persistent: false });
    expect(await readStoredEphemeralBrowserSession(testOrigin)).toEqual(session);
  });

  it.each([
    { name: "omits expiresAt", expiresAt: undefined },
    { name: "sends a null expiresAt", expiresAt: null }
  ])("keeps an owner-kept grant that $name", async ({ expiresAt }) => {
    const { session } = await runMintFlow({ result: { type: "mint_succeeded", ...(expiresAt === undefined ? {} : { expiresAt }) } });
    expect(session).toEqual({ deviceId: "FF1-FIXTURE1", ctl: session.ctl, persistent: true });
    expect(await readStoredEphemeralBrowserSession(testOrigin)).toEqual(session);
  });

  it("does not leak a token from a malformed broker response", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(new Response('{"browserToken":"bt_secret_1",', { status: 201 })));
    const error = await captureError(requestEphemeralSession(baseOptions(fetchImpl)));
    expect((error as Error).message).toBe("channel create failed: invalid response");
    expectNoSecrets(error);
  });

  it("does not wait on a slow channel close before reporting a cancel", async () => {
    const broker = await fakeBroker({ waitingPolls: Number.MAX_SAFE_INTEGER });
    const controller = new AbortController();
    const fetchImpl = vi.fn<typeof fetch>((input, init) => {
      if (init?.method === "DELETE") {
        return new Promise<Response>(() => undefined);
      }
      return broker.fetchImpl(input, init);
    });
    const error = await captureError(requestEphemeralSession(baseOptions(fetchImpl, {
      pollIntervalMs: 5,
      signal: controller.signal,
      onPairingMaterial: () => {
        setTimeout(() => {
          controller.abort();
        }, 20);
      }
    })));
    expect((error as PlayError).code).toBe("pairing_canceled");
    expect(fetchImpl.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(true);
  });

  it("expires a channel whose poll stalls past the local deadline", async () => {
    const broker = await fakeBroker();
    const realNow = Date.now.bind(Date);
    let skewMs = 0;
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + skewMs);
    const fetchImpl = vi.fn<typeof fetch>((input, init) => {
      if ((init?.method ?? "GET") === "GET") {
        // The poll hangs until aborted.
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        });
      }
      return broker.fetchImpl(input, init);
    });
    // Every poll hangs, so the final peer check after the deadline also waits
    // out its own bound; step the timers through it.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const state = { settled: false };
    const pending = captureError(requestEphemeralSession(baseOptions(fetchImpl, {
      idleTtlSeconds: 15,
      onPairingMaterial: () => {
        // 10 ms of the channel's life left when the first poll starts.
        skewMs = 15_000 - 10;
      }
    }))).finally(() => {
      state.settled = true;
    });
    for (let step = 0; step < 200 && !state.settled; step += 1) {
      await vi.advanceTimersByTimeAsync(100);
    }
    vi.useRealTimers();
    const error = await pending;
    expect((error as PlayError).code).toBe("pairing_code_expired");
    // Two polls: the one cut off at the deadline, then the bounded final check.
    expect(fetchImpl.mock.calls.filter(([, init]) => (init?.method ?? "GET") === "GET")).toHaveLength(2);
  });

  it("times out with approval_timeout when a result poll stalls past maxWaitMs", async () => {
    const broker = await fakeBroker();
    const fetchImpl = vi.fn<typeof fetch>((input, init) => {
      if (broker.mintRequests.length > 0 && (init?.method ?? "GET") === "GET") {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        });
      }
      return broker.fetchImpl(input, init);
    });
    const error = await captureError(requestEphemeralSession(baseOptions(fetchImpl, { maxWaitMs: 30 })));
    expect((error as PlayError).code).toBe("approval_timeout");
    expect(broker.channels).toHaveLength(1);
  });

  it("times out with approval_timeout when the mint_request POST never resolves", async () => {
    const broker = await fakeBroker();
    const fetchImpl = vi.fn<typeof fetch>((input, init) => {
      if (init?.method === "POST" && requestUrl(input).endsWith("/messages")) {
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        });
      }
      return broker.fetchImpl(input, init);
    });
    const error = await captureError(requestEphemeralSession(baseOptions(fetchImpl, { maxWaitMs: 30 })));
    expect((error as PlayError).code).toBe("approval_timeout");
    expectNoSecrets(error);
  });

  it("treats a 410 on the mint_request POST as channel expiry", async () => {
    const broker = await fakeBroker();
    const fetchImpl = vi.fn<typeof fetch>((input, init) => {
      if (init?.method === "POST" && requestUrl(input).endsWith("/messages")) {
        return Promise.resolve(jsonResponse({ error: "expired" }, 410));
      }
      return broker.fetchImpl(input, init);
    });
    const error = await captureError(requestEphemeralSession(baseOptions(fetchImpl)));
    expect((error as PlayError).code).toBe("pairing_code_expired");
    expectNoSecrets(error);
    expect(broker.closed).toEqual(["ch_1"]);
  });

  it("regenerates when the channel expires between the peer joining and the request landing", async () => {
    const broker = await fakeBroker();
    let sends = 0;
    const materials: PairingMaterial[] = [];
    const fetchImpl = vi.fn<typeof fetch>((input, init) => {
      if (init?.method === "POST" && requestUrl(input).endsWith("/messages")) {
        sends += 1;
        if (sends === 1) {
          return Promise.resolve(jsonResponse({ error: "not_found" }, 404));
        }
      }
      return broker.fetchImpl(input, init);
    });
    const session = await requestEphemeralSession(baseOptions(fetchImpl, {
      channelRegenerations: 1,
      onPairingMaterial: (material) => materials.push(material)
    }));
    expect(session.deviceId).toBe("FF1-FIXTURE1");
    expect(materials.map((material) => material.shortCode)).toEqual(["123451", "123452"]);
    expect(broker.mintRequests.map((request) => request.channelId)).toEqual(["ch_2"]);
  });

  it("starts the channel clock after a slow create returns", async () => {
    const broker = await fakeBroker();
    const realNow = Date.now.bind(Date);
    let skewMs = 0;
    vi.spyOn(Date, "now").mockImplementation(() => realNow() + skewMs);
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const response = await broker.fetchImpl(input, init);
      if (requestUrl(input) === `${brokerBaseUrl}/v1/channels`) {
        // The create took longer than the channel's whole idle lifetime.
        skewMs += 16_000;
      }
      return response;
    });
    const session = await requestEphemeralSession(baseOptions(fetchImpl, { idleTtlSeconds: 15 }));
    expect(session.deviceId).toBe("FF1-FIXTURE1");
  });

  it("does not post the mint_request when the visitor cancels during encryption", async () => {
    const broker = await fakeBroker();
    const controller = new AbortController();
    const subtle = globalThis.crypto.subtle;
    const realEncrypt = subtle.encrypt.bind(subtle);
    vi.spyOn(subtle, "encrypt").mockImplementation((...args: Parameters<SubtleCrypto["encrypt"]>) => {
      controller.abort();
      return realEncrypt(...args);
    });
    const error = await captureError(requestEphemeralSession(baseOptions(broker.fetchImpl, { signal: controller.signal })));
    expect((error as PlayError).code).toBe("pairing_canceled");
    expect(broker.fetchImpl.mock.calls.some(([input, init]) => init?.method === "POST" && requestUrl(input).endsWith("/messages"))).toBe(false);
    expect(broker.mintRequests).toEqual([]);
  });

  it("honours a cancel that lands while the result is being read, without storing", async () => {
    const broker = await fakeBroker();
    const controller = new AbortController();
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const response = await broker.fetchImpl(input, init);
      if (broker.mintRequests.length > 0 && (init?.method ?? "GET") === "GET") {
        controller.abort();
      }
      return response;
    });
    const error = await captureError(requestEphemeralSession(baseOptions(fetchImpl, { signal: controller.signal })));
    expect((error as PlayError).code).toBe("pairing_canceled");
    expect(await readStoredDisplayGrant(testOrigin)).toBeUndefined();
  });

  it("returns a stored grant without creating a channel", async () => {
    const broker = await fakeBroker();
    const { record } = await seedGrant(testOrigin);
    const session = await requestEphemeralSession(baseOptions(broker.fetchImpl));
    expect(session).toEqual({ deviceId: "FF1-FIXTURE1", ctl: record.ctl, persistent: true });
    expect(broker.fetchImpl).not.toHaveBeenCalled();
  });

  it("removes a stored 0.4 session record on first use, so the site pairs once more", async () => {
    const entries = new Map<string, string>([
      [legacySessionStorageKey(testOrigin), JSON.stringify({ token: "token-secret", sessionId: "sess_old", origin: testOrigin })],
      [legacySessionStorageKey("https://other.example"), "kept"]
    ]);
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: { removeItem: (key: string) => entries.delete(key) }
    });
    try {
      const broker = await fakeBroker();
      const session = await requestEphemeralSession(baseOptions(broker.fetchImpl));
      expect(session.deviceId).toBe("FF1-FIXTURE1");
      expect(broker.channels).toHaveLength(1);
      expect([...entries.keys()]).toEqual([legacySessionStorageKey("https://other.example")]);
    } finally {
      Reflect.deleteProperty(globalThis, "localStorage");
    }
  });

  it("re-pairs past a stored grant's expiry and replaces it without revoking the expired grant", async () => {
    const { record: old } = await seedGrant(testOrigin, { expiresAt: "2000-01-01T00:00:00.000Z", persistent: false, ctr: 5 });
    const relay = fakeRelay({ peers: [] });
    const broker = await fakeBroker();

    const session = await requestEphemeralSession(baseOptions(broker.fetchImpl, { socketFactory: relay.socketFactory }));

    expect(session.ctl).not.toBe(old.ctl);
    expect((await readStoredDisplayGrant(testOrigin))?.ctl).toBe(session.ctl);
    // An expired grant is dead on the device already: nothing to revoke.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(relay.sockets).toHaveLength(0);
  });

  it("accepts a wss: relay endpoint", async () => {
    const broker = await fakeBroker({ result: { type: "mint_succeeded", relayV2Endpoint: "wss://relay.example" } });
    await requestEphemeralSession(baseOptions(broker.fetchImpl));
    expect((await readStoredDisplayGrant(testOrigin))?.relayV2Endpoint).toBe("wss://relay.example");
  });

  it("revokes the grant another tab stored meanwhile, not the one read at the start", async () => {
    await seedGrant(testOrigin, { expiresAt: "2000-01-01T00:00:00.000Z", persistent: false });
    const concurrent = await seedGrant("https://other.example");
    const relay = deviceOnRelay({ [concurrent.record.ctl]: concurrent.sig });
    const broker = await fakeBroker();
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const response = await broker.fetchImpl(input, init);
      if (init?.method === "POST" && requestUrl(input).endsWith("/messages")) {
        // Another tab finished its own pairing while this one waited.
        await replaceStoredDisplayGrant({ ...concurrent.record, origin: testOrigin });
      }
      return response;
    });
    await requestEphemeralSession(baseOptions(fetchImpl, { socketFactory: relay.socketFactory }));
    for (let tick = 0; tick < 200 && relay.sockets[0]?.closed !== true; tick += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(relay.ff1.seen[0]).toMatchObject({ ctl: concurrent.record.ctl, cmd: "revokeController" });
  });

  it("leaves the stored grant untouched and revokes nothing when a re-pair is refused", async () => {
    const { record: old, sig: oldSig } = await seedGrant(testOrigin, { expiresAt: "2000-01-01T00:00:00.000Z", persistent: false });
    const relay = deviceOnRelay({ [old.ctl]: oldSig });
    const broker = await fakeBroker({ result: { type: "mint_rejected" } });

    const error = await captureError(requestEphemeralSession(baseOptions(broker.fetchImpl, { socketFactory: relay.socketFactory })));

    expect((error as PlayError).code).toBe("mint_rejected");
    expect((await readStoredDisplayGrant(testOrigin))?.ctl).toBe(old.ctl);
    expect(relay.sockets).toHaveLength(0);
  });

  it.each([
    { name: "an invalid mint result", options: { result: { type: "mint_succeeded", ctl: "" } } },
    { name: "a failed mint_request send", options: { sendStatus: 500 } },
    { name: "an expired channel", options: { expiredChannels: 1 } },
    { name: "a declined approval", options: { result: { type: "mint_rejected" } } }
  ] satisfies { name: string; options: FakeBrokerOptions }[])("does not leak tokens in the error for $name", async ({ options }) => {
    const broker = await fakeBroker(options);
    const error = await captureError(requestEphemeralSession(baseOptions(broker.fetchImpl)));
    expect(error).toBeInstanceOf(Error);
    expectNoSecrets(error);
  });

  it("reads back a stored grant by origin and drops an expired one", async () => {
    const { record } = await seedGrant(testOrigin, { expiresAt: "2030-01-01T00:00:00.000Z", persistent: false });
    expect(await readStoredEphemeralBrowserSession(testOrigin)).toEqual({ deviceId: "FF1-FIXTURE1", ctl: record.ctl, expiresAt: "2030-01-01T00:00:00.000Z", persistent: false });
    expect(await readStoredEphemeralBrowserSession("https://other.example")).toBeUndefined();
    await seedGrant(testOrigin, { expiresAt: "2000-01-01T00:00:00.000Z", persistent: false });
    expect(await readStoredEphemeralBrowserSession(testOrigin)).toBeUndefined();
    expect(await readStoredDisplayGrant(testOrigin)).toBeUndefined();
  });
});

describe("0.4 transport removal", () => {
  it("leaves no relayer /api/cast or bearer-token code in the library", () => {
    const srcDir = path.join(import.meta.dirname, "..", "src");
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.name.endsWith(".ts")) {
          files.push(full);
        }
      }
    };
    walk(srcDir);
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      expect(text, file).not.toMatch(/\/api\/cast/);
      expect(text, file).not.toMatch(/Bearer \$\{options\.session/);
      expect(text, file).not.toMatch(/relayerBaseUrl/);
    }
  });
});
