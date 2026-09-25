import { expect, vi } from "vitest";
import { decryptChannelMessage, encryptChannelMessage, exportPublicJwk, generateBrowserKeyPair } from "../src/crypto.js";
import type { JsonValue } from "../src/canonicalJson.js";
import type { TokenStorage } from "../src/client.js";

export type RequestRecord = {
  url: string;
  init: RequestInit | undefined;
};

export const brokerBaseUrl = "https://pairing.example";

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export function requestBody(init: RequestInit | undefined): Record<string, unknown> {
  if (typeof init?.body !== "string") {
    throw new Error("expected string request body");
  }
  return JSON.parse(init.body) as Record<string, unknown>;
}

export function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
}

export function authorizationHeader(init: RequestInit | undefined): string | null {
  const headers = new Headers(init?.headers);
  return headers.get("authorization");
}

export function memoryStorage(): TokenStorage & { entries: Map<string, string> } {
  const entries = new Map<string, string>();
  return {
    entries,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => {
      entries.set(key, value);
    },
    removeItem: (key) => {
      entries.delete(key);
    }
  };
}

export type ResultKind =
  | { type: "mint_succeeded"; token?: string; sessionId?: string; expiresAt?: string | null; persistent?: boolean; requestMessageId?: string | null }
  | { type: "mint_rejected"; requestMessageId?: string | null };

export type FakeBrokerOptions = {
  /** Waiting polls answered before the Art Computer shows up as the peer. */
  waitingPolls?: number;
  /** The first N channels created answer 410 on their first poll. */
  expiredChannels?: number;
  result?: ResultKind;
  /** Status to answer the mint_request send with (default 201). */
  sendStatus?: number;
  /** Override the create response body (for malformed or legacy brokers). */
  createResponse?: (channelNumber: number) => Response;
  /** Answer waiting polls with a network failure this many times first. */
  networkFailures?: number;
  /** Peer override for the paired poll response. */
  peer?: (minterPublicKeyJwk: JsonWebKey) => unknown;
};

export type CreatedChannel = {
  channelId: string;
  browserToken: string;
  pairingToken: string;
  shortCode: string;
  createBody: Record<string, unknown>;
};

export type SentMintRequest = {
  channelId: string;
  envelope: Record<string, unknown>;
  plaintext: Record<string, unknown>;
};

/**
 * A stubbed broker plus the Art Computer that joins the site's channel. Tokens
 * carry a `secret` marker so tests can assert none of them reaches an error.
 */
