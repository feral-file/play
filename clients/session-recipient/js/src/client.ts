import { type JsonValue } from "./canonicalJson.js";
import { revokeDisplayGrant, grantExpired } from "./cast.js";
import { parseProfile } from "./control/codec.js";
import { exportPublicJwk as exportStrippedPublicJwk, generateAgreementKeyPair, generateSigningKeyPair, thumbprint, type PublicJwk } from "./control/jwk.js";
import { relayURL, type SocketFactory } from "./control/relay-client.js";
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
import {
  deleteStoredDisplayGrant,
  hasIndexedDb,
  readStoredDisplayGrant,
  replaceStoredDisplayGrant,
  type StoredDisplayGrant
} from "./grantStore.js";
import { algorithm, buildAppLink, defaultAppLinkBaseUrl, type PairingMaterial } from "./pairingPayload.js";

export type BrowserInfo = {
  name?: string;
  userAgent?: string;
  label?: string;
};

/**
 * The pairing this page holds with an Art Computer: a display grant the FF1
 * issued to keys that stay in this origin's IndexedDB. There is no token;
 * every cast is sealed with those keys.
 */
export type EphemeralBrowserSession = {
  /** The FF1 that issued the grant (its `dev`). */
  deviceId: string;
  /** The grant's controller id, thumb(sig). */
  ctl: string;
  /**
   * Absent when the device owner chose to keep this site paired until removed.
   * Such a grant has no expiry and stays valid until it is revoked.
   */
  expiresAt?: string;
  /** True when the device owner kept this site paired until removed. */
  persistent: boolean;
};

/**
 * `false` disables the grant store, which makes pairing fail with
 * `storage_unavailable`: a grant's keys live only in IndexedDB.
 */
export type GrantStorageOptions = boolean;

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
  storage?: GrantStorageOptions;
  /**
   * Poll interval. Unset: 1 s backing off to 2 s while waiting for the Art
   * Computer, 5 s while waiting for approval. Set: used for both.
   */
  pollIntervalMs?: number;
  /** How long to wait for approval once the Art Computer has joined. Default 5 minutes. */
  maxWaitMs?: number;
  /**
   * Grant lifetime this site asks for, in whole seconds, from 1 to
   * 31536000 (one year). Leave unset to take the device default. The device
   * owner decides: if they keep this site paired until removed, the requested
   * lifetime is ignored and the grant has no expiry.
   */
  requestedExpiresInSeconds?: number;
  fetchImpl?: typeof fetch;
  /** Opens the relay WebSocket for the old grant's self-revoke on a re-pair. */
  socketFactory?: SocketFactory;
};

