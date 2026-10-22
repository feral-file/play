import { expect, it, vi } from "vitest";
import { displayDp1Playlist } from "../src/client.js";
it("blocks unimplemented secure browser flow before opening a socket", async () => {
	const socket = vi.fn();
	vi.stubGlobal("WebSocket", socket);
	try {
		await expect(displayDp1Playlist({ deviceId: "FF1-TEST", relayerBaseUrl: "https://relay.example", playlist: {} })).rejects.toMatchObject({code: "secure_integration_unavailable"});
		expect(socket).not.toHaveBeenCalled();
	} finally { vi.unstubAllGlobals(); }
});
