import { type JsonValue } from "./canonicalJson.js";
import { PlayError, type PlayErrorCode } from "./errors.js";
import {
  decryptChannelMessage,
  encryptChannelMessage,
  exportPublicJwk,
  generateBrowserKeyPair,
  mintPairingAlgorithm,
  randomMessageId,
  type EncryptedChannelMessage,
  type MessageRole
} from "./crypto.js";
import { algorithm, buildAppLink, defaultAppLinkBaseUrl, type PairingMaterial } from "./pairingPayload.js";

export type BrowserInfo = {
  name?: string;
  userAgent?: string;
  label?: string;
};

export type EphemeralBrowserSession = {
  token: string;
  sessionId: string;
  /**
   * Absent when the device owner chose to keep this site paired until removed.
   * Such a session has no expiry and stays valid until it is revoked.
   */
  expiresAt?: string;
  /** True when the device owner kept this site paired until removed. */
  persistent?: boolean;
  relayerBaseUrl?: string;
};

export type Dp1Playlist = Record<string, unknown>;

export type DisplayDp1PlaylistOptions = {
  session: EphemeralBrowserSession;
  playlist: Dp1Playlist;
  relayerBaseUrl?: string;
  fetchImpl?: typeof fetch;
};

export type TokenStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export type TokenStorageOptions =
  | boolean
  | {
      enabled?: boolean;
      storage?: TokenStorage;
    };

export type RequestEphemeralSessionOptions = {
  /** Mint Pairing Broker the site creates its pairing channel on. */
  brokerBaseUrl: string;
  /**
   * Base of the link that brings the visitor's Art Computer to the channel.
   * Defaults to `https://link.feralfile.com/pair`; the library appends
   * `?channel=<id>&token=<pairingToken>`.
   */
  appLinkBaseUrl?: string;
  /**
   * Called with the app link, six-digit code and channel expiry once the
   * channel exists, and again with fresh material each time an expired channel
   * is replaced. Show it to the visitor; do not log it.
   */
  onPairingMaterial?: (material: PairingMaterial) => void;
  /** Called once the Art Computer has joined, when approval moves to the app. */
  onPeerJoined?: () => void;
  /** Aborting stops pairing with `pairing_canceled` and closes the channel. */
  signal?: AbortSignal;
  /**
   * How many times to replace a channel that expires before an Art Computer
   * joins it. 0 (the default) throws `pairing_code_expired` on the first
   * expiry; after the last replacement expires the call throws
   * `approval_timeout`.
   */
  channelRegenerations?: number;
  /** Idle lifetime of each pairing channel, 15 to 300 seconds (default 300). */
  idleTtlSeconds?: number;
  browserInfo?: BrowserInfo;
  storage?: TokenStorageOptions;
  /**
   * Poll interval. Unset: 1 s backing off to 2 s while waiting for the Art
   * Computer, 5 s while waiting for approval. Set: used for both.
   */
  pollIntervalMs?: number;
  /** How long to wait for approval once the Art Computer has joined. Default 5 minutes. */
  maxWaitMs?: number;
  /**
   * Session lifetime this site asks for, in whole seconds, from 1 to
   * 31536000 (one year). Leave unset to take the device default. The device
   * owner decides: if they keep this site paired until removed, the requested
   * lifetime is ignored and the session has no expiry.
   */
  requestedExpiresInSeconds?: number;
  fetchImpl?: typeof fetch;
};

type OptionalBrowserGlobals = {
  location?: { origin?: unknown };
  navigator?: { userAgent?: unknown };
  localStorage?: Storage;
};

type CreateChannelResponse = {
  channelId: string;
  browserToken: string;
  pairingToken: string;
  shortCode: string;
  expiresAt: string;
};

/** A channel this browser created; the broker URL is already normalized. */
type BrowserChannel = CreateChannelResponse & {
  brokerBaseUrl: string;
};

type ChannelPeer = {
  role: "minter";
  publicKeyJwk: JsonWebKey;
};