type OptionalBrowserGlobals = {
  location?: { origin?: unknown };
  navigator?: { userAgent?: unknown };
  localStorage?: Pick<Storage, "removeItem">;
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

/** The grant as the FF1 returned it, before it is stored with its keys. */
type DisplayGrantResult = {
  profile: Awaited<ReturnType<typeof parseProfile>>;
  relayV2Endpoint: string;
  expiresAt: string | undefined;
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
 * A grant with a null or absent `expiresAt` never expires locally: the device
 * owner kept the site paired until they remove it.
 */
function hasExpiry(record: Record<string, unknown>): boolean {
  const value = record["expiresAt"];
  return value !== undefined && value !== null;
}

/**
 * Protocol maximum for a requested grant lifetime: one year of seconds. It
 * sits well above any device limit, and keeps the value inside the range
 * that survives canonical JSON — a larger number serializes in exponential
 * form, which the device cannot decode as an integer.
 */
export const maxRequestedExpiresInSeconds = 31_536_000;

/**
 * Checks a caller-supplied `requestedExpiresInSeconds`, returning it unchanged
 * (or undefined when unset) and throwing on anything the device cannot honour.
 * Every entry point calls this before it consults stored state, so a bad option
 * fails the same way whether or not a grant is already cached.
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
    // carry broker tokens.
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

/** The `mint_rejected` reasons the FF1 gives a 0.5 request, by error code. */
const rejectionCodes: Record<string, PlayErrorCode> = {
  display_grant_unavailable: "device_unsupported",
  too_many_sites: "too_many_sites"
};

/**
 * Parses the FF1's answer. A `mint_succeeded` must carry the display grant
 * issued to `expectedCtl`; one without it comes from firmware that minted a
 * session for the request instead, which this library cannot use.
 */
async function parseMintResult(value: unknown, channelId: string, requestMessageId: string, expectedCtl: string): Promise<DisplayGrantResult> {
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
    const reason = optionalString(value, "reason");
    const code = reason === undefined ? undefined : rejectionCodes[reason];
    if (code === "device_unsupported") {
      throw new PlayError("this FF1 cannot issue a display grant; it needs an FF OS update", code);
    }
    if (code === "too_many_sites") {
      throw new PlayError("this FF1 has as many paired sites as it allows", code);
    }
    throw new PlayError("mint request rejected", "mint_rejected");
  }
  if (value["type"] !== "mint_succeeded") {
    throw new Error("mint result invalid");
  }
  const grant = value["displayGrant"];
  if (!isRecord(grant)) {
    // Older firmware ignores the keys and mints a session; it is discarded.
    throw new PlayError("this FF1 needs an FF OS update", "device_unsupported");
  }
  if (grant["v"] !== 1 || requiredString(grant, "ctl", "mint result invalid") !== expectedCtl) {
    throw new Error("mint result invalid");
  }
  let profile: DisplayGrantResult["profile"];
  let relayV2Endpoint: string;
  try {
    profile = await parseProfile(grant["profile"]);
    relayV2Endpoint = requiredString(grant, "relayV2Endpoint", "mint result invalid");
    // A grant's keys must never travel in the clear: only TLS endpoints,
    // even though relayURL would accept ws:/http: for local tooling.
    if (!["wss:", "https:"].includes(new URL(relayV2Endpoint).protocol)) {
      throw new Error("mint result invalid");
    }
    relayURL(relayV2Endpoint, profile.dev);
  } catch {
    throw new Error("mint result invalid");
  }
  const expiresAt = hasExpiry(grant) ? requiredString(grant, "expiresAt", "mint result invalid") : undefined;
  if (expiresAt !== undefined) {
    const expiresAtMs = Date.parse(expiresAt);
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
      throw new Error("mint result invalid");
    }
  }
  return { profile, relayV2Endpoint, expiresAt };
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

function channelUrl(channel: BrowserChannel, suffix = ""): URL {
  return new URL(`/v1/channels/${encodeURIComponent(channel.channelId)}${suffix}`, channel.brokerBaseUrl);
}

/** The fresh keys one pairing attempt asks the FF1 to issue a grant to. */
type DisplayGrantKeys = {
  sig: CryptoKeyPair;
  enc: CryptoKeyPair;
  sigPublic: PublicJwk;
  encPublic: PublicJwk;
  /** thumb(sigPublic): the ctl the grant will carry. */
  ctl: string;
};

async function generateDisplayGrantKeys(): Promise<DisplayGrantKeys> {
  const sig = await generateSigningKeyPair();
  const enc = await generateAgreementKeyPair();
  const sigPublic = await exportStrippedPublicJwk(sig.publicKey);
  const encPublic = await exportStrippedPublicJwk(enc.publicKey);
  return { sig, enc, sigPublic, encPublic, ctl: await thumbprint(sigPublic) };
}

/** The `displayGrant` member of both mint request copies: public keys only, stripped to kty/crv/x/y. */
function displayGrantRequest(keys: DisplayGrantKeys): JsonValue {
  return { v: 1, sig: { ...keys.sigPublic }, enc: { ...keys.encPublic } };
}

/**
 * The mint request as announced at create, so the Art Computer can ask its
 * owner as soon as it joins: a phone browser stops polling while the visitor is
 * in the app, and the encrypted request would otherwise wait for them to come
 * back. Nothing here is secret: the display-grant keys are public, and the
 * grant the device returns stays end-to-end encrypted. The origin, channel key
 * and browser info are already on the channel.
 */
type AnnouncedMintRequest = {
  requestMessageId: string;
  requestedExpiresInSeconds: number | undefined;
  requestedAt: string;
  displayGrant: JsonValue;
};

function announcedMintRequestToJsonValue(request: AnnouncedMintRequest): JsonValue {
  return {
    v: 1,
    requestMessageId: request.requestMessageId,
    supportsPersistentSessions: true,
    ...(request.requestedExpiresInSeconds === undefined ? {} : { requestedExpiresInSeconds: request.requestedExpiresInSeconds }),
    requestedAt: request.requestedAt,
    displayGrant: request.displayGrant
  };
}

async function createChannel(input: {
  fetcher: typeof fetch;
  brokerBaseUrl: string;
  browserPublicKeyJwk: JsonWebKey;
  origin: string;
  browserInfo: BrowserInfo;
  mintRequest: AnnouncedMintRequest;
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
      mintRequest: announcedMintRequestToJsonValue(input.mintRequest),
      idleTtlSeconds: input.idleTtlSeconds,
      shortCodeRequested: true
    }),
    ...(input.signal === undefined ? {} : { signal: input.signal })
  });
  const created = parseCreate(await jsonResponse(response, "channel create failed"));
  return { ...created, brokerBaseUrl: input.brokerBaseUrl };
}

