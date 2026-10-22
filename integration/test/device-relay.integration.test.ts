import { createServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { afterEach, expect, it } from "vitest";
import { RelayClient } from "@feralfile/play/experimental";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

/** frame builds a forwarded relay v2 frame from a peer. */
function frame(from: string, payload: unknown): Buffer {
  const header = Buffer.from(JSON.stringify({ v: 2, id: `reply-${from}`, from, to: "controller" }));
  const prefix = Buffer.alloc(2);
  prefix.writeUInt16BE(header.length);
  return Buffer.concat([prefix, header, Buffer.from(JSON.stringify(payload))]);
}

/** Deterministic stand-in for the pinned devSig check (ff1-control-v1 §4.2):
 * only the reply FF1 would seal verifies. The real check lives with the
 * shared endpoint fixtures, which this transport test does not fake. */
function verify(value: Record<string, unknown>): Promise<boolean> {
  return Promise.resolve((value["message"] as { jwe?: unknown } | undefined)?.jwe === "sealed-by-ff1");
}

/** startRelay plays a relay channel holding a forger and, optionally, FF1. The
 * forger answers every fan-out first with a reply that must not verify. */
async function startRelay(withPlayer: boolean) {
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
  const seen = { requests: [] as string[], targets: [] as unknown[], command: undefined as Record<string, unknown> | undefined };
  const peers = withPlayer ? ["forger", "player"] : ["forger"];
  sockets.on("connection", (socket, request) => {
    seen.requests.push(request.url ?? "");
    expect(request.headers.authorization).toBeUndefined();
    socket.send(JSON.stringify({ type: "hello", connectionId: "controller", peers }));
    socket.on("message", (raw, binary) => {
      if (!binary) return;
      const data = Buffer.from(raw as Buffer);
      const length = data.readUInt16BE();
      const header = JSON.parse(data.subarray(2, 2 + length).toString()) as Record<string, unknown>;
      const command = JSON.parse(data.subarray(2 + length).toString()) as Record<string, unknown>;
      seen.targets.push(header["to"]);
      seen.command = command;
      for (const peer of peers) socket.send(JSON.stringify({ type: "ack", from: peer, id: header["id"] }));
      socket.send(frame("forger", { type: "RPC", messageID: command["messageID"], message: { v: 1, jwe: "forged" } }));
      if (withPlayer)
        socket.send(frame("player", { type: "RPC", messageID: command["messageID"], message: { v: 1, jwe: "sealed-by-ff1" } }));
    });
  });
  return { baseUrl: `http://127.0.0.1:${String(address.port)}`, seen };
}

const envelope = { command: "ff1Envelope", request: { v: 1, jwe: "synthetic-endpoint-bytes" }, verify };

it("fans the first envelope out to peers and settles only on the verified reply", async () => {
  const { baseUrl, seen } = await startRelay(true);
  const client = new RelayClient(baseUrl, "FF1-TEST");
  let reply: Record<string, unknown>;
  try {
    reply = await client.requestPrepared(() => Promise.resolve(envelope));
  } finally { client.close(); }
  expect(reply["message"]).toEqual({ v: 1, jwe: "sealed-by-ff1" });
  expect(seen.requests).toEqual(["/v2/channels/FF1-TEST/connections"]);
  expect(seen.targets).toEqual(["peers"]);
  expect(seen.command?.["message"]).toEqual({ command: "ff1Envelope", request: { v: 1, jwe: "synthetic-endpoint-bytes" } });
});

it("rejects when only a forged reply arrives", async () => {
  const { baseUrl } = await startRelay(false);
  const client = new RelayClient(baseUrl, "FF1-TEST");
  try {
    await expect(client.requestPrepared(() => Promise.resolve(envelope), 500)).rejects.toThrow(/timeout/);
  } finally { client.close(); }
});
