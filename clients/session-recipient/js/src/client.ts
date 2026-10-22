import { PlayError } from "./errors.js";

export type Dp1Playlist = Record<string, unknown>;
export type DisplayDp1PlaylistOptions = {
  deviceId: string;
  playlist: Dp1Playlist;
  relayerBaseUrl: string;
};

/** Protected browser casting awaits the shared registration/result validators
 * and browser grant contract. Never substitute plaintext or an owner grant.
 * The generic RelayClient and TemporaryChannel adapters are independently usable
 * by reviewed endpoint workflows, but are not enrollment implementations.
 */
export function displayDp1Playlist(_options: DisplayDp1PlaylistOptions): Promise<void> {
	void _options;
	return Promise.reject(new PlayError(
		"Protected browser pairing and casting await the shared endpoint integration",
		"secure_integration_unavailable",
	));
}
