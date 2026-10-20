import { RelayClient } from "./relay-client.js";
import { PlayError } from "./errors.js";

export type Dp1Playlist = Record<string, unknown>;
export type DisplayDp1PlaylistOptions = {
  deviceId: string;
  playlist: Dp1Playlist;
  relayerBaseUrl: string;
};

function executionSucceeded(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const result = value as Record<string, unknown>;
  return typeof result["ok"] === "boolean" ? result["ok"] : executionSucceeded(result["message"]);
}

/** Display an unchanged DP-1 command through the device-ID binary transport.
 * Device IDs select a destination; this release does not authenticate peers.
 * The returned promise requires the FF1 execution response, not a receipt ACK.
 */
export async function displayDp1Playlist(options: DisplayDp1PlaylistOptions): Promise<void> {
  if (!options.relayerBaseUrl.trim()) throw new Error("relayer base URL is required");
  if (!options.deviceId.trim()) throw new Error("device ID is required");
  const client = new RelayClient(options.relayerBaseUrl, options.deviceId);
  try {
    const result = await client.request("displayPlaylist", {
      intent: { action: "now_display" }, dp1_call: options.playlist
    });
    if (!executionSucceeded(result)) throw new PlayError("FF1 rejected display request", "display_rejected");
  } finally {
    client.close();
  }
}
