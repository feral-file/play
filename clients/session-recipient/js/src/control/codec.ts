/**
 * FF1 control protocol v1 codec (ffos-user docs/ff1-control-v1.md), the
 * browser side of a display grant: seal `cmd` requests (§3) and open replies
 * (§4). Ported from ff-cli (src/utilities/control/codec.ts) onto WebCrypto:
 * the signing key is a `CryptoKey`, and the thumbprint and key checks are
 * async. Notifications (§9) and enrollment are not ported: a display grant
 * subscribes to nothing and is issued through mint pairing.
 *
 * Cryptography is done by `jose`; everything jose is lenient about is checked
 * here first, because the spec is stricter than RFC 7515/7516:
 *
 * - Every protected header has a CLOSED member set. jose would accept a `zip`,
 *   `jku` or extra member; this module rejects them before jose sees the token.
 * - Duplicate members and non-canonical integers are rejected (strict-json.ts).
 * - Only ES256 (raw 64-byte r||s), ECDH-ES (direct) and dir with A256GCM.
 *
 * Do not "simplify" a check here into a jose option: the closed-set rules are
 * the protocol, and two implementations disagreeing on them is the bug class
 * the spec exists to prevent.
 */

import { CompactEncrypt, CompactSign, compactDecrypt, compactVerify, importJWK } from "jose";
import {
  ControlFormatError,
  b64uDecode,
  b64uEncode,
  boolMember,
  isB64uOfLength,
  isPlainObject,
  parseStrictJson,
  stringMember,
  strictObject,
  toPlainJson,
  uintMember
} from "./strict-json.js";
import { type PublicJwk, canonicalJwkJson, isThumbprint, parsePublicJwk, thumbprint } from "./jwk.js";

/** MAX_COMPACT_BYTES bounds a whole compact object before any decoding (§3.1). */
export const MAX_COMPACT_BYTES = 4 * 1024 * 1024;
/** MAX_HEADER_BYTES bounds the base64url protected-header segment (§3.1). */
export const MAX_HEADER_BYTES = 4 * 1024;
/**
 * MAX_ENVELOPE_COMPACT_BYTES is what a request may grow to: relay v2 caps the
 * reassembled command at 4 MiB (§10), so the compact leaves room for the
 * `{"command":"ff1Envelope","request":{"v":1,"jwe":…}}` wrapper.
 */
export const MAX_ENVELOPE_COMPACT_BYTES = MAX_COMPACT_BYTES - 1024;
/** DEFAULT_REQUEST_LIFETIME_SECONDS is exp - iat; the spec allows [1, 120]. */
export const DEFAULT_REQUEST_LIFETIME_SECONDS = 60;

const TYP_REQ_JWE = "ff1-req+jwe";
const TYP_REQ_JWS = "ff1-req+jws";
const TYP_RES_JWE = "ff1-res+jwe";
const TYP_RES_JWS = "ff1-res+jws";
const GCM_IV_LEN = 12;
const GCM_TAG_LEN = 16;
const KEY_LEN = 32;
const ES256_SIG_LEN = 64;
const RID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const textEncoder = new TextEncoder();

/** DeviceProfile is the public device profile of §2. */
export type DeviceProfile = {
  v: 1;
  dev: string;
  gen: string;
  sig: PublicJwk;
  enc: PublicJwk;
};

/** EnrollObject is the §5 enroll claim; only encoded here, never built. */
export type EnrollObject = {
  sig: PublicJwk;
  enc: PublicJwk;
  label: string;
  platform: string;
  inv?: string;
};

/** RequestClaims are the §3.3 claims. */
export type RequestClaims = {
  v: 1;
  dev: string;
  gen: string;
  ctl: string;
  rid: string;
  ctr: number;
  iat: number;
  exp: number;
  op: "cmd" | "enroll";
  rk: string;
  cmd?: string;
  req?: Record<string, unknown>;
  enroll?: EnrollObject;
};

/** ReplyClaims are the §4.1 reply claims. */
export type ReplyClaims = {
  v: 1;
  dev: string;
  gen: string;
  ctl: string;
  rid: string;
  iat: number;
  ok: boolean;
  code?: string;
  res?: unknown;
};

