/**
 * Test-only FF1 device side of the control protocol v1, written from the spec
 * (ffos-user docs/ff1-control-v1.md) with node:crypto only. Ported from
 * ff-cli tests/helpers/control-device.ts.
 *
 * It deliberately shares NO code with src/control (which uses jose and its
 * own strict parser), so a request sealed by the library and opened here, and
 * a Go fixture opened here, are two independent checks of the same bytes. It
 * implements only what the tests need: §3.4 steps 1-3 (public errors), and
 * sealing replies (§4.1) so a stub device can answer like an FF1.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  randomBytes,
  sign,
  verify,
  type JsonWebKey as NodeJsonWebKey
} from "node:crypto";

export type Jwk = {
  kty: string;
  crv: string;
  x: string;
  y: string;
  d?: string;
};

const b64 = (bytes: Buffer | Uint8Array | string): string => Buffer.from(bytes as Buffer).toString("base64url");
const unb64 = (text: string): Buffer => Buffer.from(text, "base64url");

/** thumb is RFC 7638 for P-256, computed independently of src/. */
export function thumb(jwk: Jwk): string {
  return b64(createHash("sha256").update(`{"crv":"P-256","kty":"EC","x":"${jwk.x}","y":"${jwk.y}"}`).digest());
}

/** concatKdf is RFC 7518 §4.6.2 for ECDH-ES direct with A256GCM. */
export function concatKdf(z: Buffer): Buffer {
  const u32 = (n: number): Buffer => {
    const out = Buffer.alloc(4);
    out.writeUInt32BE(n);
    return out;
  };
  return createHash("sha256")
    .update(Buffer.concat([u32(1), z, u32(7), Buffer.from("A256GCM"), u32(0), u32(0), u32(256)]))
    .digest();
}

/** DevicePublicError is a §4.4 public error. */
export class DevicePublicError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function exactKeys(obj: Record<string, unknown>, keys: string[]): boolean {
  const got = Object.keys(obj).sort();
  return got.length === keys.length && [...keys].sort().every((key, index) => got[index] === key);
}

/** hasDuplicateTopLevelKeys detects a repeated member name anywhere in a flat header. */
function hasDuplicateTopLevelKeys(text: string): boolean {
  const keys = [...text.matchAll(/"((?:[^"\\]|\\.)*)"\s*:/g)].map((match) => JSON.parse(`"${match[1] ?? ""}"`) as string);
  return new Set(keys).size !== keys.length;
}

function parseHeaderSeg(seg: string): Record<string, unknown> {
  const text = unb64(seg).toString("utf8");
  if (hasDuplicateTopLevelKeys(text)) {
    throw new DevicePublicError("bad_envelope");
  }
  return JSON.parse(text) as Record<string, unknown>;
}

function gcmOpen(key: Buffer, ivB64: string, ctB64: string, tagB64: string, aad: string): Buffer {
  const decipher = createDecipheriv("aes-256-gcm", key, unb64(ivB64));
  decipher.setAAD(Buffer.from(aad, "ascii"));
  decipher.setAuthTag(unb64(tagB64));
  return Buffer.concat([decipher.update(unb64(ctB64)), decipher.final()]);
}

function gcmSeal(key: Buffer, header: string, plaintext: Buffer): string {
  const hseg = b64(header);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(hseg, "ascii"));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return `${hseg}..${b64(iv)}.${b64(ciphertext)}.${b64(cipher.getAuthTag())}`;
}

function esVerify(pub: Jwk, input: string, signature: Buffer): boolean {
  if (signature.length !== 64) {
    return false;
  }
  const key = createPublicKey({ key: { kty: "EC", crv: "P-256", x: pub.x, y: pub.y }, format: "jwk" });
  return verify("sha256", Buffer.from(input), { key, dsaEncoding: "ieee-p1363" }, signature);
}

function esSign(priv: Jwk, input: string): string {
  const key = createPrivateKey({ key: priv, format: "jwk" });
  return b64(sign("sha256", Buffer.from(input), { key, dsaEncoding: "ieee-p1363" }));
}

/** OpenedRequest is what §3.4 steps 1-3 yield. */
export type OpenedRequest = {
  kid: string;
  claims: Record<string, unknown>;
  payload: string;
};

/**
 * openRequest runs §3.4 steps 1-3 against devEnc, looking up the JWS kid in
 * `grants` (ctl -> public sig JWK) or, for enrollment ops, in enroll.sig.
 */
export function openRequest(compact: string, devEnc: Jwk, grants: Record<string, Jwk>): OpenedRequest {
  if (compact.length > 4 * 1024 * 1024) {
    throw new DevicePublicError("bad_envelope");
  }
  const parts = compact.split(".");
  const [headerSeg, keySeg, ivSeg, ctSeg, tagSeg] = parts;
  if (parts.length !== 5 || keySeg !== "" || headerSeg === undefined || headerSeg.length > 4096) {
    throw new DevicePublicError("bad_envelope");
  }
  let jwsText: string;
  try {
    const header = parseHeaderSeg(headerSeg);
    const epk = header["epk"] as Record<string, unknown>;
    if (
      !exactKeys(header, ["alg", "enc", "kid", "typ", "cty", "epk"]) ||
      header["alg"] !== "ECDH-ES" ||
      header["enc"] !== "A256GCM" ||
      header["typ"] !== "ff1-req+jwe" ||
      header["cty"] !== "ff1-req+jws" ||
      header["kid"] !== thumb(devEnc) ||
      !exactKeys(epk, ["kty", "crv", "x", "y"])
    ) {
      throw new Error("header");
    }
    const z = diffieHellman({
      privateKey: createPrivateKey({ key: devEnc as NodeJsonWebKey, format: "jwk" }),
      publicKey: createPublicKey({ key: { ...(epk as Jwk) }, format: "jwk" })
    });
    jwsText = gcmOpen(concatKdf(z), ivSeg ?? "", ctSeg ?? "", tagSeg ?? "", headerSeg).toString("utf8");
  } catch (error) {
    if (error instanceof DevicePublicError) {
      throw error;
    }
    throw new DevicePublicError("bad_envelope");
  }
  return openInnerJws(jwsText, grants);
}

