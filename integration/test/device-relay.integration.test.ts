import { createServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { afterEach, expect, it } from "vitest";
import { displayDp1Playlist } from "@feralfile/play";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

it("routes browser playback by device ID and waits for the unchanged device reply", async () => {
  const server = createServer();
  const sockets = new WebSocketServer({ server, handleProtocols: () => "ff-relay.v2" });
  const previous = globalThis.WebSocket;
  globalThis.WebSocket = WebSocket as unknown as typeof globalThis.WebSocket;
  cleanup.push(async () => {
    globalThis.WebSocket = previous;
    for (const client of sockets.clients) client.terminate();
    await new Promise<void>((resolve) => { sockets.close(() => { resolve(); }); });
    await new Promise<void>((resolve) => server.close(() => { resolve(); }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing address");
  const requests: string[] = [];
  let command: Record<string, unknown> | undefined;
  sockets.on("connection", (socket, request) => {
    requests.push(request.url ?? "");
    expect(request.headers.authorization).toBeUndefined();
    socket.send(JSON.stringify({ type: "hello", connectionId: "controller", peers: ["player"] }));
    socket.on("message", (raw, binary) => {
      if (!binary) return;
      const frame = Buffer.from(raw as Buffer);
      const length = frame.readUInt16BE();
      const header = JSON.parse(frame.subarray(2, 2 + length).toString()) as Record<string, unknown>;
      command = JSON.parse(frame.subarray(2 + length).toString()) as Record<string, unknown>;
      expect(header['to']).toBe("player");
      socket.send(JSON.stringify({ type: "ack", from: "player", id: header['id'] }));
      const replyHeader = Buffer.from(JSON.stringify({ v: 2, id: "reply", from: "player", to: "controller" }));
      const prefix = Buffer.alloc(2);
      prefix.writeUInt16BE(replyHeader.length);
      socket.send(Buffer.concat([prefix, replyHeader, Buffer.from(JSON.stringify({
        type: "RPC", messageID: command['messageID'], message: { ok: true }
      }))]));
    });
  });
  const playlist = { dpVersion: "1.0.0", title: "Integration", items: [{ source: "https://example.com/art.html", duration: 30 }] };
  await displayDp1Playlist({ deviceId: "FF1-TEST", relayerBaseUrl: `http://127.0.0.1:${String(address.port)}`, playlist });
  expect(requests).toEqual(["/v2/players/FF1-TEST/connections?role=controller"]);
  expect(command?.['message']).toEqual({ command: "displayPlaylist", request: { intent: { action: "now_display" }, dp1_call: playlist } });
});