/** RequestInput is everything sealRequest needs; omitted fields are generated. */
export type RequestInput = {
  profile: DeviceProfile;
  /** thumb(ctlSig), the controllerId the device issued the grant under. */
  ctl: string;
  /** The ECDSA P-256 private key behind `ctl`. */
  sigKey: CryptoKey;
  ctr: number;
  cmd: string;
  req: Record<string, unknown>;
  /** Unix seconds; defaults to the wall clock. */
  now?: number;
  lifetimeSeconds?: number;
  /** Test seams: fixtures fix these. Production must leave them unset. */
  rid?: string;
  rk?: Uint8Array;
  ephemeralKey?: Record<string, unknown>;
  iv?: Uint8Array;
};

/** SealedRequest is a request ready to send plus what is needed to open its reply. */
export type SealedRequest = {
  compact: string;
  jws: string;
  claims: RequestClaims;
  rk: Uint8Array;
};

/**
 * parseProfile validates a device profile `{v:1,dev,gen,sig,enc}` (§2) with
 * a closed member set. The profile is the pin source, so it is never trusted
 * partially.
 */
export async function parseProfile(value: unknown): Promise<DeviceProfile> {
  const obj = strictObject(value, ["v", "dev", "gen", "sig", "enc"], [], "profile");
  if (obj["v"] !== 1) {
    throw new ControlFormatError("profile v must be 1");
  }
  const dev = stringMember(obj, "dev");
  const gen = stringMember(obj, "gen");
  if (dev.length === 0) {
    throw new ControlFormatError("profile dev is empty");
  }
  if (!isB64uOfLength(gen, 16)) {
    throw new ControlFormatError("profile gen must be b64u(16 bytes)");
  }
  return {
    v: 1,
    dev,
    gen,
    sig: await parsePublicJwk(obj["sig"], "profile sig"),
    enc: await parsePublicJwk(obj["enc"], "profile enc")
  };
}

/**
 * approvalCode is §5.4: the first 4 bytes of
 * SHA-256("ff1-approval-code/v1|" + ctl + "|" + sigPin) as a big-endian
 * uint32, mod 1,000,000, zero-padded to 6 digits. A display grant never shows
 * one; it is kept so the fixture vectors stay fully exercised.
 */
export async function approvalCode(ctl: string, sigPin: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(`ff1-approval-code/v1|${ctl}|${sigPin}`));
  return String(new DataView(digest).getUint32(0) % 1_000_000).padStart(6, "0");
}

/**
 * encodeRequestClaims serializes claims in the reference member order. Order
 * is not significant to the device, but a stable order makes the payload
 * byte-comparable with the Go fixtures.
 */
export function encodeRequestClaims(c: RequestClaims): string {
  const parts = [
    `"v":1`,
    `"dev":${JSON.stringify(c.dev)}`,
    `"gen":${JSON.stringify(c.gen)}`,
    `"ctl":${JSON.stringify(c.ctl)}`,
    `"rid":${JSON.stringify(c.rid)}`,
    `"ctr":${String(c.ctr)}`,
    `"iat":${String(c.iat)}`,
    `"exp":${String(c.exp)}`,
    `"op":${JSON.stringify(c.op)}`,
    `"rk":${JSON.stringify(c.rk)}`
  ];
  if (c.cmd !== undefined) {
    parts.push(`"cmd":${JSON.stringify(c.cmd)}`, `"req":${JSON.stringify(c.req ?? {})}`);
  }
  if (c.enroll !== undefined) {
    const e = c.enroll;
    const enroll = [
      `"sig":${canonicalJwkJson(e.sig)}`,
      `"enc":${canonicalJwkJson(e.enc)}`,
      `"label":${JSON.stringify(e.label)}`,
      `"platform":${JSON.stringify(e.platform)}`
    ];
    if (e.inv !== undefined) {
      enroll.push(`"inv":${JSON.stringify(e.inv)}`);
    }
    parts.push(`"enroll":{${enroll.join(",")}}`);
  }
  return `{${parts.join(",")}}`;
}

