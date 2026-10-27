/**
 * FF1 control protocol v1 conformance (ffos-user docs/ff1-control-v1.md §12):
 * every request, reply and approval-code vector in test/fixtures/ff1-control-v1
 * (vendored from the Go reference; see SOURCE.md there) against the browser
 * codec, plus round-trips of the library's own requests through the
 * independent node:crypto device opener. The notification, controllerQR and
 * registration vectors describe paths a display grant never takes (it
 * subscribes to nothing and is issued through mint pairing), so they are
 * counted but not run.
 */

import { describe, expect, it } from "vitest";
import { compactDecrypt, compactVerify, importJWK } from "jose";
import {
  approvalCode,
  encodeRequestClaims,
  encryptRequest,
  openReply,
  parseProfile,
  sealRequest,
  type DeviceProfile,
  type RequestClaims
} from "../src/control/codec.js";
import { parsePublicJwk, thumbprint } from "../src/control/jwk.js";
import { b64uDecode, parseStrictJson, uintMember } from "../src/control/strict-json.js";
import { concatKdf, openRequest, sealReply, thumb, type DevicePublicError, type Jwk } from "./control-device.js";
import { fixtureKeys, loadFixtures, type Fixture } from "./fixtures.js";

const keys = fixtureKeys();
const device = keys.device;
const controllers = keys.controllers;
const positive = loadFixtures("positive");
const negative = loadFixtures("negative");
const profile: DeviceProfile = await parseProfile(device.profile);

/** The keys the device holds: grants.json records plus display-store records. */
function grantKeys(setup: { grants: string[]; displayGrants?: { name: string }[] }): Record<string, Jwk> {
  const out: Record<string, Jwk> = {};
  for (const name of [...setup.grants, ...(setup.displayGrants ?? []).map((grant) => grant.name)]) {
    const controller = controllers[name];
    if (controller === undefined) {
      throw new Error(`unknown controller ${name}`);
    }
    out[controller.ctl] = { kty: "EC", crv: "P-256", x: controller.sig.x, y: controller.sig.y };
  }
  return out;
}

function controller(name: unknown): { ctl: string; sig: Jwk } {
  const found = controllers[String(name)];
  if (found === undefined) {
    throw new Error(`unknown controller ${String(name)}`);
  }
  return found;
}

/** The fixture path: a private JWK imported as a WebCrypto signing key. */
async function signingKey(jwk: Jwk): Promise<CryptoKey> {
  const key = await importJWK({ ...jwk }, "ES256");
  if (!(key instanceof CryptoKey)) {
    throw new Error("expected a CryptoKey");
  }
  return key;
}

function bindFor(fixture: Fixture): { dev: string; gen: string; ctl: string; rid: string } {
  const claims = fixture["claims"] as { rid: string };
  return { dev: device.dev, gen: device.gen, ctl: controller(fixture["from"]).ctl, rid: claims.rid };
}

describe("ff1-control-v1 fixture inventory", () => {
  it("every fixture kind is known", () => {
    const kinds = new Set([...positive, ...negative].map((fixture) => fixture.kind));
    for (const kind of kinds) {
      expect(["request", "notification", "reply", "approvalCode", "controllerQR", "registration"]).toContain(kind);
    }
    // 85 files at ffos-user 25d776c: keys.json + 20 positive + 64 negative.
    expect(positive).toHaveLength(20);
    expect(negative).toHaveLength(64);
    // The display-grant vectors PR A added are present.
    const names = [...positive, ...negative].map((fixture) => fixture.name);
    for (const name of ["cmd-display-displayPlaylist", "cmd-display-displayPlaylist-legacy", "cmd-display-self-revoke", "display-expired", "display-getDeviceStatus"]) {
      expect(names).toContain(name);
    }
    expect(controllers["display"]).toMatchObject({ role: "display", platform: "web" });
  });

  it("pins are the RFC 7638 thumbprints of the profile keys", async () => {
    expect(await thumbprint(profile.sig)).toBe(device.pins.sig);
    expect(await thumbprint(profile.enc)).toBe(device.pins.enc);
    for (const entry of Object.values(controllers)) {
      expect(await thumbprint(await parsePublicJwk({ kty: "EC", crv: "P-256", x: entry.sig.x, y: entry.sig.y }))).toBe(entry.ctl);
      expect(thumb(entry.sig)).toBe(entry.ctl);
    }
  });

  it("Concat KDF known answer for the all-zero Z (§3.1)", () => {
    expect(concatKdf(Buffer.alloc(32)).toString("base64url")).toBe("ohtGU230iroWUJBOQYR7JT-iHsoYc-MLxzoRXrqr6Yw");
  });
});

