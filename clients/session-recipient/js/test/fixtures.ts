import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type { DeviceKeys, Jwk } from "./control-device.js";

/** The vendored ffos-user protocol fixtures (see fixtures/ff1-control-v1/SOURCE.md). */
export const fixturesDir = path.join(import.meta.dirname, "fixtures", "ff1-control-v1");

export type Fixture = {
  name: string;
  kind: string;
  [key: string]: unknown;
};

export type FixtureController = { ctl: string; sig: Jwk; enc: Jwk; nk?: string; role?: string; platform?: string; origin?: string };

type KeysFile = {
  device: DeviceKeys & { profile: Record<string, unknown>; pins: { sig: string; enc: string } };
  controllers: Record<string, FixtureController>;
};

export function fixtureKeys(): KeysFile {
  return JSON.parse(readFileSync(path.join(fixturesDir, "keys.json"), "utf8")) as KeysFile;
}

/** The fixture FF1: its private keys (for the stub device) and public profile (what a grant pins). */
export function fixtureDevice(): DeviceKeys & { profile: Record<string, unknown> } {
  const { device } = fixtureKeys();
  return { dev: device.dev, gen: device.gen, sig: device.sig, enc: device.enc, profile: device.profile };
}

export function loadFixtures(dir: "positive" | "negative"): Fixture[] {
  return readdirSync(path.join(fixturesDir, dir))
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => JSON.parse(readFileSync(path.join(fixturesDir, dir, file), "utf8")) as Fixture);
}