/**
 * buildRequestClaims assembles and validates §3.3 `cmd` claims. It refuses to
 * build a request the device would answer `invalid_request`, so such a bug
 * surfaces locally instead of burning a counter on the device.
 */
export function buildRequestClaims(input: RequestInput, rk: Uint8Array): RequestClaims {
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const lifetime = input.lifetimeSeconds ?? DEFAULT_REQUEST_LIFETIME_SECONDS;
  const rid = input.rid ?? b64uEncode(crypto.getRandomValues(new Uint8Array(16)));
  if (!Number.isSafeInteger(input.ctr) || input.ctr < 1) {
    throw new Error("ctr must be a positive integer");
  }
  if (!RID_PATTERN.test(rid) || rk.length !== KEY_LEN) {
    throw new Error("rid or rk is malformed");
  }
  if (!Number.isInteger(lifetime) || lifetime < 1 || lifetime > 120) {
    throw new Error("request lifetime must be 1-120 seconds");
  }
  if (input.cmd.length === 0 || textEncoder.encode(input.cmd).length > 64) {
    throw new Error("cmd must be a 1-64 byte command name");
  }
  if (!isPlainObject(input.req)) {
    throw new Error("req must be a JSON object");
  }
  return {
    v: 1,
    dev: input.profile.dev,
    gen: input.profile.gen,
    ctl: input.ctl,
    rid,
    ctr: input.ctr,
    iat: now,
    exp: now + lifetime,
    op: "cmd",
    rk: b64uEncode(rk),
    cmd: input.cmd,
    req: input.req
  };
}

/**
 * signRequest produces the §3.2 inner JWS: header exactly
 * `{"alg":"ES256","kid":ctl,"typ":"ff1-req+jws"}`, raw r||s signature.
 */
export async function signRequest(sigKey: CryptoKey, ctl: string, payload: string): Promise<string> {
  return new CompactSign(textEncoder.encode(payload))
    .setProtectedHeader({ alg: "ES256", kid: ctl, typ: TYP_REQ_JWS })
    .sign(sigKey);
}

/**
 * encryptRequest wraps a JWS in the §3.1 request JWE (ECDH-ES direct, A256GCM)
 * for the pinned devEnc.
 *
 * jose appends `epk` to the protected header itself, in the order x, crv,
 * kty, y rather than the thumbprint order the spec RECOMMENDS; the device
 * accepts any order (MUST), so the header is re-parsed and checked for the
 * exact member set and a valid epk instead of hand-rolling the key agreement.
 * That check is what guards against a jose upgrade adding a member the device
 * would reject.
 */
export async function encryptRequest(
  devEnc: PublicJwk,
  jws: string,
  fixed: { ephemeralKey?: Record<string, unknown>; iv?: Uint8Array } = {}
): Promise<string> {
  const devEncKid = await thumbprint(devEnc);
  const recipient = await importJWK({ ...devEnc }, "ECDH-ES");
  const builder = new CompactEncrypt(textEncoder.encode(jws)).setProtectedHeader({
    alg: "ECDH-ES",
    enc: "A256GCM",
    kid: devEncKid,
    typ: TYP_REQ_JWE,
    cty: TYP_REQ_JWS
  });
  if (fixed.ephemeralKey !== undefined) {
    const epk = await importJWK({ ...fixed.ephemeralKey, ext: true }, "ECDH-ES", { extractable: true });
    builder.setKeyManagementParameters({ epk: epk as Exclude<typeof epk, Uint8Array> });
  }
  if (fixed.iv !== undefined) {
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- fixture vectors fix the IV
    builder.setInitializationVector(fixed.iv);
  }
  const compact = await builder.encrypt(recipient);
  await checkRequestHeader(compact.split(".")[0] ?? "", devEncKid);
  return compact;
}

/** checkRequestHeader asserts a request JWE header is exactly the §3.1 shape. */
export async function checkRequestHeader(segment: string, devEncKid: string): Promise<PublicJwk> {
  const header = parseHeader(segment, {
    alg: "ECDH-ES",
    enc: "A256GCM",
    kid: devEncKid,
    typ: TYP_REQ_JWE,
    cty: TYP_REQ_JWS,
    epk: null
  });
  return parsePublicJwk(header["epk"], "epk");
}