describe("approvalCode (§5.4)", () => {
  const vector = positive.find((fixture) => fixture.kind === "approvalCode");
  const cases = (vector?.["cases"] ?? []) as { ctl: string; sigPin: string; code: string }[];
  it("vector is present", () => {
    expect(cases.length).toBeGreaterThan(0);
  });
  it.each(cases)("$ctl with pin $sigPin", async ({ ctl, sigPin, code }) => {
    expect(await approvalCode(ctl, sigPin)).toBe(code);
  });
});

describe("positive request vectors", () => {
  for (const fixture of positive.filter((candidate) => candidate.kind === "request")) {
    describe(fixture.name, () => {
      const setup = fixture["setup"] as { grants: string[]; displayGrants?: { name: string }[] };
      const grants = grantKeys(setup);
      const claims = fixture["claims"] as RequestClaims;

      it("the independent device opener opens the Go request and its claims match", () => {
        const opened = openRequest(fixture["compact"] as string, device.enc, grants);
        expect(opened.payload).toBe(fixture["payload"]);
        expect(opened.claims).toEqual(claims);
        expect(opened.kid).toBe(controller(fixture["from"]).ctl);
      });

      it("jose opens the Go request independently", async () => {
        const encKey = await importJWK({ ...device.enc }, "ECDH-ES");
        const { plaintext } = await compactDecrypt(fixture["compact"] as string, encKey);
        expect(new TextDecoder().decode(plaintext)).toBe(fixture["jws"]);
        const sig = controller(fixture["from"]).sig;
        const sigKey = await importJWK({ kty: sig.kty, crv: sig.crv, x: sig.x, y: sig.y }, "ES256");
        const { payload } = await compactVerify(fixture["jws"] as string, sigKey);
        expect(new TextDecoder().decode(payload)).toBe(fixture["payload"]);
      });

      it("the library encodes the same claims byte for byte", () => {
        expect(encodeRequestClaims(claims)).toBe(fixture["payload"]);
      });

      it("the library opens and verifies the device reply against the pinned devSig", async () => {
        const reply = fixture["reply"] as { compact: string; claims: unknown };
        const opened = await openReply(reply.compact, b64uDecode(fixture["rk"] as string), profile.sig, bindFor(fixture));
        expect(opened).toEqual(reply.claims);
        const expectation = fixture["expect"] as { replyOk?: boolean; replyCode?: string };
        expect(opened.ok).toBe(expectation.replyOk === true);
        expect(opened.code).toBe(expectation.replyCode);
      });

      // A display grant only ever seals op:"cmd"; the enroll vectors are
      // covered by the byte-for-byte encoding above.
      it.skipIf(claims.op !== "cmd")("a request the library seals with the same claims opens on the device side", async () => {
        const from = controller(fixture["from"]);
        const sealed = await sealRequest({
          profile,
          ctl: from.ctl,
          sigKey: await signingKey(from.sig),
          ctr: claims.ctr,
          cmd: claims.cmd ?? "",
          req: claims.req ?? {},
          now: claims.iat,
          lifetimeSeconds: claims.exp - claims.iat,
          rid: claims.rid,
          rk: b64uDecode(claims.rk)
        });
        const opened = openRequest(sealed.compact, device.enc, grants);
        expect(opened.payload).toBe(fixture["payload"]);
        expect(opened.claims).toEqual(claims);
      });

      it("with the vector epk and IV the library reproduces the Go ciphertext", async () => {
        // jose emits epk members as x,crv,kty,y and Go as crv,kty,x,y, so the
        // header (and with it the GCM tag) differs; the KDF output, IV and
        // therefore the ciphertext over the same JWS must not.
        const ours = await encryptRequest(profile.enc, fixture["jws"] as string, {
          ephemeralKey: fixture["ephemeralKey"] as Record<string, unknown>,
          iv: b64uDecode(fixture["iv"] as string)
        });
        const theirs = (fixture["compact"] as string).split(".");
        const mine = ours.split(".");
        expect(mine[2]).toBe(theirs[2]);
        expect(mine[3]).toBe(theirs[3]);
        const header = JSON.parse(Buffer.from(mine[0] ?? "", "base64url").toString("utf8")) as { epk: Jwk };
        expect(Object.keys(header).sort()).toEqual(["alg", "cty", "enc", "epk", "kid", "typ"]);
        expect(Object.keys(header.epk).sort()).toEqual(["crv", "kty", "x", "y"]);
        expect(header.epk.x).toBe((fixture["ephemeralKey"] as Jwk).x);
      });
    });
  }
});

describe("negative reply vectors (client MUST reject)", () => {
  for (const fixture of negative.filter((candidate) => candidate.kind === "reply")) {
    it(fixture.name, async () => {
      await expect(
        openReply(fixture["compact"] as string, b64uDecode(fixture["rk"] as string), profile.sig, fixture["bind"] as { dev: string; gen: string; ctl: string; rid: string })
      ).rejects.toThrow();
    });
  }
});