export async function fakeBroker(options: FakeBrokerOptions = {}) {
  const minterKeyPair = await generateBrowserKeyPair();
  const minterPublicKeyJwk = await exportPublicJwk(minterKeyPair.publicKey);
  const requests: RequestRecord[] = [];
  const channels: CreatedChannel[] = [];
  const mintRequests: SentMintRequest[] = [];
  const closed: string[] = [];
  const pollsByChannel = new Map<string, number>();
  let networkFailures = options.networkFailures ?? 0;

  function channelFor(url: string): CreatedChannel {
    const match = /\/v1\/channels\/([^/?]+)/.exec(url);
    const channel = channels.find((candidate) => candidate.channelId === match?.[1]);
    if (channel === undefined) {
      throw new Error(`unknown channel in ${url}`);
    }
    return channel;
  }

  async function resultResponse(channel: CreatedChannel, request: SentMintRequest): Promise<Response> {
    const result = options.result ?? { type: "mint_succeeded" };
    const requestMessageId = result.requestMessageId === undefined
      ? request.plaintext["requestMessageId"] as string
      : result.requestMessageId;
    let plaintext: Record<string, JsonValue>;
    if (result.type === "mint_rejected") {
      plaintext = { v: 1, type: "mint_rejected", channelId: channel.channelId, reason: "denied" };
    } else {
      const session: Record<string, JsonValue> = {
        token: result.token ?? "browser-session-token-secret",
        sessionId: result.sessionId ?? "sess_123",
        relayerBaseUrl: "https://relayer.example"
      };
      if (result.persistent === true) {
        session["persistent"] = true;
      }
      if (result.expiresAt !== undefined) {
        session["expiresAt"] = result.expiresAt;
      } else if (result.persistent !== true) {
        session["expiresAt"] = "2030-01-01T00:00:00.000Z";
      }
      plaintext = { v: 1, type: "mint_succeeded", channelId: channel.channelId, session };
    }
    if (requestMessageId !== null) {
      plaintext["requestMessageId"] = requestMessageId;
    }
    const encrypted = await encryptChannelMessage({
      privateKey: minterKeyPair.privateKey,
      senderPublicJwk: minterPublicKeyJwk,
      peerPublicJwk: request.plaintext["browserPublicKeyJwk"] as JsonWebKey,
      channelId: channel.channelId,
      messageId: "msg_result",
      seq: 0,
      sender: "minter",
      recipient: "browser",
      plaintext
    });
    return jsonResponse({
      channelId: channel.channelId,
      status: "paired",
      expiresAt: "2030-01-01T00:00:00.000Z",
      peer: { role: "minter", publicKeyJwk: minterPublicKeyJwk },
      messages: [{ seq: 2, ...encrypted }]
    });
  }

  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const url = requestUrl(input);
    requests.push({ url, init });
    const method = init?.method ?? "GET";
    if (url === `${brokerBaseUrl}/v1/channels` && method === "POST") {
      const channelNumber = channels.length + 1;
      const createBody = requestBody(init);
      const channel: CreatedChannel = {
        channelId: `ch_${String(channelNumber)}`,
        browserToken: `bt_secret_${String(channelNumber)}`,
        pairingToken: `pt_secret_${String(channelNumber)}`,
        shortCode: `12345${String(channelNumber)}`,
        createBody
      };
      channels.push(channel);
      if (options.createResponse !== undefined) {
        return options.createResponse(channelNumber);
      }
      return jsonResponse({
        channelId: channel.channelId,
        creatorRole: "browser",
        browserToken: channel.browserToken,
        pairingToken: channel.pairingToken,
        shortCode: channel.shortCode,
        expiresAt: "2030-01-01T00:00:00.000Z"
      }, 201);
    }
    const channel = channelFor(url);
    expect(authorizationHeader(init)).toBe(`Bearer ${channel.browserToken}`);
    if (method === "DELETE") {
      closed.push(channel.channelId);
      return jsonResponse({ channelId: channel.channelId, status: "closed" });
    }
    if (method === "POST" && url.endsWith("/messages")) {
      const envelope = requestBody(init);
      const plaintext = await decryptChannelMessage({
        privateKey: minterKeyPair.privateKey,
        peerPublicJwk: envelope["senderPublicKeyJwk"] as JsonWebKey,
        channelId: channel.channelId,
        messageId: envelope["messageId"] as string,
        seq: 1,
        sender: "browser",
        recipient: "minter",
        algorithm: envelope["algorithm"] as string,
        aad: envelope["aad"] as string,
        nonce: envelope["nonce"] as string,
        ciphertext: envelope["ciphertext"] as string
      }) as Record<string, unknown>;
      mintRequests.push({ channelId: channel.channelId, envelope, plaintext });
      if (options.sendStatus !== undefined) {
        return jsonResponse({ error: "failed" }, options.sendStatus);
      }
      return jsonResponse({ channelId: channel.channelId, seq: 1, expiresAt: "2030-01-01T00:00:00.000Z" }, 201);
    }
    if (method === "GET" && url.includes("/messages?")) {
      const channelNumber = channels.indexOf(channel) + 1;
      if (channelNumber <= (options.expiredChannels ?? 0)) {
        return jsonResponse({ error: "expired" }, 410);
      }
      const request = mintRequests.find((candidate) => candidate.channelId === channel.channelId);
      if (request !== undefined) {
        return resultResponse(channel, request);
      }
      if (networkFailures > 0) {
        networkFailures -= 1;
        throw new TypeError("network down");
      }
      const polls = (pollsByChannel.get(channel.channelId) ?? 0) + 1;
      pollsByChannel.set(channel.channelId, polls);
      const joined = polls > (options.waitingPolls ?? 1);
      return jsonResponse({
        channelId: channel.channelId,
        status: joined ? "paired" : "waiting",
        expiresAt: "2030-01-01T00:00:00.000Z",
        peer: joined ? (options.peer?.(minterPublicKeyJwk) ?? { role: "minter", publicKeyJwk: minterPublicKeyJwk }) : null,
        messages: []
      });
    }
    throw new Error(`unexpected request ${method} ${url}`);
  });

  return { fetchImpl, requests, channels, mintRequests, closed, minterKeyPair, minterPublicKeyJwk };
}

export async function captureError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the promise to reject");
}

/** No broker token, pairing token, or session token may appear in what integrators see. */
export function expectNoSecrets(error: unknown): void {
  const text = error instanceof Error ? `${error.name} ${error.message} ${String(error.stack)}` : String(error);
  expect(text).not.toMatch(/secret/);
}

