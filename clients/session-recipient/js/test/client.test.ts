import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  displayDp1Playlist,
  ephemeralBrowserSessionStorageKey,
  maxRequestedExpiresInSeconds,
  readStoredEphemeralBrowserSession,
  requestEphemeralSession,
  storeEphemeralBrowserSession,
  type EphemeralBrowserSession,
  type RequestEphemeralSessionOptions,
  type TokenStorage
} from "../src/client.js";
import { base64UrlDecode, decryptChannelMessage, generateBrowserKeyPair } from "../src/crypto.js";
import {
  authorizationHeader,
  brokerBaseUrl,
  captureError,
  expectNoSecrets,
  fakeBroker,
  jsonResponse,
  memoryStorage,
  requestBody,
  requestUrl,
  type FakeBrokerOptions,
  type ResultKind
} from "./fakeBroker.js";
import { PlayError } from "../src/errors.js";
import type { PairingMaterial } from "../src/pairingPayload.js";

const testOrigin = "https://nft.example";
const algorithmName = "P256-HKDF-SHA256-AES-256-GCM";
let previousLocationDescriptor: PropertyDescriptor | undefined;
let previousFetchDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
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
    storage: false,
    pollIntervalMs: 1,
    fetchImpl,
    ...overrides
  };
}

/** Runs the happy-path mint flow and returns the session plus the decrypted mint request. */
async function runMintFlow(input: {
  requestedExpiresInSeconds?: number;
  result?: ResultKind;
  storage?: TokenStorage;
} = {}): Promise<{ session: EphemeralBrowserSession; mintRequest: Record<string, unknown> }> {
  const broker = await fakeBroker(input.result === undefined ? {} : { result: input.result });
  const session = await requestEphemeralSession(baseOptions(broker.fetchImpl, {
    storage: input.storage === undefined ? false : { storage: input.storage },
    ...(input.requestedExpiresInSeconds === undefined ? {} : { requestedExpiresInSeconds: input.requestedExpiresInSeconds })
  }));
  const mintRequest = broker.mintRequests[0]?.plaintext;
  if (mintRequest === undefined) {
    throw new Error("mint request was never sent");
  }
  return { session, mintRequest };
}

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

    const session = await requestEphemeralSession({ brokerBaseUrl, storage: false, pollIntervalMs: 1 });

    expect(session.sessionId).toBe("sess_123");
    expect(receiverCheckedFetch).toHaveBeenCalledTimes(5);
  });

  it("creates a browser channel, hands out pairing material, waits for the peer, and stores the session by origin", async () => {
    const broker = await fakeBroker({ waitingPolls: 2 });
    const storage = memoryStorage();
    const materials: PairingMaterial[] = [];
    const onPeerJoined = vi.fn();

    const session = await requestEphemeralSession(baseOptions(broker.fetchImpl, {
      browserInfo: { name: "Test Browser", label: "Test Gallery" },
      storage: { storage },
      onPairingMaterial: (material) => {
        expect(onPeerJoined).not.toHaveBeenCalled();
        materials.push(material);
      },
      onPeerJoined
    }));

    expect(session).toEqual({
      token: "browser-session-token-secret",
      sessionId: "sess_123",
      expiresAt: "2030-01-01T00:00:00.000Z",
      relayerBaseUrl: "https://relayer.example"
    });
    expect(storage.entries.has(ephemeralBrowserSessionStorageKey(testOrigin))).toBe(true);
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
      "GET https://pairing.example/v1/channels/ch_1/messages?afterSeq=1"
    ]);
    expect(broker.closed).toEqual([]);
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
      requestedAt: expect.any(String) as unknown
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
    expect(session.sessionId).toBe("sess_123");
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

  it("replaces an expired channel with a fresh one and fresh pairing material", async () => {
    const broker = await fakeBroker({ expiredChannels: 1 });
    const materials: PairingMaterial[] = [];
    const session = await requestEphemeralSession(baseOptions(broker.fetchImpl, {
      channelRegenerations: 2,
      onPairingMaterial: (material) => materials.push(material)
    }));
    expect(session.sessionId).toBe("sess_123");
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

  it("maps a declined approval to mint_rejected without storing", async () => {
    const storage = memoryStorage();
    const error = await captureError(runMintFlow({ result: { type: "mint_rejected" }, storage }));
    expect((error as PlayError).code).toBe("mint_rejected");
    expect(storage.entries.size).toBe(0);
  });

  it.each([
    { type: "mint_succeeded", name: "omits requestMessageId", requestMessageId: null },
    { type: "mint_succeeded", name: "uses a mismatched requestMessageId", requestMessageId: "msg_wrong_request" },
    { type: "mint_rejected", name: "omits requestMessageId", requestMessageId: null },
    { type: "mint_rejected", name: "uses a mismatched requestMessageId", requestMessageId: "msg_wrong_request" }
  ] as const)("rejects a decrypted $type result that $name", async ({ type, requestMessageId }) => {
    const storage = memoryStorage();
    await expect(runMintFlow({ result: { type, requestMessageId }, storage })).rejects.toThrow("mint result invalid");
    expect(storage.entries.size).toBe(0);
  });

  it.each([
    { name: "malformed", expiresAt: "not-a-date" },
    { name: "already expired", expiresAt: "2000-01-01T00:00:00.000Z" }
  ])("rejects a decrypted mint_succeeded result with $name expiresAt without storing", async ({ expiresAt }) => {
    const storage = memoryStorage();
    await expect(runMintFlow({ result: { type: "mint_succeeded", expiresAt }, storage })).rejects.toThrow("mint result invalid");
    expect(storage.entries.size).toBe(0);
  });

  it("declares support for owner-kept sessions in every mint request", async () => {
    const { mintRequest } = await runMintFlow();
    expect(mintRequest["supportsPersistentSessions"]).toBe(true);
  });

  it("sends the requested session lifetime in the mint request when set", async () => {
    const { mintRequest } = await runMintFlow({ requestedExpiresInSeconds: 3600 });
    expect(mintRequest["type"]).toBe("mint_request");
    expect(mintRequest["requestedExpiresInSeconds"]).toBe(3600);
  });

  it("omits the requested session lifetime when unset", async () => {
    const { mintRequest } = await runMintFlow();
    expect(mintRequest["type"]).toBe("mint_request");
    expect(mintRequest).not.toHaveProperty("requestedExpiresInSeconds");
  });

  it("sends the maximum requested session lifetime", async () => {
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
  ])("rejects a requested session lifetime of %s", async (requestedExpiresInSeconds) => {
    await expect(runMintFlow({ requestedExpiresInSeconds })).rejects.toThrow("requestedExpiresInSeconds must be a whole number of seconds from 1 to 31536000");
  });

  it.each([
    { name: "omits expiresAt", expiresAt: undefined },
    { name: "sends a null expiresAt", expiresAt: null }
  ])("keeps an owner-kept session that $name", async ({ expiresAt }) => {
    const storage = memoryStorage();
    const { session } = await runMintFlow({
      result: { type: "mint_succeeded", persistent: true, ...(expiresAt === undefined ? {} : { expiresAt }) },
      storage
    });
    expect(session).toEqual({
      token: "browser-session-token-secret",
      sessionId: "sess_123",
      persistent: true,
      relayerBaseUrl: "https://relayer.example"
    });
    expect(readStoredEphemeralBrowserSession(storage, testOrigin)).toEqual(session);
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
    const error = await captureError(requestEphemeralSession(baseOptions(fetchImpl, {
      idleTtlSeconds: 15,
      onPairingMaterial: () => {
        // 10 ms of the channel's life left when the first poll starts.
        skewMs = 15_000 - 10;
      }
    })));
    expect((error as PlayError).code).toBe("pairing_code_expired");
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

  it("honours a cancel that lands while the result is being read, without storing", async () => {
    const broker = await fakeBroker();
    const storage = memoryStorage();
    const controller = new AbortController();
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const response = await broker.fetchImpl(input, init);
      if (broker.mintRequests.length > 0 && (init?.method ?? "GET") === "GET") {
        controller.abort();
      }
      return response;
    });
    const error = await captureError(requestEphemeralSession(baseOptions(fetchImpl, { storage: { storage }, signal: controller.signal })));
    expect((error as PlayError).code).toBe("pairing_canceled");
    expect(storage.entries.size).toBe(0);
  });

  it("returns a stored session without creating a channel", async () => {
    const broker = await fakeBroker();
    const storage = memoryStorage();
    storeEphemeralBrowserSession(storage, testOrigin, { token: "token-stored", sessionId: "sess_stored", expiresAt: "2030-01-01T00:00:00.000Z" });
    const session = await requestEphemeralSession(baseOptions(broker.fetchImpl, { storage: { storage } }));
    expect(session.sessionId).toBe("sess_stored");
    expect(broker.fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    { name: "an invalid mint result carrying a token", options: { result: { type: "mint_succeeded", sessionId: "" } } },
    { name: "a failed mint_request send", options: { sendStatus: 500 } },
    { name: "an expired channel", options: { expiredChannels: 1 } },
    { name: "a declined approval", options: { result: { type: "mint_rejected" } } }
  ] satisfies { name: string; options: FakeBrokerOptions }[])("does not leak tokens in the error for $name", async ({ options }) => {
    const broker = await fakeBroker(options);
    const error = await captureError(requestEphemeralSession(baseOptions(broker.fetchImpl)));
    expect(error).toBeInstanceOf(Error);
    expectNoSecrets(error);
  });

  it("keeps storage keys origin scoped", () => {
    const storage = memoryStorage();
    storeEphemeralBrowserSession(storage, "https://nft.example", {
      token: "token-a",
      sessionId: "sess_a",
      expiresAt: "2030-01-01T00:00:00.000Z"
    });
    storeEphemeralBrowserSession(storage, "https://other.example", {
      token: "token-b",
      sessionId: "sess_b",
      expiresAt: "2030-01-01T00:00:00.000Z"
    });
    expect(ephemeralBrowserSessionStorageKey("https://nft.example")).not.toBe(ephemeralBrowserSessionStorageKey("https://other.example"));
    expect(readStoredEphemeralBrowserSession(storage, "https://nft.example")?.token).toBe("token-a");
    expect(readStoredEphemeralBrowserSession(storage, "https://other.example")?.token).toBe("token-b");
    storage.setItem(ephemeralBrowserSessionStorageKey("https://broken.example"), "{");
    expect(readStoredEphemeralBrowserSession(storage, "https://broken.example")).toBeUndefined();
  });

  it.each([
    { name: "null", expiresAt: null },
    { name: "absent", expiresAt: undefined }
  ])("treats a stored session with $name expiresAt as valid", ({ expiresAt }) => {
    const storage = memoryStorage();
    storage.setItem(ephemeralBrowserSessionStorageKey(testOrigin), JSON.stringify({
      token: "token-kept",
      sessionId: "sess_kept",
      persistent: true,
      ...(expiresAt === undefined ? {} : { expiresAt }),
      origin: testOrigin,
      storedAt: "2026-01-01T00:00:00.000Z"
    }));
    expect(readStoredEphemeralBrowserSession(storage, testOrigin)).toEqual({
      token: "token-kept",
      sessionId: "sess_kept",
      persistent: true
    });
  });

  it.each([
    { name: "null", expiresAt: null },
    { name: "absent", expiresAt: undefined }
  ])("rejects and clears a stored session with $name expiresAt and no persistent marker", ({ expiresAt }) => {
    const storage = memoryStorage();
    const key = ephemeralBrowserSessionStorageKey(testOrigin);
    storage.setItem(key, JSON.stringify({
      token: "token-unmarked",
      sessionId: "sess_unmarked",
      ...(expiresAt === undefined ? {} : { expiresAt }),
      origin: testOrigin,
      storedAt: "2026-01-01T00:00:00.000Z"
    }));
    expect(readStoredEphemeralBrowserSession(storage, testOrigin)).toBeUndefined();
    expect(storage.entries.has(key)).toBe(false);
  });

  it("clears a stored session it can no longer use", () => {
    const storage = memoryStorage();
    const key = ephemeralBrowserSessionStorageKey(testOrigin);
    storeEphemeralBrowserSession(storage, testOrigin, {
      token: "token-timed",
      sessionId: "sess_timed",
      expiresAt: "2000-01-01T00:00:00.000Z"
    });
    expect(readStoredEphemeralBrowserSession(storage, testOrigin)).toBeUndefined();
    expect(storage.entries.has(key)).toBe(false);
    storage.setItem(key, "{");
    expect(readStoredEphemeralBrowserSession(storage, testOrigin)).toBeUndefined();
    expect(storage.entries.has(key)).toBe(false);
  });

  it("still expires a stored timed session", () => {
    const storage = memoryStorage();
    storeEphemeralBrowserSession(storage, testOrigin, {
      token: "token-timed",
      sessionId: "sess_timed",
      expiresAt: "2030-01-01T00:00:00.000Z"
    });
    expect(readStoredEphemeralBrowserSession(storage, testOrigin)?.sessionId).toBe("sess_timed");
    storeEphemeralBrowserSession(storage, testOrigin, {
      token: "token-timed",
      sessionId: "sess_timed",
      expiresAt: "2000-01-01T00:00:00.000Z"
    });
    expect(readStoredEphemeralBrowserSession(storage, testOrigin)).toBeUndefined();
  });

});

describe("displayDp1Playlist", () => {
  it("wraps a DP1 playlist in the FF1 display command envelope", async () => {
    const fetchImpl = vi.fn<typeof fetch>((_input, init) => {
      expect(init?.method).toBe("POST");
      expect(authorizationHeader(init)).toBe("Bearer browser-session-token");
      expect(requestBody(init)).toEqual({
        command: "displayPlaylist",
        request: {
          intent: {
            action: "now_display"
          },
          dp1_call: {
            dpVersion: "1.1.0",
            title: "Browser Playlist",
            items: []
          }
        }
      });
      return Promise.resolve(jsonResponse({ message: { message: { ok: true } } }));
    });

    await displayDp1Playlist({
      session: {
        token: "browser-session-token",
        sessionId: "sess_123",
        expiresAt: "2030-01-01T00:00:00.000Z",
        relayerBaseUrl: "https://relayer.example/root/"
      },
      playlist: {
        dpVersion: "1.1.0",
        title: "Browser Playlist",
        items: []
      },
      fetchImpl
    });

    expect(requestUrl(fetchImpl.mock.calls[0]?.[0] ?? "")).toBe("https://relayer.example/api/cast");
  });

  it("uses the explicit relayer URL when the session does not include one", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(jsonResponse({ message: { ok: true } })));

    await displayDp1Playlist({
      session: {
        token: "browser-session-token",
        sessionId: "sess_123",
        expiresAt: "2030-01-01T00:00:00.000Z"
      },
      playlist: {
        dpVersion: "1.1.0",
        title: "Browser Playlist",
        items: []
      },
      relayerBaseUrl: "https://fallback-relayer.example",
      fetchImpl
    });

    expect(requestUrl(fetchImpl.mock.calls[0]?.[0] ?? "")).toBe("https://fallback-relayer.example/api/cast");
  });

  it("rejects a browser session rejected by the relayer without leaking the token", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(jsonResponse({ error: "nope" }, 401)));
    const rawToken = "super-secret-browser-session-token";

    await expect(displayDp1Playlist({
      session: {
        token: rawToken,
        sessionId: "sess_123",
        expiresAt: "2030-01-01T00:00:00.000Z",
        relayerBaseUrl: "https://relayer.example"
      },
      playlist: {
        dpVersion: "1.1.0",
        title: "Browser Playlist",
        items: []
      },
      fetchImpl
    })).rejects.not.toThrow(rawToken);
    await expect(displayDp1Playlist({
      session: {
        token: rawToken,
        sessionId: "sess_123",
        expiresAt: "2030-01-01T00:00:00.000Z",
        relayerBaseUrl: "https://relayer.example"
      },
      playlist: {
        dpVersion: "1.1.0",
        title: "Browser Playlist",
        items: []
      },
      fetchImpl
    })).rejects.toThrow("browser session rejected");
  });

  it("rejects an FF1-level display failure without echoing playlist content", async () => {
    const fetchImpl = vi.fn<typeof fetch>(() => Promise.resolve(jsonResponse({
      message: {
        message: {
          ok: false,
          playlistTitle: "Private Playlist"
        }
      }
    })));

    await expect(displayDp1Playlist({
      session: {
        token: "browser-session-token",
        sessionId: "sess_123",
        expiresAt: "2030-01-01T00:00:00.000Z",
        relayerBaseUrl: "https://relayer.example"
      },
      playlist: {
        dpVersion: "1.1.0",
        title: "Private Playlist",
        items: []
      },
      fetchImpl
    })).rejects.toThrow("FF1 rejected display request");
    await expect(displayDp1Playlist({
      session: {
        token: "browser-session-token",
        sessionId: "sess_123",
        expiresAt: "2030-01-01T00:00:00.000Z",
        relayerBaseUrl: "https://relayer.example"
      },
      playlist: {
        dpVersion: "1.1.0",
        title: "Private Playlist",
        items: []
      },
      fetchImpl
    })).rejects.not.toThrow("Private Playlist");
  });

  it("requires a relayer URL", async () => {
    await expect(displayDp1Playlist({
      session: {
        token: "browser-session-token",
        sessionId: "sess_123",
        expiresAt: "2030-01-01T00:00:00.000Z"
      },
      playlist: {
        dpVersion: "1.1.0",
        title: "Browser Playlist",
        items: []
      },
      relayerBaseUrl: " "
    })).rejects.toThrow("relayer base URL is required");
  });
});