type SendMessageResponse = {
  channelId: string;
  seq: number;
  expiresAt: string;
};

type BrokerMessage = EncryptedChannelMessage & {
  seq: number;
};

type PollMessagesResponse = {
  channelId: string;
  expiresAt: string;
  peer: ChannelPeer | undefined;
  messages: BrokerMessage[];
};

type StoredSession = EphemeralBrowserSession & {
  storedAt: string;
  origin: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(record: Record<string, unknown>, key: string, errorMessage: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(errorMessage);
  }
  return value;
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * A session with a null or absent `expiresAt` never expires locally: the device
 * owner kept the site paired until they remove it.
 */
function hasExpiry(record: Record<string, unknown>): boolean {
  const value = record["expiresAt"];
  return value !== undefined && value !== null;
}

/**
 * Protocol maximum for a requested session lifetime: one year of seconds. It
 * sits well above any device or relay limit, and keeps the value inside the
 * range that survives canonical JSON — a larger number serializes in
 * exponential form, which the device cannot decode as an integer.
 */
export const maxRequestedExpiresInSeconds = 31_536_000;

/**
 * Checks a caller-supplied `requestedExpiresInSeconds`, returning it unchanged
 * (or undefined when unset) and throwing on anything the device cannot honour.
 * Every entry point calls this before it consults stored state, so a bad option
 * fails the same way whether or not a session is already cached.
 */
export function validateRequestedExpiresInSeconds(value: number | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isSafeInteger(value) || value < 1 || value > maxRequestedExpiresInSeconds) {
    throw new Error(`requestedExpiresInSeconds must be a whole number of seconds from 1 to ${String(maxRequestedExpiresInSeconds)}`);
  }
  return value;
}

function requiredNumber(record: Record<string, unknown>, key: string, errorMessage: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(errorMessage);
  }
  return value;
}

function requiredJwk(record: Record<string, unknown>, key: string, errorMessage: string): JsonWebKey {
  const value = record[key];
  if (!isRecord(value)) {
    throw new Error(errorMessage);
  }
  return value;
}

async function jsonResponse(
  response: Response,
  errorPrefix: string,
  codeByStatus?: Record<number, PlayErrorCode>,
  defaultCode?: PlayErrorCode
): Promise<unknown> {
  if (!response.ok) {
    throw new PlayError(`${errorPrefix}: ${String(response.status)}`, codeByStatus?.[response.status] ?? defaultCode);
  }
  try {
    return await response.json() as unknown;
  } catch {
    // Never rethrow the parse error: a SyntaxError quotes the body, which can
    // carry broker or session tokens.
    throw new Error(`${errorPrefix}: invalid response`);
  }
}

function defaultFetch(): typeof fetch {
  return (input, init) => globalThis.fetch(input, init);
}

function normalizeBaseUrl(value: string): string {
  return new URL(value).toString().replace(/\/$/, "");
}

function currentOrigin(): string {
  const globalWithLocation = globalThis as unknown as OptionalBrowserGlobals;
  const origin = globalWithLocation.location?.origin;
  if (typeof origin === "string" && origin.length > 0) {
    return origin;
  }
  throw new Error("origin is required");
}

function defaultBrowserInfo(): BrowserInfo {
  const globalWithNavigator = globalThis as unknown as OptionalBrowserGlobals;
  const userAgent = globalWithNavigator.navigator?.userAgent;
  return typeof userAgent === "string" ? { userAgent } : {};
}

function resolveStorage(options: TokenStorageOptions | undefined): TokenStorage | undefined {
  if (options === false) {
    return undefined;
  }
  if (typeof options === "object") {
    if (options.enabled === false) {
      return undefined;
    }
    if (options.storage !== undefined) {
      return options.storage;
    }
  }
  const globalWithStorage = globalThis as unknown as OptionalBrowserGlobals;
  return globalWithStorage.localStorage;
}

