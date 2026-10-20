import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RelayClient } from "../src/relay-client.js";
import { displayDp1Playlist } from "../src/client.js";
afterEach(() => vi.restoreAllMocks());
describe("displayDp1Playlist", () => {
  const request = vi.fn();
  const close = vi.fn();
  beforeEach(() => {
    vi.stubGlobal("WebSocket", class extends EventTarget {
      binaryType = "";
      close() { /* Test transport never opens a network socket. */ }
      send() { /* Requests are intercepted at the adapter boundary. */ }
    });
    vi.spyOn(RelayClient.prototype, "request").mockImplementation(request);
    vi.spyOn(RelayClient.prototype, "close").mockImplementation(close);
    request.mockReset();
    close.mockReset();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("preserves the command payload and uses no browser session", async () => {
    request.mockResolvedValue({ message: { message: { ok: true } } });
    const playlist = { dpVersion: "1.1.0", title: "Browser Playlist", items: [] };
    await displayDp1Playlist({ deviceId: "FF1-TEST", relayerBaseUrl: "https://relay.example", playlist });
    expect(request).toHaveBeenCalledWith("displayPlaylist", { intent: { action: "now_display" }, dp1_call: playlist });
    expect(close).toHaveBeenCalledOnce();
  });

  it("requires positive execution confirmation and closes on rejection", async () => {
    request.mockResolvedValue({ message: { ok: false } });
    await expect(displayDp1Playlist({ deviceId: "FF1-TEST", relayerBaseUrl: "https://relay.example", playlist: {} })).rejects.toThrow("FF1 rejected");
    expect(close).toHaveBeenCalledOnce();
  });

  it("does not retry an ambiguous command failure", async () => {
    request.mockRejectedValue(new Error("disconnected"));
    await expect(displayDp1Playlist({ deviceId: "FF1-TEST", relayerBaseUrl: "https://relay.example", playlist: {} })).rejects.toThrow("disconnected");
    expect(request).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it("requires endpoint and device ID", async () => {
    await expect(displayDp1Playlist({ playlist: {}, deviceId: "FF1-TEST", relayerBaseUrl: "" })).rejects.toThrow("relayer base URL");
    await expect(displayDp1Playlist({ playlist: {}, deviceId: "", relayerBaseUrl: "https://relay.example" })).rejects.toThrow("device ID");
  });
});