/**
 * sealRequest builds a complete request: claims, inner JWS, outer JWE.
 * A fresh rk, rid, epk and IV are drawn for every call, which is what makes
 * "never resend the same request" structural: callers retry by sealing again.
 */
export async function sealRequest(input: RequestInput): Promise<SealedRequest> {
  const rk = input.rk ?? crypto.getRandomValues(new Uint8Array(KEY_LEN));
  const claims = buildRequestClaims(input, rk);
  const jws = await signRequest(input.sigKey, claims.ctl, encodeRequestClaims(claims));
  const compact = await encryptRequest(input.profile.enc, jws, {
    ...(input.ephemeralKey === undefined ? {} : { ephemeralKey: input.ephemeralKey }),
    ...(input.iv === undefined ? {} : { iv: input.iv })
  });
  if (compact.length > MAX_ENVELOPE_COMPACT_BYTES) {
    throw new Error(
      `the encrypted request is ${String(compact.length)} bytes, over the FF1 limit of ${String(MAX_ENVELOPE_COMPACT_BYTES)}; host large playlists by URL instead`
    );
  }
  return { compact, jws, claims, rk };
}

/**
 * parseHeader decodes a protected header and checks its exact member set and
 * the exact string value of each member whose expected value is a string. A
 * null expectation means "present; the caller checks it".
 */
function parseHeader(segment: string, expected: Record<string, string | null>): Record<string, unknown> {
  if (segment.length === 0 || segment.length > MAX_HEADER_BYTES) {
    throw new ControlFormatError("protected header size");
  }
  const header = strictObject(parseStrictJson(b64uDecode(segment)), Object.keys(expected), [], "protected header");
  for (const [key, want] of Object.entries(expected)) {
    if (want !== null && header[key] !== want) {
      throw new ControlFormatError(`protected header ${key} is not ${JSON.stringify(want)}`);
    }
  }
  return header;
}

/**
 * splitJwe checks the five-part compact form of the dir profile: size, empty
 * encrypted key, 12-byte IV, 16-byte tag, exact header.
 */
function splitJwe(compact: string, expected: Record<string, string | null>): void {
  if (compact.length > MAX_COMPACT_BYTES) {
    throw new ControlFormatError("compact JWE size");
  }
  const parts = compact.split(".");
  if (parts.length !== 5 || parts[1] !== "") {
    throw new ControlFormatError("compact JWE shape");
  }
  parseHeader(parts[0] ?? "", expected);
  if (b64uDecode(parts[2] ?? "").length !== GCM_IV_LEN || b64uDecode(parts[4] ?? "").length !== GCM_TAG_LEN) {
    throw new ControlFormatError("JWE IV or tag length");
  }
  b64uDecode(parts[3] ?? "");
}