function browserInfoToJsonValue(browserInfo: BrowserInfo): JsonValue {
  return {
    ...(browserInfo.name === undefined ? {} : { name: browserInfo.name }),
    ...(browserInfo.userAgent === undefined ? {} : { userAgent: browserInfo.userAgent }),
    ...(browserInfo.label === undefined ? {} : { label: browserInfo.label })
  };
}

function parseCreate(value: unknown): CreateChannelResponse {
  if (!isRecord(value)) {
    throw new Error("channel create invalid");
  }
  // A broker that predates browser-created channels answers without a
  // creatorRole (or rejects the request outright); refuse to carry on as if the
  // channel were ours.
  if (value["creatorRole"] !== "browser") {
    throw new Error("channel create invalid");
  }
  const shortCode = requiredString(value, "shortCode", "channel create invalid");
  if (!/^[0-9]{6}$/.test(shortCode)) {
    throw new Error("channel create invalid");
  }
  const expiresAt = requiredString(value, "expiresAt", "channel create invalid");
  if (!Number.isFinite(Date.parse(expiresAt))) {
    throw new Error("channel create invalid");
  }
  return {
    channelId: requiredString(value, "channelId", "channel create invalid"),
    browserToken: requiredString(value, "browserToken", "channel create invalid"),
    pairingToken: requiredString(value, "pairingToken", "channel create invalid"),
    shortCode,
    expiresAt
  };
}

function parseSend(value: unknown, channelId: string): SendMessageResponse {
  if (!isRecord(value)) {
    throw new Error("message send invalid");
  }
  const sentChannelId = requiredString(value, "channelId", "message send invalid");
  if (sentChannelId !== channelId) {
    throw new Error("message send invalid");
  }
  return {
    channelId: sentChannelId,
    seq: requiredNumber(value, "seq", "message send invalid"),
    expiresAt: requiredString(value, "expiresAt", "message send invalid")
  };
}

function parseBrokerMessage(value: unknown): BrokerMessage {
  if (!isRecord(value) || value["algorithm"] !== mintPairingAlgorithm) {
    throw new Error("poll response invalid");
  }
  const sender = requiredString(value, "sender", "poll response invalid");
  const recipient = requiredString(value, "recipient", "poll response invalid");
  if (!isMessageRole(sender) || !isMessageRole(recipient)) {
    throw new Error("poll response invalid");
  }
  return {
    seq: requiredNumber(value, "seq", "poll response invalid"),
    messageId: requiredString(value, "messageId", "poll response invalid"),
    sender,
    recipient,
    algorithm: mintPairingAlgorithm,
    aad: requiredString(value, "aad", "poll response invalid"),
    nonce: requiredString(value, "nonce", "poll response invalid"),
    ciphertext: requiredString(value, "ciphertext", "poll response invalid"),
    ...(isRecord(value["senderPublicKeyJwk"]) ? { senderPublicKeyJwk: value["senderPublicKeyJwk"] } : {})
  };
}

function parsePoll(value: unknown, channelId: string): PollMessagesResponse {
  if (!isRecord(value)) {
    throw new Error("poll response invalid");
  }
  const polledChannelId = requiredString(value, "channelId", "poll response invalid");
  if (polledChannelId !== channelId) {
    throw new Error("poll response invalid");
  }
  const messagesValue = value["messages"];
  if (!Array.isArray(messagesValue)) {
    throw new Error("poll response invalid");
  }
  return {
    channelId: polledChannelId,
    expiresAt: requiredString(value, "expiresAt", "poll response invalid"),
    peer: parsePeer(value["peer"]),
    messages: messagesValue.map((message) => parseBrokerMessage(message))
  };
}

function parsePeer(value: unknown): ChannelPeer | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!isRecord(value) || value["role"] !== "minter") {
    throw new Error("poll response invalid");
  }
  return { role: "minter", publicKeyJwk: requiredJwk(value, "publicKeyJwk", "poll response invalid") };
}

