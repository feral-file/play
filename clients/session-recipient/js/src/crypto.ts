import { canonicalJson, type JsonValue } from "./canonicalJson.js";

export const mintPairingAlgorithm = "P256-HKDF-SHA256-AES-256-GCM" as const;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export type MessageRole = "browser" | "minter";

export type MessageAad = {
  v: 1;
  channelId: string;
  messageId: string;
  seq: number;
  sender: MessageRole;
  recipient: MessageRole;
  algorithm: typeof mintPairingAlgorithm;
};

export type EncryptedChannelMessage = {
  messageId: string;
  sender: MessageRole;
  recipient: MessageRole;
  algorithm: typeof mintPairingAlgorithm;
  aad: string;
  nonce: string;
  ciphertext: string;
  senderPublicKeyJwk?: JsonWebKey;
};

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function aadBytes(aad: MessageAad): Uint8Array {
  return textEncoder.encode(canonicalJson(aad));
}

export function getCrypto(): Crypto {
  return globalThis.crypto;
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await getCrypto().subtle.digest("SHA-256", textEncoder.encode(value)));
}

export async function generateBrowserKeyPair(): Promise<CryptoKeyPair> {
  return getCrypto().subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
}

export async function exportPublicJwk(key: CryptoKey): Promise<JsonWebKey> {
  return getCrypto().subtle.exportKey("jwk", key);
}

export async function importPeerPublicKey(jwk: JsonWebKey): Promise<CryptoKey> {
  return getCrypto().subtle.importKey("jwk", jwk, { name: "ECDH", namedCurve: "P-256" }, false, []);
}

export function messageAad(input: {
  channelId: string;
  messageId: string;
  seq: number;
  sender: MessageRole;
  recipient: MessageRole;
}): MessageAad {
  return {
    v: 1,
    channelId: input.channelId,
    messageId: input.messageId,
    seq: input.seq,
    sender: input.sender,
    recipient: input.recipient,
    algorithm: mintPairingAlgorithm
  };
}

export function messageAadBase64Url(aad: MessageAad): string {
  return base64UrlEncode(aadBytes(aad));
}

async function deriveAesKey(input: {
  privateKey: CryptoKey;
  peerPublicJwk: JsonWebKey;
  channelId: string;
}): Promise<CryptoKey> {
  const peerPublicKey = await importPeerPublicKey(input.peerPublicJwk);
  const sharedBits = await getCrypto().subtle.deriveBits({ name: "ECDH", public: peerPublicKey }, input.privateKey, 256);
  const hkdfKey = await getCrypto().subtle.importKey("raw", sharedBits, "HKDF", false, ["deriveKey"]);
  const salt = await sha256(canonicalJson({ algorithm: mintPairingAlgorithm, channelId: input.channelId, v: 1 }));
  return getCrypto().subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: asArrayBuffer(salt),
      info: textEncoder.encode("ff-mint-pairing/v1/aes-gcm")
    },
    hkdfKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

export async function encryptChannelMessage(input: {
  privateKey: CryptoKey;
  senderPublicJwk?: JsonWebKey;
  peerPublicJwk: JsonWebKey;
  channelId: string;
  messageId: string;
  seq: number;
  sender: MessageRole;
  recipient: MessageRole;
  plaintext: JsonValue;
}): Promise<EncryptedChannelMessage> {
  const aad = messageAad(input);
  const aadRaw = aadBytes(aad);
  const nonce = getCrypto().getRandomValues(new Uint8Array(12));
  const key = await deriveAesKey({ privateKey: input.privateKey, peerPublicJwk: input.peerPublicJwk, channelId: input.channelId });
  const ciphertext = new Uint8Array(await getCrypto().subtle.encrypt(
    { name: "AES-GCM", iv: asArrayBuffer(nonce), additionalData: asArrayBuffer(aadRaw), tagLength: 128 },
    key,
    asArrayBuffer(textEncoder.encode(canonicalJson(input.plaintext)))
  ));
  return {
    messageId: input.messageId,
    sender: input.sender,
    recipient: input.recipient,
    algorithm: mintPairingAlgorithm,
    aad: base64UrlEncode(aadRaw),
    nonce: base64UrlEncode(nonce),
    ciphertext: base64UrlEncode(ciphertext),
    ...(input.senderPublicJwk === undefined ? {} : { senderPublicKeyJwk: input.senderPublicJwk })
  };
}

export async function decryptChannelMessage(input: {
  privateKey: CryptoKey;
  peerPublicJwk: JsonWebKey;
  channelId: string;
  messageId: string;
  seq: number;
  sender: MessageRole;
  recipient: MessageRole;
  algorithm: string;
  aad: string;
  nonce: string;
  ciphertext: string;
}): Promise<unknown> {
  if (input.algorithm !== mintPairingAlgorithm) {
    throw new Error("encrypted message algorithm mismatch");
  }
  const aadRaw = base64UrlDecode(input.aad);
  let decodedAad: Partial<MessageAad>;
  try {
    decodedAad = JSON.parse(textDecoder.decode(aadRaw)) as Partial<MessageAad>;
  } catch {
    throw new Error("encrypted message channel binding mismatch");
  }
  if (
    decodedAad.v !== 1 ||
    decodedAad.channelId !== input.channelId ||
    decodedAad.messageId !== input.messageId ||
    decodedAad.sender !== input.sender ||
    decodedAad.recipient !== input.recipient ||
    decodedAad.algorithm !== mintPairingAlgorithm ||
    (decodedAad.seq !== 0 && decodedAad.seq !== input.seq)
  ) {
    throw new Error("encrypted message channel binding mismatch");
  }
  const nonce = base64UrlDecode(input.nonce);
  if (nonce.byteLength !== 12) {
    throw new Error("AES-GCM nonce must be 12 bytes");
  }
  const key = await deriveAesKey({ privateKey: input.privateKey, peerPublicJwk: input.peerPublicJwk, channelId: input.channelId });
  const plaintext = await getCrypto().subtle.decrypt(
    { name: "AES-GCM", iv: asArrayBuffer(nonce), additionalData: asArrayBuffer(aadRaw), tagLength: 128 },
    key,
    asArrayBuffer(base64UrlDecode(input.ciphertext))
  );
  try {
    return JSON.parse(textDecoder.decode(plaintext)) as unknown;
  } catch {
    // A SyntaxError quotes the input, and the plaintext may hold a session token.
    throw new Error("encrypted message plaintext invalid");
  }
}

export function randomMessageId(): string {
  return `msg_${base64UrlEncode(getCrypto().getRandomValues(new Uint8Array(16)))}`;
}

export function jsonBytes(value: JsonValue): Uint8Array {
  return textEncoder.encode(canonicalJson(value));
}
