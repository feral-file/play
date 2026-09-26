import { type JsonValue } from "./canonicalJson.js";

export const algorithm = "P256-HKDF-SHA256-AES-256-GCM" as const;
export type Algorithm = typeof algorithm;

/** Default landing URL for the app link the pairing dialog opens or encodes as a QR. */
export const defaultAppLinkBaseUrl = "https://link.feralfile.com/pair";

/**
 * What the visitor needs to bring their Art Computer to a site-created channel:
 * the app link (opened directly on a phone, shown as a QR on a desktop) and the
 * six-digit code to type into the Feral File app instead.
 *
 * The link carries the channel's single-use pairing token. It is short-lived
 * and dies with the channel, but it still admits one device to the channel:
 * show it to the visitor, do not log it or send it to analytics.
 */
export type PairingMaterial = {
  appLink: string;
  shortCode: string;
  expiresAt: string;
};

const allowedAppLinkProtocols = new Set(["https:", "http:", "feralfile:"]);

/**
 * Builds `${appLinkBaseUrl}?channel=<channelId>&token=<pairingToken>`. The link
 * carries no broker URL: the device joins on the broker it is configured for.
 */
export function buildAppLink(appLinkBaseUrl: string, channelId: string, pairingToken: string): string {
  let url: URL;
  try {
    url = new URL(appLinkBaseUrl);
  } catch {
    throw new Error("appLinkBaseUrl must be an absolute URL");
  }
  if (!allowedAppLinkProtocols.has(url.protocol)) {
    throw new Error("appLinkBaseUrl must use https:, http:, or feralfile:");
  }
  url.searchParams.set("channel", channelId);
  url.searchParams.set("token", pairingToken);
  return url.toString();
}

export function channelBindingFields(channelId: string): JsonValue {
  return { algorithm, channelId, v: 1 };
}