function isMessageRole(value: string): value is MessageRole {
  return value === "browser" || value === "minter";
}

function parseSessionPayload(value: unknown, channelId: string, requestMessageId: string): EphemeralBrowserSession {
  if (!isRecord(value) || value["v"] !== 1) {
    throw new Error("mint result invalid");
  }
  const messageChannelId = requiredString(value, "channelId", "mint result invalid");
  if (messageChannelId !== channelId) {
    throw new Error("mint result invalid");
  }
  const responseRequestId = requiredString(value, "requestMessageId", "mint result invalid");
  if (responseRequestId !== requestMessageId) {
    throw new Error("mint result invalid");
  }
  if (value["type"] === "mint_rejected") {
    throw new PlayError("mint request rejected", "mint_rejected");
  }
  if (value["type"] !== "mint_succeeded") {
    throw new Error("mint result invalid");
  }
  const session = isRecord(value["session"]) ? value["session"] : value;
  const token = requiredString(session, "token", "mint result invalid");
  const sessionId = requiredString(session, "sessionId", "mint result invalid");
  const persistent = session["persistent"] === true;
  const expiresAt = hasExpiry(session) ? requiredString(session, "expiresAt", "mint result invalid") : undefined;
  if (expiresAt === undefined) {
    if (!persistent) {
      throw new Error("mint result invalid");
    }
  } else {
    const expiresAtMs = Date.parse(expiresAt);
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
      throw new Error("mint result invalid");
    }
  }
  const relayerBaseUrl = optionalString(session, "relayerBaseUrl");
  return {
    token,
    sessionId,
    ...(expiresAt === undefined ? {} : { expiresAt }),
    ...(persistent ? { persistent: true } : {}),
    ...(relayerBaseUrl === undefined ? {} : { relayerBaseUrl })
  };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve();
      return;
    }
    const finish = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", finish, { once: true });
  });
}

function extractOk(value: unknown): boolean | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (typeof value["ok"] === "boolean") {
    return value["ok"];
  }
  if ("message" in value) {
    return extractOk(value["message"]);
  }
  return undefined;
}

function channelUrl(channel: BrowserChannel, suffix = ""): URL {
  return new URL(`/v1/channels/${encodeURIComponent(channel.channelId)}${suffix}`, channel.brokerBaseUrl);
}

async function createChannel(input: {
  fetcher: typeof fetch;
  brokerBaseUrl: string;
  browserPublicKeyJwk: JsonWebKey;
  origin: string;
  browserInfo: BrowserInfo;
  idleTtlSeconds: number;
  signal: AbortSignal | undefined;
}): Promise<BrowserChannel> {
  // The browser's own fetch adds the Origin header the broker attests; the body
  // origin has to match it exactly.
  const response = await input.fetcher(new URL("/v1/channels", input.brokerBaseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      algorithm,
      creatorRole: "browser",
      browserPublicKeyJwk: input.browserPublicKeyJwk,
      origin: input.origin,
      browserInfo: browserInfoToJsonValue(input.browserInfo),
      idleTtlSeconds: input.idleTtlSeconds,
      shortCodeRequested: true
    }),
    ...(input.signal === undefined ? {} : { signal: input.signal })
  });
  const created = parseCreate(await jsonResponse(response, "channel create failed"));
  return { ...created, brokerBaseUrl: input.brokerBaseUrl };
}