function openInnerJws(jwsText: string, grants: Record<string, Jwk>): OpenedRequest {
  const parts = jwsText.split(".");
  const [headerSeg, payloadSeg, sigSeg] = parts;
  if (parts.length !== 3 || headerSeg === undefined || payloadSeg === undefined || sigSeg === undefined) {
    throw new DevicePublicError("bad_envelope");
  }
  let header: Record<string, unknown>;
  let payload: string;
  let claims: Record<string, unknown>;
  try {
    header = parseHeaderSeg(headerSeg);
    payload = unb64(payloadSeg).toString("utf8");
    claims = JSON.parse(payload) as Record<string, unknown>;
  } catch (error) {
    if (error instanceof DevicePublicError) {
      throw error;
    }
    throw new DevicePublicError("bad_envelope");
  }
  if (!exactKeys(header, ["alg", "kid", "typ"]) || header["alg"] !== "ES256" || header["typ"] !== "ff1-req+jws" || typeof header["kid"] !== "string") {
    throw new DevicePublicError("bad_envelope");
  }
  const kid = header["kid"];
  let key = grants[kid];
  const enroll = claims["enroll"] as { sig?: Jwk } | undefined;
  if (key === undefined && (claims["op"] === "enroll" || claims["op"] === "requestAccess") && enroll?.sig !== undefined) {
    key = thumb(enroll.sig) === kid ? enroll.sig : undefined;
  }
  if (key === undefined) {
    throw new DevicePublicError("unknown_controller");
  }
  if (!esVerify(key, `${headerSeg}.${payloadSeg}`, unb64(sigSeg))) {
    throw new DevicePublicError("bad_signature");
  }
  return { kid, claims, payload };
}

/** sealReply builds a §4.1 reply the way the device does. */
export function sealReply(
  devSig: Jwk,
  rk: string,
  claims: Record<string, unknown>,
  mutatePayloadSegment: (segment: string) => string = (segment) => segment
): string {
  const header = `{"alg":"ES256","kid":"${thumb(devSig)}","typ":"ff1-res+jws"}`;
  // The mutation is applied BEFORE signing, so a non-canonical segment still
  // carries a valid signature: only strict decoding can reject it.
  const input = `${b64(header)}.${mutatePayloadSegment(b64(JSON.stringify(claims)))}`;
  const jws = `${input}.${esSign(devSig, input)}`;
  return gcmSeal(unb64(rk), '{"alg":"dir","enc":"A256GCM","typ":"ff1-res+jwe","cty":"ff1-res+jws"}', Buffer.from(jws));
}

/** FakeAnswer is what a FakeFF1 handler decides for one opened request. */
export type FakeAnswer =
  | { ok: true; res?: unknown }
  | { ok: false; code: string; res?: unknown }
  | { publicCode: string };

export type DeviceKeys = { dev: string; gen: string; sig: Jwk; enc: Jwk };

/**
 * FakeFF1 answers `ff1Envelope` commands like the device: it opens the
 * request with the device keys, enforces one use per ctr, records what it saw
 * and replies with a reply sealed under the request's rk. `grants` maps a ctl
 * to its public signing key and may grow as grants are issued.
 */
export class FakeFF1 {
  readonly seen: Record<string, unknown>[] = [];
  private readonly used = new Set<string>();

  constructor(
    readonly keys: DeviceKeys,
    readonly grants: Record<string, Jwk> = {},
    private readonly decide: (claims: Record<string, unknown>) => FakeAnswer = () => ({ ok: true, res: { ok: true } })
  ) {}

  /** handle answers one relay RPC body with the device's answer object. */
  handle(message: unknown): { v: 1; jwe: string } | { error: { code: string } } {
    const body = message as { command?: string; request?: { v?: number; jwe?: string } } | undefined;
    if (body?.command !== "ff1Envelope" || body.request?.v !== 1 || body.request.jwe === undefined) {
      return { error: { code: "enrollment_required" } };
    }
    let opened: OpenedRequest;
    try {
      opened = openRequest(body.request.jwe, this.keys.enc, this.grants);
    } catch (error) {
      return { error: { code: error instanceof DevicePublicError ? error.code : "bad_envelope" } };
    }
    const claims = opened.claims;
    this.seen.push(claims);
    const replayKey = `${opened.kid}:${String(claims["ctr"])}`;
    const answer: FakeAnswer = this.used.has(replayKey) ? { ok: false, code: "replay" } : this.decide(claims);
    this.used.add(replayKey);
    if ("publicCode" in answer) {
      return { error: { code: answer.publicCode } };
    }
    const reply: Record<string, unknown> = {
      v: 1,
      dev: this.keys.dev,
      gen: this.keys.gen,
      ctl: opened.kid,
      rid: claims["rid"],
      iat: claims["iat"],
      ok: answer.ok
    };
    if (!answer.ok) {
      reply["code"] = answer.code;
    }
    if (answer.res !== undefined) {
      reply["res"] = answer.res;
    }
    return { v: 1, jwe: sealReply(this.keys.sig, String(claims["rk"]), reply) };
  }
}