describe("negative request vectors", () => {
  for (const fixture of negative.filter((candidate) => candidate.kind === "request")) {
    const expectation = fixture["expect"] as { public?: string; replyCode?: string };
    const setup = fixture["setup"] as { grants: string[]; displayGrants?: { name: string }[] };
    if (expectation.public !== undefined) {
      it(`${fixture.name}: the device side answers public ${expectation.public}`, () => {
        const repeat = fixture["compactRepeat"] as { char: string; count: number } | undefined;
        const compact = repeat === undefined ? (fixture["compact"] as string) : repeat.char.repeat(repeat.count);
        expect(() => openRequest(compact, device.enc, grantKeys(setup))).toThrow(
          expect.objectContaining({ code: expectation.public }) as DevicePublicError
        );
      });
    } else {
      it(`${fixture.name}: the library opens the encrypted ${String(expectation.replyCode)} reply`, async () => {
        const reply = fixture["reply"] as { compact: string; claims: unknown };
        const opened = await openReply(reply.compact, b64uDecode(fixture["rk"] as string), profile.sig, bindFor(fixture));
        expect(opened.ok).toBe(false);
        expect(opened.code).toBe(expectation.replyCode);
        expect(opened).toEqual(reply.claims);
      });
    }
  }
});

describe("strict parsing (§1)", () => {
  it("duplicate members are rejected, also after unescaping", () => {
    expect(() => parseStrictJson('{"typ":1,"typ":2}')).toThrow();
    expect(() => parseStrictJson('{"typ":1,"\\u0074yp":2}')).toThrow();
    expect(() => parseStrictJson('{"a":{"b":1,"b":1}}')).toThrow();
  });

  it("non-canonical integers are rejected", () => {
    for (const bad of ["1.0", "1e3", "-1", '"1"', "9007199254740992"]) {
      expect(() => uintMember(parseStrictJson(`{"n":${bad}}`) as Record<string, unknown>, "n"), bad).toThrow();
    }
    expect(() => parseStrictJson('{"n":01}')).toThrow();
    expect(uintMember(parseStrictJson('{"n":42}') as Record<string, unknown>, "n")).toBe(42);
  });

  it("padded, whitespace and non-canonical base64url are rejected", () => {
    expect(() => b64uDecode("QQ==")).toThrow();
    expect(() => b64uDecode("Q Q")).toThrow();
    expect(() => b64uDecode("QR")).toThrow();
    expect([...b64uDecode("QQ")]).toEqual([0x41]);
  });

  it("invalid UTF-8 is rejected", () => {
    expect(() => parseStrictJson(new Uint8Array([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d]))).toThrow();
  });

  it("a public JWK with a private member is rejected", async () => {
    await expect(parseProfile({ ...device.profile, sig: device.sig })).rejects.toThrow();
  });

  it("a point off the curve is rejected", async () => {
    await expect(parsePublicJwk({ kty: "EC", crv: "P-256", x: profile.sig.x, y: profile.enc.y })).rejects.toThrow(/point/);
  });
});

describe("reply payload segment is decoded strictly (§1)", () => {
  const rk = Buffer.alloc(32, 7).toString("base64url");
  const bind = { dev: device.dev, gen: device.gen, ctl: controller("owner").ctl, rid: "rid-strict" };
  const claims = { v: 1, ...bind, iat: 1, ok: true, res: { ok: true } };

  /** withTrailingBits flips the unused low bits of the last base64url character. */
  function withTrailingBits(segment: string): string {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const unused = segment.length % 4 === 2 ? 4 : segment.length % 4 === 3 ? 2 : 0;
    expect(unused).toBeGreaterThan(0);
    const last = alphabet.indexOf(segment.at(-1) ?? "");
    return segment.slice(0, -1) + (alphabet[last | ((1 << unused) - 1)] ?? "");
  }

  function paddedClaims(): typeof claims & { res: { ok: true; pad: string } } {
    let padded = { ...claims, res: { ok: true as const, pad: "" } };
    while (Buffer.byteLength(JSON.stringify(padded)) % 3 === 0) {
      padded = { ...padded, res: { ok: true, pad: `${padded.res.pad}x` } };
    }
    return padded;
  }

  it("a correctly signed reply opens (control)", async () => {
    const compact = sealReply(device.sig, rk, claims);
    expect((await openReply(compact, b64uDecode(rk), profile.sig, bind)).ok).toBe(true);
  });

  it("rejects non-canonical trailing bits in the payload segment", async () => {
    const compact = sealReply(device.sig, rk, paddedClaims(), withTrailingBits);
    await expect(openReply(compact, b64uDecode(rk), profile.sig, bind)).rejects.toThrow(/non-canonical base64url/);
  });

  it("rejects padding in the payload segment", async () => {
    const compact = sealReply(device.sig, rk, paddedClaims(), (segment) => segment.padEnd(Math.ceil(segment.length / 4) * 4, "="));
    await expect(openReply(compact, b64uDecode(rk), profile.sig, bind)).rejects.toThrow(/base64url/);
  });
});
