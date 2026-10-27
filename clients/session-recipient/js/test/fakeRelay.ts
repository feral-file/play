import type { SocketFactory } from "../src/control/relay-client.js";

/** One peer on the stub relay channel; by default it ACKs and answers nothing. */
export type FakePeer = {
  id: string;
  /** Answers one assembled RPC `message`; the return value is the reply's `message`. Undefined stays silent. */
  respond?: (message: unknown, messageID: string) => unknown;
  /** Whether the relay reports this peer's ACK (default true). */
  acks?: boolean;
  /** The relay refuses every frame to this peer with this code. */
  refuse?: string;
};

export type FakeRelayOptions = {
  peers: FakePeer[];
  connectionId?: string;
  /** Close every socket before `hello` with this code. */
  failConnect?: number;
};

export type SentFrame = { to: string; payload: Record<string, unknown> };

type Assembly = { id: string; count: number; parts: string[] };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/**
 * A stub relay v2 channel for one FF1: it answers `hello` with the peers,
 * ACKs or refuses the client's frames per peer, reassembles chunked bodies,
 * and lets a peer answer with an RPC reply frame. Each socket the factory
 * opens is a fresh connection to the same channel.
 */
export function fakeRelay(options: FakeRelayOptions): { socketFactory: SocketFactory; sockets: FakeSocket[]; frames: SentFrame[] } {
  const sockets: FakeSocket[] = [];
  const frames: SentFrame[] = [];
  const socketFactory: SocketFactory = (url) => {
    const socket = new FakeSocket(url, options, frames);
    sockets.push(socket);
    return socket as unknown as WebSocket;
  };
  return { socketFactory, sockets, frames };
}

export class FakeSocket extends EventTarget {
  binaryType = "blob";
  readyState = 0;
  closed = false;
  readonly sent: (string | Uint8Array)[] = [];
  private readonly assemblies = new Map<string, Assembly>();
  private readonly connectionId: string;

  constructor(readonly url: string, private readonly options: FakeRelayOptions, private readonly frames: SentFrame[]) {
    super();
    this.connectionId = options.connectionId ?? "conn_browser";
    setTimeout(() => {
      if (this.closed) {
        return;
      }
      if (options.failConnect !== undefined) {
        this.closeWith(options.failConnect);
        return;
      }
      this.readyState = 1;
      this.deliverText({ type: "hello", connectionId: this.connectionId, peers: options.peers.map((peer) => peer.id) });
    }, 0);
  }

  send(data: string | Uint8Array): void {
    if (this.closed) {
      throw new Error("socket closed");
    }
    this.sent.push(data);
    if (typeof data === "string") {
      if (data === "ping") {
        this.deliver("pong");
      }
      return;
    }
    const size = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint16(0);
    const header = JSON.parse(decoder.decode(data.subarray(2, 2 + size))) as { id: string; to: string };
    const payload = JSON.parse(decoder.decode(data.subarray(2 + size))) as Record<string, unknown>;
    this.frames.push({ to: header.to, payload });
    const targets = header.to === "peers" ? this.options.peers : this.options.peers.filter((peer) => peer.id === header.to);
    if (targets.length === 0) {
      this.deliverText({ type: "error", to: header.to, code: header.to === "peers" ? "no_peers" : "peer_unavailable", id: header.id });
      return;
    }
    for (const peer of targets) {
      if (peer.refuse !== undefined) {
        this.deliverText({ type: "error", to: peer.id, code: peer.refuse, id: header.id });
        continue;
      }
      if (peer.acks !== false) {
        this.deliverText({ type: "ack", from: peer.id, id: header.id });
      }
      const body = this.assemble(peer.id, payload);
      if (body === undefined || peer.respond === undefined) {
        continue;
      }
      const messageID = body["messageID"];
      const answer = peer.respond(body["message"], String(messageID));
      if (answer !== undefined) {
        this.deliverFrame(peer.id, { type: "RPC", messageID, message: answer });
      }
    }
  }

  close(): void {
    this.closed = true;
    this.readyState = 3;
  }

  /** Simulates the relay dropping the connection. */
  closeWith(code: number): void {
    this.closed = true;
    this.readyState = 3;
    const event = new Event("close") as Event & { code: number };
    event.code = code;
    this.dispatchEvent(event);
  }

  /** Lets a test inject a relay control event, such as a late peer joining. */
  deliverText(event: Record<string, unknown>): void {
    this.deliver(JSON.stringify(event));
  }

  /** Delivers one application frame from `from` to this connection. */
  deliverFrame(from: string, body: Record<string, unknown>): void {
    const header = encoder.encode(JSON.stringify({ v: 2, id: crypto.randomUUID(), to: this.connectionId, from }));
    const payload = encoder.encode(JSON.stringify(body));
    const frame = new Uint8Array(2 + header.length + payload.length);
    new DataView(frame.buffer).setUint16(0, header.length);
    frame.set(header, 2);
    frame.set(payload, 2 + header.length);
    this.deliver(frame.buffer);
  }

  private deliver(data: string | ArrayBuffer): void {
    setTimeout(() => {
      if (!this.closed) {
        this.dispatchEvent(new MessageEvent("message", { data }));
      }
    }, 0);
  }

  private assemble(peer: string, payload: Record<string, unknown>): Record<string, unknown> | undefined {
    const chunk = payload["relayChunk"] as { id: string; index: number; count: number; data: string } | undefined;
    if (chunk === undefined) {
      return payload;
    }
    const assembly = chunk.index === 0 ? { id: chunk.id, count: chunk.count, parts: [] } : this.assemblies.get(peer);
    if (assembly?.id !== chunk.id) {
      throw new Error("fake relay: chunk out of sequence");
    }
    this.assemblies.set(peer, assembly);
    assembly.parts.push(chunk.data);
    if (assembly.parts.length < assembly.count) {
      return undefined;
    }
    this.assemblies.delete(peer);
    const bytes = Buffer.concat(assembly.parts.map((part) => Buffer.from(part, "base64")));
    return JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
  }
}