/** decryptDir opens a dir/A256GCM JWE whose shape splitJwe already checked. */
async function decryptDir(compact: string, key: Uint8Array): Promise<Uint8Array> {
  if (key.length !== KEY_LEN) {
    throw new ControlFormatError("content key length");
  }
  try {
    const { plaintext } = await compactDecrypt(compact, key, {
      keyManagementAlgorithms: ["dir"],
      contentEncryptionAlgorithms: ["A256GCM"]
    });
    return plaintext;
  } catch {
    throw new ControlFormatError("JWE authentication failed");
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

/**
 * verifyReplyJws checks the §4.1 inner JWS against the PINNED devSig and
 * returns its payload bytes.
 */
async function verifyReplyJws(jws: string, devSig: PublicJwk): Promise<Uint8Array> {
  const parts = jws.split(".");
  if (parts.length !== 3) {
    throw new ControlFormatError("compact JWS shape");
  }
  const header = parseHeader(parts[0] ?? "", { alg: "ES256", kid: null, typ: TYP_RES_JWS });
  if (!isThumbprint(header["kid"]) || header["kid"] !== (await thumbprint(devSig))) {
    throw new ControlFormatError("reply kid is not the pinned devSig");
  }
  // A DER, truncated or padded signature is never r||s (§3.2).
  if (b64uDecode(parts[2] ?? "").length !== ES256_SIG_LEN) {
    throw new ControlFormatError("reply signature length");
  }
  // Decode the payload segment strictly ourselves (§1: no padding, no
  // non-zero trailing bits): jose's decoder is lenient, and two segments
  // that decode to the same claims must not both be accepted.
  const strictPayload = b64uDecode(parts[1] ?? "");
  let payload: Uint8Array;
  try {
    const key = await importJWK({ ...devSig }, "ES256");
    ({ payload } = await compactVerify(jws, key, { algorithms: ["ES256"] }));
  } catch {
    throw new ControlFormatError("reply signature");
  }
  if (!sameBytes(payload, strictPayload)) {
    throw new ControlFormatError("reply payload decoding mismatch");
  }
  return strictPayload;
}

/**
 * parseReplyClaims applies the §4.1 closed member set; `code` is present
 * exactly when `ok` is false.
 */
function parseReplyClaims(payload: Uint8Array): ReplyClaims {
  const obj = strictObject(parseStrictJson(payload), ["v", "dev", "gen", "ctl", "rid", "iat", "ok"], ["code", "res"], "reply claims");
  if (uintMember(obj, "v") !== 1) {
    throw new ControlFormatError("reply v");
  }
  const ok = boolMember(obj, "ok");
  const hasCode = Object.prototype.hasOwnProperty.call(obj, "code");
  if (hasCode === ok) {
    throw new ControlFormatError("reply code must be present exactly when ok is false");
  }
  const claims: ReplyClaims = {
    v: 1,
    dev: stringMember(obj, "dev"),
    gen: stringMember(obj, "gen"),
    ctl: stringMember(obj, "ctl"),
    rid: stringMember(obj, "rid"),
    iat: uintMember(obj, "iat"),
    ok
  };
  if (hasCode) {
    claims.code = stringMember(obj, "code");
  }
  if (Object.prototype.hasOwnProperty.call(obj, "res")) {
    claims.res = toPlainJson(obj["res"]);
  }
  return claims;
}

/** ReplyBinding is what the browser sent and the reply must echo (§4.2). */
export type ReplyBinding = {
  dev: string;
  gen: string;
  ctl: string;
  rid: string;
};

/**
 * openReply is §4.1-4.2 in full: exact headers, decryption with the request's
 * rk, ES256 against the pinned devSig, strict claims, and the dev/gen/ctl/rid
 * binding. Any failure means "no valid reply"; a reply is never trusted
 * partially, so the caller gets either verified claims or an exception.
 */
export async function openReply(compact: string, rk: Uint8Array, devSig: PublicJwk, bind: ReplyBinding): Promise<ReplyClaims> {
  splitJwe(compact, { alg: "dir", enc: "A256GCM", typ: TYP_RES_JWE, cty: TYP_RES_JWS });
  const jws = new TextDecoder().decode(await decryptDir(compact, rk));
  const claims = parseReplyClaims(await verifyReplyJws(jws, devSig));
  if (claims.dev !== bind.dev || claims.gen !== bind.gen || claims.ctl !== bind.ctl || claims.rid !== bind.rid) {
    throw new ControlFormatError("reply is not bound to this request");
  }
  return claims;
}

/**
 * findEnvelopeAnswer locates the device's answer in a relay reply body: the
 * RPC `message` wraps it one or two levels down. The answer is `{v:1,jwe}` or
 * a public `{error:{code}}`.
 */
export function findEnvelopeAnswer(value: unknown): { jwe?: string; code?: string } | undefined {
  let current: unknown = value;
  for (let depth = 0; depth < 3 && isPlainObject(current); depth += 1) {
    const record: Record<string, unknown> = current;
    if (record["v"] === 1 && typeof record["jwe"] === "string") {
      return { jwe: record["jwe"] };
    }
    const error = record["error"];
    if (isPlainObject(error) && typeof error["code"] === "string") {
      return { code: error["code"] };
    }
    current = record["message"];
  }
  return undefined;
}
