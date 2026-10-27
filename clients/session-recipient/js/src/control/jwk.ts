/**
 * P-256 JWK handling for the FF1 control protocol v1 (§2), ported from ff-cli
 * (src/utilities/control/jwk.ts) onto WebCrypto, so every key operation is
 * async and private keys are non-extractable `CryptoKey`s.
 *
 * Every key the protocol carries (device, browser, ephemeral) is a P-256 JWK
 * with EXACTLY the members kty, crv, x, y. A private `d` in a public slot is
 * an error, never ignored. WebCrypto's `exportKey("jwk")` adds `key_ops` and
 * `ext`, so a key leaves this library only through `exportPublicJwk`.
 */

import { ControlFormatError, b64uEncode, isB64uOfLength, stringMember, strictObject } from "./strict-json.js";

/** PublicJwk is a validated P-256 public key in wire shape. */
export type PublicJwk = {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
};

const COORD_LEN = 32;
const textEncoder = new TextEncoder();

/**
 * parsePublicJwk validates a parsed JWK object: exact member set, `EC`/`P-256`,
 * 32-byte canonical base64url coordinates, and a point on the curve (the
 * WebCrypto import runs the on-curve check).
 */
export async function parsePublicJwk(value: unknown, what = "JWK"): Promise<PublicJwk> {
  const obj = strictObject(value, ["kty", "crv", "x", "y"], [], what);
  if (stringMember(obj, "kty") !== "EC" || stringMember(obj, "crv") !== "P-256") {
    throw new ControlFormatError(`${what} is not an EC P-256 key`);
  }
  const x = stringMember(obj, "x");
  const y = stringMember(obj, "y");
  if (!isB64uOfLength(x, COORD_LEN) || !isB64uOfLength(y, COORD_LEN)) {
    throw new ControlFormatError(`${what} coordinates must be 32-byte base64url`);
  }
  const jwk: PublicJwk = { kty: "EC", crv: "P-256", x, y };
  try {
    await crypto.subtle.importKey("jwk", { ...jwk }, { name: "ECDSA", namedCurve: "P-256" }, true, ["verify"]);
  } catch {
    throw new ControlFormatError(`${what} is not a point on P-256`);
  }
  return jwk;
}

/**
 * exportPublicJwk exports a WebCrypto public key stripped to the four
 * protocol members: `key_ops`/`ext` never go on the wire.
 */
export async function exportPublicJwk(key: CryptoKey): Promise<PublicJwk> {
  const exported = await crypto.subtle.exportKey("jwk", key);
  return parsePublicJwk({ kty: exported.kty, crv: exported.crv, x: exported.x, y: exported.y }, "exported key");
}

/**
 * canonicalJwkJson is the RFC 7638 required-member serialization, which is
 * also the wire form this library emits inside envelopes.
 */
export function canonicalJwkJson(key: PublicJwk): string {
  return `{"crv":"P-256","kty":"EC","x":${JSON.stringify(key.x)},"y":${JSON.stringify(key.y)}}`;
}

/**
 * thumbprint is the RFC 7638 JWK thumbprint of §2: b64u(SHA-256) of the
 * canonical member serialization. It is always 43 characters.
 */
export async function thumbprint(key: PublicJwk): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(canonicalJwkJson(key)));
  return b64uEncode(new Uint8Array(digest));
}

/** isThumbprint reports whether value is thumbprint-shaped (b64u of 32 bytes). */
export function isThumbprint(value: unknown): value is string {
  return typeof value === "string" && value.length === 43 && isB64uOfLength(value, 32);
}

/** generateSigningKeyPair creates a non-extractable ECDSA P-256 pair (ctlSig). */
export function generateSigningKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
}

/** generateAgreementKeyPair creates a non-extractable ECDH P-256 pair (ctlEnc). */
export function generateAgreementKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
}