async function sendMintRequest(input: {
  fetcher: typeof fetch;
  channel: BrowserChannel;
  encrypted: EncryptedChannelMessage;
  signal: AbortSignal | undefined;
}): Promise<SendMessageResponse> {
  const response = await input.fetcher(channelUrl(input.channel, "/messages"), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${input.channel.browserToken}`
    },
    body: JSON.stringify(input.encrypted),
    ...(input.signal === undefined ? {} : { signal: input.signal })
  });
  return parseSend(await jsonResponse(response, "message send failed"), input.channel.channelId);
}

/** Thrown internally when the broker reports the channel gone (404) or expired (410). */
class ChannelGoneError extends Error {
  constructor() {
    super("channel expired");
    this.name = "ChannelGoneError";
  }
}

async function pollMessages(input: {
  fetcher: typeof fetch;
  channel: BrowserChannel;
  afterSeq: number;
  signal: AbortSignal | undefined;
}): Promise<PollMessagesResponse> {
  const url = channelUrl(input.channel, "/messages");
  url.searchParams.set("afterSeq", String(input.afterSeq));
  const response = await input.fetcher(url, {
    headers: { authorization: `Bearer ${input.channel.browserToken}` },
    ...(input.signal === undefined ? {} : { signal: input.signal })
  });
  if (response.status === 404 || response.status === 410) {
    throw new ChannelGoneError();
  }
  return parsePoll(await jsonResponse(response, "poll failed"), input.channel.channelId);
}

/** Best-effort close so an abandoned channel stops admitting a device. */
async function closeChannel(fetcher: typeof fetch, channel: BrowserChannel): Promise<void> {
  try {
    await fetcher(channelUrl(channel), {
      method: "DELETE",
      headers: { authorization: `Bearer ${channel.browserToken}` }
    });
  } catch {
    // The channel expires on its own; nothing to report.
  }
}

export function ephemeralBrowserSessionStorageKey(origin: string): string {
  return `ff:ephemeral-browser-session:${origin}`;
}

export function storeEphemeralBrowserSession(storage: TokenStorage, origin: string, session: EphemeralBrowserSession): void {
  const stored: StoredSession = { ...session, origin, storedAt: new Date().toISOString() };
  storage.setItem(ephemeralBrowserSessionStorageKey(origin), JSON.stringify(stored));
}

/**
 * Reads the session stored for this origin. A record we can no longer use — one
 * that is malformed, expired, or carries no expiry without the `persistent`
 * marker — is dropped from storage, so the next play re-pairs instead of
 * holding a token that will never be sent.
 */
export function readStoredEphemeralBrowserSession(storage: TokenStorage, origin: string): EphemeralBrowserSession | undefined {
  const key = ephemeralBrowserSessionStorageKey(origin);
  const raw = storage.getItem(key);
  if (raw === null) {
    return undefined;
  }
  const session = parseStoredSession(raw, origin);
  if (session === undefined) {
    storage.removeItem(key);
  }
  return session;
}

function parseStoredSession(raw: string, origin: string): EphemeralBrowserSession | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
  if (!isRecord(value) || value["origin"] !== origin) {
    return undefined;
  }
  const token = optionalString(value, "token");
  const sessionId = optionalString(value, "sessionId");
  if (token === undefined || sessionId === undefined) {
    return undefined;
  }
  const persistent = value["persistent"] === true;
  const expiryPresent = hasExpiry(value);
  const expiresAt = expiryPresent ? optionalString(value, "expiresAt") : undefined;
  if (expiryPresent) {
    const expiresAtMs = expiresAt === undefined ? Number.NaN : Date.parse(expiresAt);
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
      return undefined;
    }
  } else if (!persistent) {
    // No expiry and no owner-kept marker: not a session this library wrote.
    return undefined;
  }
  const relayerBaseUrl = optionalString(value, "relayerBaseUrl");
  return {
    token,
    sessionId,
    ...(expiresAt === undefined ? {} : { expiresAt }),
    ...(persistent ? { persistent: true } : {}),
    ...(relayerBaseUrl === undefined ? {} : { relayerBaseUrl })
  };
}

/** Broker bounds for a pairing channel's idle lifetime, in seconds. */
export const minIdleTtlSeconds = 15;
export const maxIdleTtlSeconds = 300;
const defaultIdleTtlSeconds = 300;
const maxChannelRegenerations = 5;
const defaultResultPollIntervalMs = 5000;
const peerPollFastIntervalMs = 1000;
const peerPollSlowIntervalMs = 2000;
const peerPollFastCount = 10;

function validateIdleTtlSeconds(value: number | undefined): number {
  if (value === undefined) {
    return defaultIdleTtlSeconds;
  }
  if (!Number.isSafeInteger(value) || value < minIdleTtlSeconds || value > maxIdleTtlSeconds) {
    throw new Error(`idleTtlSeconds must be a whole number of seconds from ${String(minIdleTtlSeconds)} to ${String(maxIdleTtlSeconds)}`);
  }
  return value;
}

function validateChannelRegenerations(value: number | undefined): number {
  if (value === undefined) {
    return 0;
  }
  if (!Number.isSafeInteger(value) || value < 0 || value > maxChannelRegenerations) {
    throw new Error(`channelRegenerations must be a whole number from 0 to ${String(maxChannelRegenerations)}`);
  }
  return value;
}

/**
 * Checks `appLinkBaseUrl` up front so a bad option fails before a channel
 * exists. Returns the value to use (the default when unset).
 */
export function validateAppLinkBaseUrl(value: string | undefined): string {
  const appLinkBaseUrl = value ?? defaultAppLinkBaseUrl;
  buildAppLink(appLinkBaseUrl, "ch_check", "pt_check");
  return appLinkBaseUrl;
}

function canceledError(): PlayError {
  return new PlayError("pairing canceled", "pairing_canceled");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw canceledError();
  }
}

type PairingContext = {
  fetcher: typeof fetch;
  origin: string;
  browserInfo: BrowserInfo;
  signal: AbortSignal | undefined;
  pollIntervalMs: number | undefined;
};

/**
 * Waits for the Art Computer to join the channel and returns its public key.
 * Throws ChannelGoneError when the channel expires first.
 */
async function waitForPeer(context: PairingContext, channel: BrowserChannel, localDeadline: number): Promise<ChannelPeer> {
  let polls = 0;
  for (;;) {
    throwIfAborted(context.signal);
    if (Date.now() >= localDeadline) {
      throw new ChannelGoneError();
    }
    let poll: PollMessagesResponse | undefined;
    // Bound each poll by the channel deadline too, so a stalled request cannot
    // hold the dialog on an expired code.
    const pollController = new AbortController();
    const onCancel = (): void => {
      pollController.abort();
    };
    context.signal?.addEventListener("abort", onCancel, { once: true });
    const deadlineTimer = setTimeout(onCancel, Math.max(0, localDeadline - Date.now()));
    try {
      poll = await pollMessages({ fetcher: context.fetcher, channel, afterSeq: 0, signal: pollController.signal });
    } catch (error) {
      throwIfAborted(context.signal);
      if (pollController.signal.aborted) {
        throw new ChannelGoneError();
      }
      if (!(error instanceof TypeError)) {
        throw error;
      }
    } finally {
      clearTimeout(deadlineTimer);
      context.signal?.removeEventListener("abort", onCancel);
    }
    if (poll?.peer !== undefined) {
      return poll.peer;
    }
    polls += 1;
    const interval = context.pollIntervalMs ?? (polls < peerPollFastCount ? peerPollFastIntervalMs : peerPollSlowIntervalMs);
    await sleep(interval, context.signal);
  }
}

/** Sends the encrypted mint request to the joined Art Computer and waits for its answer. */
async function completeMint(input: {
  context: PairingContext;
  channel: BrowserChannel;
  peer: ChannelPeer;
  keyPair: CryptoKeyPair;
  browserPublicKeyJwk: JsonWebKey;
  requestedExpiresInSeconds: number | undefined;
  maxWaitMs: number;
}): Promise<EphemeralBrowserSession> {
  const { context, channel, peer, keyPair, browserPublicKeyJwk } = input;
  const requestMessageId = randomMessageId();
  const mintRequestPlaintext: JsonValue = {
    v: 1,
    type: "mint_request",
    channelId: channel.channelId,
    requestMessageId,
    origin: context.origin,
    browserInfo: browserInfoToJsonValue(context.browserInfo),
    // Tells the device this page can hold a session with no expiry. The flag
    // exists from 0.3.0; earlier clients required a string expiresAt, so the
    // device may send the owner-kept shape only to a requester that declared
    // this.
    supportsPersistentSessions: true,
    ...(input.requestedExpiresInSeconds === undefined ? {} : { requestedExpiresInSeconds: input.requestedExpiresInSeconds }),
    browserPublicKeyJwk: browserPublicKeyJwk as unknown as JsonValue,
    requestedAt: new Date().toISOString()
  };
  const encryptedRequest = await encryptChannelMessage({
    privateKey: keyPair.privateKey,
    senderPublicJwk: browserPublicKeyJwk,
    peerPublicJwk: peer.publicKeyJwk,
    channelId: channel.channelId,
    messageId: requestMessageId,
    seq: 0,
    sender: "browser",
    recipient: "minter",
    plaintext: mintRequestPlaintext
  });
  const sent = await sendMintRequest({ fetcher: context.fetcher, channel, encrypted: encryptedRequest, signal: context.signal });
  const deadline = Date.now() + input.maxWaitMs;
  let afterSeq = sent.seq;
  while (Date.now() <= deadline) {
    throwIfAborted(context.signal);
    let poll: PollMessagesResponse;
    // Bound each poll by maxWaitMs too, so a stalled request still times out.
    const pollController = new AbortController();
    const onCancel = (): void => {
      pollController.abort();
    };
    context.signal?.addEventListener("abort", onCancel, { once: true });
    const deadlineTimer = setTimeout(onCancel, Math.max(0, deadline - Date.now()));
    try {
      poll = await pollMessages({ fetcher: context.fetcher, channel, afterSeq, signal: pollController.signal });
    } catch (error) {
      throwIfAborted(context.signal);
      if (pollController.signal.aborted) {
        throw new PlayError("poll timed out", "approval_timeout");
      }
      if (error instanceof TypeError) {
        await sleep(context.pollIntervalMs ?? defaultResultPollIntervalMs, context.signal);
        continue;
      }
      if (error instanceof ChannelGoneError) {
        throw new PlayError("poll timed out", "approval_timeout");
      }
      throw error;
    } finally {
      clearTimeout(deadlineTimer);
      context.signal?.removeEventListener("abort", onCancel);
    }
    for (const message of poll.messages) {
      afterSeq = Math.max(afterSeq, message.seq);
      if (message.sender !== "minter" || message.recipient !== "browser") {
        continue;
      }
      const plaintext = await decryptChannelMessage({
        privateKey: keyPair.privateKey,
        peerPublicJwk: peer.publicKeyJwk,
        channelId: channel.channelId,
        messageId: message.messageId,
        seq: message.seq,
        sender: message.sender,
        recipient: message.recipient,
        algorithm: message.algorithm,
        aad: message.aad,
        nonce: message.nonce,
        ciphertext: message.ciphertext
      });
      return parseSessionPayload(plaintext, channel.channelId, requestMessageId);
    }
    await sleep(context.pollIntervalMs ?? defaultResultPollIntervalMs, context.signal);
  }
  throw new PlayError("poll timed out", "approval_timeout");
}

/**
 * Pairs this browser with the visitor's Art Computer and returns a browser
 * session, or the stored one for this origin when it is still valid.
 *
 * The site creates a pairing channel on the broker and hands the visitor the
 * way in through `onPairingMaterial`: an app link (tap on a phone, QR on a
 * desktop) and a six-digit code. The Feral File app brings the Art Computer to
 * the channel, the owner approves in the app, and the session comes back
 * end-to-end encrypted.
 */
export async function requestEphemeralSession(options: RequestEphemeralSessionOptions): Promise<EphemeralBrowserSession> {
  const fetcher = options.fetchImpl ?? defaultFetch();
  const origin = currentOrigin();
  const requestedExpiresInSeconds = validateRequestedExpiresInSeconds(options.requestedExpiresInSeconds);
  const idleTtlSeconds = validateIdleTtlSeconds(options.idleTtlSeconds);
  const channelRegenerations = validateChannelRegenerations(options.channelRegenerations);
  const appLinkBaseUrl = validateAppLinkBaseUrl(options.appLinkBaseUrl);
  const brokerBaseUrl = normalizeBaseUrl(options.brokerBaseUrl);
  const browserInfo = { ...defaultBrowserInfo(), ...options.browserInfo };
  const storage = resolveStorage(options.storage);
  const existingSession = storage === undefined ? undefined : readStoredEphemeralBrowserSession(storage, origin);
  if (existingSession !== undefined) {
    return existingSession;
  }

  const signal = options.signal;
  const context: PairingContext = { fetcher, origin, browserInfo, signal, pollIntervalMs: options.pollIntervalMs };
  for (let attempt = 0; ; attempt += 1) {
    throwIfAborted(signal);
    // A fresh key pair per channel: a replaced channel shares nothing with the
    // one it replaces.
    const keyPair = await generateBrowserKeyPair();
    const browserPublicKeyJwk = await exportPublicJwk(keyPair.publicKey);
    const localDeadline = Date.now() + idleTtlSeconds * 1000;
    let channel: BrowserChannel;
    try {
      channel = await createChannel({ fetcher, brokerBaseUrl, browserPublicKeyJwk, origin, browserInfo, idleTtlSeconds, signal });
    } catch (error) {
      throw signal?.aborted === true ? canceledError() : error;
    }
    try {
      options.onPairingMaterial?.({
        appLink: buildAppLink(appLinkBaseUrl, channel.channelId, channel.pairingToken),
        shortCode: channel.shortCode,
        expiresAt: channel.expiresAt
      });
      const peer = await waitForPeer(context, channel, localDeadline);
      options.onPeerJoined?.();
      const session = await completeMint({
        context,
        channel,
        peer,
        keyPair,
        browserPublicKeyJwk,
        requestedExpiresInSeconds,
        maxWaitMs: options.maxWaitMs ?? 300_000
      });
      // A cancel that lands while the result is decrypted still wins.
      throwIfAborted(signal);
      if (storage !== undefined) {
        storeEphemeralBrowserSession(storage, origin, session);
      }
      return session;
    } catch (error) {
      // Fire and forget: a slow DELETE must not hold up cancel or regeneration.
      void closeChannel(fetcher, channel);
      if (signal?.aborted === true) {
        throw canceledError();
      }
      if (error instanceof ChannelGoneError) {
        if (attempt < channelRegenerations) {
          continue;
        }
        throw channelRegenerations === 0
          ? new PlayError("pairing code expired", "pairing_code_expired")
          : new PlayError("pairing timed out", "approval_timeout");
      }
      throw error;
    }
  }
}

export async function displayDp1Playlist(options: DisplayDp1PlaylistOptions): Promise<void> {
  const fetcher = options.fetchImpl ?? defaultFetch();
  const relayerBaseUrl = options.session.relayerBaseUrl ?? options.relayerBaseUrl;
  if (relayerBaseUrl === undefined || relayerBaseUrl.trim().length === 0) {
    throw new Error("relayer base URL is required");
  }

  const response = await fetcher(new URL("/api/cast", normalizeBaseUrl(relayerBaseUrl)), {
    method: "POST",
    headers: {
      authorization: `Bearer ${options.session.token}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      command: "displayPlaylist",
      request: {
        intent: {
          action: "now_display"
        },
        dp1_call: options.playlist
      }
    })
  });

  if (response.status === 401 || response.status === 403) {
    throw new PlayError("browser session rejected", "session_rejected");
  }
  const result = await jsonResponse(response, "display request failed", undefined, "display_failed");
  if (extractOk(result) === false) {
    throw new PlayError("FF1 rejected display request", "display_rejected");
  }
}