/** Thrown internally when the broker reports the channel gone (404) or expired (410). */
class ChannelGoneError extends Error {
  constructor() {
    super("channel expired");
    this.name = "ChannelGoneError";
  }
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
  if (response.status === 404 || response.status === 410) {
    // The channel expired between the peer joining and the request landing.
    throw new ChannelGoneError();
  }
  return parseSend(await jsonResponse(response, "message send failed"), input.channel.channelId);
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

/** Where 0.4 kept its session token; removed on first use so the site re-pairs once. */
export function legacySessionStorageKey(origin: string): string {
  return `ff:ephemeral-browser-session:${origin}`;
}

function removeLegacySession(origin: string): void {
  try {
    (globalThis as unknown as OptionalBrowserGlobals).localStorage?.removeItem(legacySessionStorageKey(origin));
  } catch {
    // Storage access can throw in a sandboxed frame; there is nothing to remove then.
  }
}

function sessionOf(record: StoredDisplayGrant): EphemeralBrowserSession {
  return {
    deviceId: record.deviceId,
    ctl: record.ctl,
    ...(record.expiresAt === undefined ? {} : { expiresAt: record.expiresAt }),
    persistent: record.persistent
  };
}

/**
 * Reads the grant stored for this origin. An expired grant is dropped from
 * storage, so the next play re-pairs instead of sealing with keys the FF1
 * will refuse. Resolves to undefined without IndexedDB.
 */
export async function readStoredEphemeralBrowserSession(origin: string): Promise<EphemeralBrowserSession | undefined> {
  if (!hasIndexedDb()) {
    return undefined;
  }
  const record = await readStoredDisplayGrant(origin);
  if (record === undefined) {
    return undefined;
  }
  if (grantExpired(record)) {
    await deleteStoredDisplayGrant(origin, record.ctl);
    return undefined;
  }
  return sessionOf(record);
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
/** How long the last peer check after the local deadline may take. */
const finalPeerCheckTimeoutMs = 10_000;

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
 *
 * The local deadline is the create-time one, but the broker's can be later: a
 * join renews it, and an Art Computer that answers the announced request can
 * deliver the grant while this page is suspended. So a page that wakes past
 * its local deadline checks the broker once more before it gives the channel
 * up, and only a channel the device never joined is abandoned on the clock.
 */
async function waitForPeer(context: PairingContext, channel: BrowserChannel, localDeadline: number): Promise<ChannelPeer> {
  let polls = 0;
  // Set when the deadline timer cut a poll off: the next pass is the final
  // check whatever the clock reads.
  let deadlineReached = false;
  for (;;) {
    throwIfAborted(context.signal);
    const pastDeadline = deadlineReached || Date.now() >= localDeadline;
    let poll: PollMessagesResponse | undefined;
    // Bound each poll by the channel deadline too, so a stalled request cannot
    // hold the dialog on an expired code; the last check gets a short bound of
    // its own.
    const pollController = new AbortController();
    const onCancel = (): void => {
      pollController.abort();
    };
    context.signal?.addEventListener("abort", onCancel, { once: true });
    const bound = pastDeadline ? finalPeerCheckTimeoutMs : localDeadline - Date.now();
    const deadlineTimer = setTimeout(onCancel, Math.max(0, bound));
    try {
      poll = await pollMessages({ fetcher: context.fetcher, channel, afterSeq: 0, signal: pollController.signal });
    } catch (error) {
      throwIfAborted(context.signal);
      const cutOff = pollController.signal.aborted;
      if (!cutOff && !(error instanceof TypeError)) {
        throw error;
      }
      // A final check that stalls or fails ends the channel.
      if (pastDeadline) {
        throw new ChannelGoneError();
      }
      // Before the deadline a network failure is retried. A poll that stalled
      // until the deadline falls through to the bounded final check: the
      // device may have joined and delivered while it hung.
      deadlineReached = cutOff;
    } finally {
      clearTimeout(deadlineTimer);
      context.signal?.removeEventListener("abort", onCancel);
    }
    if (poll?.peer !== undefined) {
      return poll.peer;
    }
    if (pastDeadline) {
      throw new ChannelGoneError();
    }
    if (deadlineReached) {
      continue;
    }
    polls += 1;
    const interval = context.pollIntervalMs ?? (polls < peerPollFastCount ? peerPollFastIntervalMs : peerPollSlowIntervalMs);
    await sleep(interval, context.signal);
  }
}

/**
 * Sends the encrypted mint request to the joined Art Computer and waits for its
 * answer.
 *
 * An Art Computer that read the request announced at create may have answered
 * already, while this page was in the background; one that predates it needs
 * the encrypted request. So the request is always sent, under the announced
 * message id (a device that answered ignores the copy), and the answer is read
 * from the start of the channel rather than after the request.
 */
async function completeMint(input: {
  context: PairingContext;
  channel: BrowserChannel;
  peer: ChannelPeer;
  keyPair: CryptoKeyPair;
  browserPublicKeyJwk: JsonWebKey;
  mintRequest: AnnouncedMintRequest;
  grantKeys: DisplayGrantKeys;
  maxWaitMs: number;
}): Promise<DisplayGrantResult> {
  const { context, channel, peer, keyPair, browserPublicKeyJwk } = input;
  const { requestMessageId, requestedExpiresInSeconds, requestedAt, displayGrant } = input.mintRequest;
  const mintRequestPlaintext: JsonValue = {
    v: 1,
    type: "mint_request",
    channelId: channel.channelId,
    requestMessageId,
    origin: context.origin,
    browserInfo: browserInfoToJsonValue(context.browserInfo),
    // Tells the device this page can hold a grant with no expiry. The flag
    // exists from 0.3.0; earlier clients required a string expiresAt, so the
    // device may send the owner-kept shape only to a requester that declared
    // this.
    supportsPersistentSessions: true,
    ...(requestedExpiresInSeconds === undefined ? {} : { requestedExpiresInSeconds }),
    browserPublicKeyJwk: browserPublicKeyJwk as unknown as JsonValue,
    requestedAt,
    // The same keys as announced at create: a device that reads both copies
    // issues a grant only when they match.
    displayGrant
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
  // One approval deadline covers the request POST and every result poll, so
  // a broker request that never resolves still ends in approval_timeout.
  const deadline = Date.now() + input.maxWaitMs;
  // A cancel during encryption fired before any listener existed and is not
  // replayed: check now, so a canceled visitor never reaches device approval.
  throwIfAborted(context.signal);
  const approvalController = new AbortController();
  const abortApproval = (): void => {
    approvalController.abort();
  };
  context.signal?.addEventListener("abort", abortApproval, { once: true });
  if (context.signal?.aborted === true) {
    approvalController.abort();
  }
  const deadlineTimer = setTimeout(abortApproval, Math.max(0, input.maxWaitMs));
  const timedOut = (): PlayError => new PlayError("poll timed out", "approval_timeout");
  try {
    try {
      await sendMintRequest({ fetcher: context.fetcher, channel, encrypted: encryptedRequest, signal: approvalController.signal });
    } catch (error) {
      throwIfAborted(context.signal);
      if (approvalController.signal.aborted) {
        throw timedOut();
      }
      throw error;
    }
    // From the start: the answer can precede the request (see above).
    let afterSeq = 0;
    while (Date.now() <= deadline) {
      throwIfAborted(context.signal);
      let poll: PollMessagesResponse;
      try {
        poll = await pollMessages({ fetcher: context.fetcher, channel, afterSeq, signal: approvalController.signal });
      } catch (error) {
        throwIfAborted(context.signal);
        if (approvalController.signal.aborted) {
          throw timedOut();
        }
        if (error instanceof TypeError) {
          await sleep(context.pollIntervalMs ?? defaultResultPollIntervalMs, approvalController.signal);
          continue;
        }
        if (error instanceof ChannelGoneError) {
          throw timedOut();
        }
        throw error;
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
        return await parseMintResult(plaintext, channel.channelId, requestMessageId, input.grantKeys.ctl);
      }
      await sleep(context.pollIntervalMs ?? defaultResultPollIntervalMs, approvalController.signal);
    }
    throwIfAborted(context.signal);
    throw timedOut();
  } finally {
    clearTimeout(deadlineTimer);
    context.signal?.removeEventListener("abort", abortApproval);
  }
}

/**
 * Pairs this browser with the visitor's Art Computer and returns the display
 * grant it issued, or the stored one for this origin when it is still valid.
 *
 * The site creates a pairing channel on the broker and hands the visitor the
 * way in through `onPairingMaterial`: an app link (tap on a phone, QR on a
 * desktop) and a six-digit code. The Feral File app brings the Art Computer to
 * the channel, the owner approves in the app, and the grant comes back
 * end-to-end encrypted. Every pairing generates fresh keys; a grant that is
 * still stored is replaced only once the new one has arrived, and the old one
 * is then revoked on a best-effort basis.
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
  if (options.storage === false || !hasIndexedDb()) {
    throw new PlayError("IndexedDB is required to keep the display grant and its keys", "storage_unavailable");
  }
  removeLegacySession(origin);
  // Read raw: an expired grant is still revoked once it has been replaced.
  const existing = await readStoredDisplayGrant(origin);
  if (existing !== undefined && !grantExpired(existing)) {
    return sessionOf(existing);
  }

  const signal = options.signal;
  const context: PairingContext = { fetcher, origin, browserInfo, signal, pollIntervalMs: options.pollIntervalMs };
  for (let attempt = 0; ; attempt += 1) {
    throwIfAborted(signal);
    // A fresh key pair per channel: a replaced channel shares nothing with the
    // one it replaces. The grant keys are fresh per attempt for the same reason.
    const keyPair = await generateBrowserKeyPair();
    const browserPublicKeyJwk = await exportPublicJwk(keyPair.publicKey);
    const grantKeys = await generateDisplayGrantKeys();
    const mintRequest: AnnouncedMintRequest = {
      requestMessageId: randomMessageId(),
      requestedExpiresInSeconds,
      requestedAt: new Date().toISOString(),
      displayGrant: displayGrantRequest(grantKeys)
    };
    let channel: BrowserChannel;
    try {
      channel = await createChannel({ fetcher, brokerBaseUrl, browserPublicKeyJwk, origin, browserInfo, mintRequest, idleTtlSeconds, signal });
    } catch (error) {
      throw signal?.aborted === true ? canceledError() : error;
    }
    // Start the channel's clock once it exists, so a slow create does not eat
    // its lifetime.
    const localDeadline = Date.now() + idleTtlSeconds * 1000;
    try {
      // A cancel that lands while the create call resolves must not hand out a
      // live link and code; throwing here closes the channel below.
      throwIfAborted(signal);
      options.onPairingMaterial?.({
        appLink: buildAppLink(appLinkBaseUrl, channel.channelId, channel.pairingToken),
        shortCode: channel.shortCode,
        expiresAt: channel.expiresAt
      });
      const peer = await waitForPeer(context, channel, localDeadline);
      options.onPeerJoined?.();
      const grant = await completeMint({
        context,
        channel,
        peer,
        keyPair,
        browserPublicKeyJwk,
        mintRequest,
        grantKeys,
        maxWaitMs: options.maxWaitMs ?? 300_000
      });
      // A cancel that lands while the result is decrypted still wins.
      throwIfAborted(signal);
      const record: StoredDisplayGrant = {
        origin,
        deviceId: grant.profile.dev,
        ctl: grantKeys.ctl,
        profile: grant.profile,
        relayV2Endpoint: grant.relayV2Endpoint,
        ...(grant.expiresAt === undefined ? {} : { expiresAt: grant.expiresAt }),
        persistent: grant.expiresAt === undefined,
        sigKey: grantKeys.sig.privateKey,
        sigPublic: grantKeys.sigPublic,
        encKey: grantKeys.enc.privateKey,
        ctr: 0,
        storedAt: new Date().toISOString()
      };
      // The store returns exactly the record this write displaced (another
      // tab may have paired meanwhile), so the right grant is revoked. Its
      // keys are only in memory now; revoke it on the device it came from
      // before they are dropped, unless it had already expired. Fire and
      // forget: the cast that follows must not wait on an offline device.
      const previous = await replaceStoredDisplayGrant(record);
      if (previous !== undefined && !grantExpired(previous)) {
        void revokeDisplayGrant(previous, previous.ctr + 1, options.socketFactory);
      }
      return sessionOf(record);
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
