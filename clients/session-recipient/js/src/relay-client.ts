import { startPinging } from './liveness.js';

/** Maximum reconstructed command size, matching the FF1 command ingress. */
const MAX_MESSAGE = 4 * 1024 * 1024;
/** Total bytes held across all in-progress reassemblies, whatever their sender. */
const MAX_ASSEMBLY_BYTES = 8 * 1024 * 1024;
const CHUNK_SIZE = 32768;
/** Per-chunk receipt budget added to a request deadline: one WAN round trip. */
const CHUNK_BUDGET_MS = 1000;
/** Relay v2 selector that fans one frame out to every other live peer. */
const PEERS = 'peers';
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

/** record rejects non-object protocol envelopes before accessing their fields. */
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid relay envelope');
  return value as Record<string, unknown>;
}

/** base64 encodes in a loop; spreading a chunk into fromCharCode can exceed
 * the engine's argument limit. */
function base64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** RelayHeader is what a sender writes; the relay discards any `from` it sees. */
export type RelayHeader = { v: 2; id: string; to: string; from?: string };
/** ForwardedHeader is what a recipient reads: the relay always stamps `from`. */
export type ForwardedHeader = { v: 2; id: string; to: string; from: string };
/** PreparedRequest is one sealed envelope plus the check that pins its responder. */
export type PreparedRequest = {
  command: string;
  request: Record<string, unknown>;
  /** Required: resolves true only for a reply that verifies under the pinned
   * device profile (ff1-control-v1 §4.2). There is no accept-all default. */
  verify: (value: Record<string, unknown>) => Promise<boolean>;
};
type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };
type Deadline = Pending & { extend: (ms: number) => void };
type Assembly = {
  id: string;
  count: number;
  next: number;
  bytes: number;
  parts: Uint8Array[];
  expires: number;
};

/** relayURL selects the public device channel without credentials. */
export function relayURL(baseUrl: string, deviceId: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(deviceId)) throw new Error('Invalid device ID');
  const url = new URL(baseUrl);
  if (
    !['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !['', '/'].includes(url.pathname)
  )
    throw new Error('Invalid relayer endpoint');
  url.protocol = ['https:', 'wss:'].includes(url.protocol) ? 'wss:' : 'ws:';
  url.pathname = `/v2/channels/${deviceId}/connections`;
  return url.toString();
}

/** encodeRelayFrame leaves the application payload byte-for-byte intact. */
export function encodeRelayFrame(header: RelayHeader, payload: Uint8Array): Uint8Array {
  const encoded = encoder.encode(JSON.stringify(header));
  if (encoded.length > 1024 || encoded.length + payload.length + 2 > 65536)
    throw new Error('Relay frame too large');
  const frame = new Uint8Array(encoded.length + payload.length + 2);
  new DataView(frame.buffer).setUint16(0, encoded.length);
  frame.set(encoded, 2);
  frame.set(payload, encoded.length + 2);
  return frame;
}

/** decodeRelayFrame validates routing metadata before delivering application data. */
export function decodeRelayFrame(frame: ArrayBuffer): { header: ForwardedHeader; payload: Uint8Array } {
  if (frame.byteLength < 3 || frame.byteLength > 65536) throw new Error('Invalid relay frame');
  const size = new DataView(frame).getUint16(0);
  if (!size || size > 1024 || size + 2 > frame.byteLength) throw new Error('Invalid relay header');
  const header = record(JSON.parse(decoder.decode(new Uint8Array(frame, 2, size))));
  if (
    header['v'] !== 2 ||
    ![header['id'], header['to'], header['from']].every(
      (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value)
    )
  )
    throw new Error('Invalid relay routing');
  return { header: header as unknown as ForwardedHeader, payload: new Uint8Array(frame, size + 2) };
}

/** RelayClient carries sealed `ff1Envelope` commands over relay v2.
 *
 * EXPERIMENTAL: not used by the default Play API, which stays on mint pairing
 * and the legacy relayer until browser display grants are defined.
 *
 * Only an endpoint-verified reply can select a candidate. Receipt ACKs are
 * transport credit, never grant acceptance or command success.
 *
 * Pre-pin fan-out: until a reply verifies, the client does not know which
 * peer is FF1, so the first request goes out once as `to:"peers"` and the
 * relay copies it to every live peer on the public device channel. Peers that
 * join later get the same sealed bytes by unicast. Every peer, including
 * strangers squatting on the channel, therefore sees that ciphertext and its
 * size and timing. Integrity is unaffected (only FF1 can open or answer it),
 * but it is metadata exposure and up to 35x relay traffic for that request.
 * Once a reply verifies, later requests go only to the pinned peer.
 *
 * The client never subscribes to notifications: Play sessions do not receive
 * sealed notifications (ff1-control-v1 §9), so non-RPC frames are dropped.
 */
export class RelayClient {
  private nextFrameAt = 0;
  private pinger: ReturnType<typeof setInterval>;
  private frameWrites = Promise.resolve();
  private socket: WebSocket;
  private player: string | undefined;
  private peers = new Set<string>();
  private pending = new Map<string, Deadline>();
  private fanouts = new Set<string>();
  private validators = new Map<string, (value: Record<string, unknown>) => Promise<boolean>>();
  private assemblies = new Map<string, Assembly>();
  private closed = false;
  private sequence = Promise.resolve();
  private readiness!: Pending;
  private ready: Promise<void>;

  /** Create a controller connection; request() waits for a player to arrive. */
  constructor(
    baseUrl: string,
    deviceId: string,
    socketFactory = (url: string) => new WebSocket(url, 'ff-relay.v2')
  ) {
    this.ready = new Promise((resolve, reject) => {
      this.readiness = { resolve: () => { resolve(); }, reject };
    });
    // Connection errors may precede the first request; retain rejection without
    // producing an unhandled promise while the caller prepares its command.
    void this.ready.catch(() => undefined);
    this.socket = socketFactory(relayURL(baseUrl, deviceId));
    this.socket.binaryType = 'arraybuffer';
    this.socket.addEventListener('message', (event) => {
      try {
        this.receive(event.data);
      } catch (error) {
        this.close(error as Error);
      }
    });
    this.socket.addEventListener('error', () => { this.close(new Error('Relayer connection failed')); });
    this.socket.addEventListener('close', () => { this.close(new Error('Relayer disconnected')); });
    this.pinger = startPinging(this.socket);
  }

  /** requestPrepared seals only after connection and send-queue readiness.
   * The endpoint validator alone selects the responding device; unknown peers
   * may receive ciphertext but cannot settle a request with an unverified reply.
   *
   * timeoutMs bounds the wait for a verified reply. A chunked body extends it
   * by one second per chunk for every send, because each chunk waits for its
   * receipt before the next goes out.
   */
  async requestPrepared(
    prepare: () => Promise<PreparedRequest>,
    timeoutMs = 30000
  ): Promise<Record<string, unknown>> {
    const id = crypto.randomUUID();
    const key = `rpc:${id}`;
    // Bound queue/open waits before allocating a replay counter or sealing.
    const result = this.wait(key, timeoutMs);
    void result.catch(() => undefined);
    const work = this.sequence.then(async () => {
      await Promise.race([this.ready, result]);
      if (!this.pending.has(key)) {
        throw new Error('Relay request expired');
      }
      const prepared = await prepare();
      if (!this.pending.has(key)) {
        throw new Error('Relay request expired');
      }
      if (typeof prepared.verify !== 'function') throw new Error('V2 requires a reply verifier');
      if (prepared.command !== 'ff1Envelope') throw new Error('V2 requires a protected envelope');
      this.validators.set(id, prepared.verify);
      const body = encoder.encode(
        JSON.stringify({
          messageID: id,
          message: { command: prepared.command, request: prepared.request },
        })
      );
      const chunks = Math.ceil(body.length / CHUNK_SIZE);
      const active = () => this.pending.has(key);
      const deliver = async (to: string) => {
        if (chunks > 1) this.pending.get(key)?.extend(chunks * CHUNK_BUDGET_MS);
        try { await this.send(body, to, active); }
        catch { /* A failed candidate cannot prevent discovery of FF1. */ }
      };
      if (this.player) {
        await deliver(this.player);
        return;
      }
      // One fan-out reaches every peer the relay knows, including any beyond
      // this client's presence view. Later joiners get the SAME sealed
      // request so forwarded/replayed copies cannot execute twice.
      const sent = new Set(this.peers);
      await deliver(PEERS);
      while (active() && !this.closed && !this.player) {
        for (const peer of [...this.peers].filter((candidate) => !sent.has(candidate))) {
          sent.add(peer);
          await deliver(peer);
        }
        if (active()) await Promise.race([new Promise((resolve) => setTimeout(resolve, 100)), result.then(() => undefined, () => undefined)]);
      }
    });
    this.sequence = work.catch(() => undefined);
    void work.catch((error: unknown) => { this.settle(key, undefined, error as Error); });
    try {
      return await result as Record<string, unknown>;
    } finally {
      this.validators.delete(id);
    }
  }

  /** close releases the socket and all pending calls, including readiness. */
  close(error = new Error('Relay client closed')): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.pinger);
    this.readiness.reject(error);
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.fanouts.clear();
    this.assemblies.clear();
    this.validators.clear();
    this.socket.close();
  }

  /** wait owns one bounded transport or RPC deadline. */
  private wait(key: string, timeoutMs: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const expire = () => {
        this.pending.delete(key);
        reject(new Error('Relay response timeout'));
      };
      let deadline = Date.now() + timeoutMs;
      let timer = setTimeout(expire, timeoutMs);
      this.pending.set(key, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
        extend: (ms) => {
          clearTimeout(timer);
          deadline += ms;
          timer = setTimeout(expire, Math.max(0, deadline - Date.now()));
        },
      });
    });
  }

  /** settle consumes exactly one matching response or failure. */
  private settle(key: string, value?: unknown, error?: Error): void {
    const pending = this.pending.get(key);
    if (!pending) return;
    this.pending.delete(key);
    if (error) pending.reject(error);
    else pending.resolve(value);
  }

  /** send serializes chunks and waits for each receipt to respect relay credit.
   * A fan-out chunk proceeds on the first recipient's receipt, so peers that
   * lag or refuse it do not hold up FF1.
   */
  private async send(body: Uint8Array, to: string, active: () => boolean): Promise<void> {
    if (body.length > MAX_MESSAGE) throw new Error('Relay message too large');
    const transfer = crypto.randomUUID();
    const count = Math.ceil(body.length / CHUNK_SIZE);
    for (let index = 0; index < count; index++) {
      if (!active()) throw new Error('Relay request expired');
      let part: Uint8Array = body.slice(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE);
      if (count > 1)
        part = encoder.encode(
          JSON.stringify({
            relayChunk: { id: transfer, index, count, data: base64(part) },
          })
        );
      const id = crypto.randomUUID();
      const frame = encodeRelayFrame({ v: 2, id, to }, part);
      const write = this.frameWrites.then(async () => {
        const delay = this.nextFrameAt - Date.now();
        if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
        if (!active() || this.closed) throw new Error('Relay request expired');
        this.nextFrameAt = Date.now() + Math.max(20, Math.ceil(frame.byteLength * 1000 / 750000));
        const receipt = this.wait(`ack:${to}:${id}`, 5000);
        void receipt.catch(() => undefined);
        if (to === PEERS) this.fanouts.add(id);
        try { this.socket.send(frame); }
        catch (error) { this.settle(`ack:${to}:${id}`, undefined, error as Error); }
        return { receipt };
      });
      this.frameWrites = write.then(() => undefined, () => undefined);
      const { receipt } = await write;
      try {
        await receipt;
      } finally {
        this.fanouts.delete(id);
      }
    }
  }

  /** receive distinguishes relay controls from the existing application envelope. */
  private receive(data: unknown): void {
    if (data === 'pong') {
      return; // the relay's answer to our liveness ping
    }
    if (typeof data === 'string') {
      this.control(JSON.parse(data));
      return;
    }
    if (!(data instanceof ArrayBuffer)) {
      throw new Error('Invalid relay data');
    }
    const { header, payload } = decodeRelayFrame(data);
    const from = header.from;
    this.socket.send(JSON.stringify({ type: 'ack', from, id: header.id }));
    if (!this.peers.has(from) || (this.player && from !== this.player)) {
      return;
    }
    let body: Uint8Array | undefined;
    try {
      body = this.assemble(from, payload);
    } catch {
      return;
    }
    if (!body) {
      return;
    }
    let message: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(decoder.decode(body));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
      message = parsed as Record<string, unknown>;
    } catch { return; }
    const messageId = message['messageID'];
    // Only RPC replies are consumed. Play never subscribes to notifications
    // (§9), so anything else is dropped rather than surfaced.
    if (message['type'] !== 'RPC' || typeof messageId !== 'string') return;
    const verify = this.validators.get(messageId);
    if (!verify) return;
    void verify(message)
      .then((accepted) => {
        if (
          accepted &&
          this.peers.has(from) &&
          (!this.player || this.player === from) &&
          this.pending.has(`rpc:${messageId}`)
        ) {
          this.player = from;
          // Other peers' frames are dropped from now on; free their buffers.
          for (const peer of this.assemblies.keys()) if (peer !== from) this.assemblies.delete(peer);
          this.settle(`rpc:${messageId}`, message);
        }
      })
      .catch(() => undefined);
  }

  /** control keeps connection presence separate from command completion. */
  private control(raw: unknown): void {
    const event = record(raw);
    if (event['type'] === 'hello' && Array.isArray(event['peers'])) for (const peer of event['peers'].slice(0, 35)) { if (typeof peer === 'string') this.peers.add(peer); }
    if (this.peers.size < 35 && event['type'] === 'peer_connected' && typeof event['connectionId'] === 'string') this.peers.add(event['connectionId']);
    if (event['type'] === 'peer_disconnected' && typeof event['connectionId'] === 'string') {
      this.peers.delete(event['connectionId']);
      this.assemblies.delete(event['connectionId']);
      if (event['connectionId'] === this.player) {
        this.close(new Error('Player disconnected'));
        return;
      }
    }
    if (!this.player && this.peers.size) {
      this.readiness.resolve(undefined);
    }
    const id = event['id'];
    if (typeof id !== 'string') return;
    // Fan-out recipients ACK independently and the first releases the chunk.
    // A single recipient's refusal is ignored; only an empty fan-out, reported
    // with to:"peers", fails it.
    const fanout = this.fanouts.has(id);
    if (event['type'] === 'ack' && typeof event['from'] === 'string')
      this.settle(fanout ? `ack:${PEERS}:${id}` : `ack:${event['from']}:${id}`);
    if (event['type'] === 'error' && typeof event['to'] === 'string' && typeof event['code'] === 'string' && (!fanout || event['to'] === PEERS))
      this.settle(`ack:${event['to']}:${id}`, undefined, new Error(`Relay: ${event['code']}`));
  }

  /** assemble enforces one ordered transfer per peer, each at most 4 MiB, and
   * at most 8 MiB held across all peers. Before a peer is pinned any channel
   * member can start a transfer, so expired buffers are swept on every chunk.
   * A single-frame payload (the usual sealed reply) bypasses reassembly.
   */
  private assemble(from: string, payload: Uint8Array): Uint8Array | undefined {
    const value = record(JSON.parse(decoder.decode(payload)))['relayChunk'];
    if (value === undefined) return payload;
    const chunk = record(value);
    if (
      typeof chunk['id'] !== 'string' ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(chunk['id']) ||
      typeof chunk['count'] !== 'number' || !Number.isInteger(chunk['count']) ||
      chunk['count'] < 2 ||
      chunk['count'] > 128 ||
      typeof chunk['index'] !== 'number' || !Number.isInteger(chunk['index']) ||
      chunk['index'] < 0 ||
      chunk['index'] >= chunk['count'] ||
      typeof chunk['data'] !== 'string' ||
      chunk['data'].length > 43692
    )
      throw new Error('Invalid relay chunk');
    const bytes = Uint8Array.from(atob(chunk['data']), (char) => char.charCodeAt(0));
    if (!bytes.length || bytes.length > CHUNK_SIZE) throw new Error('Invalid chunk size');
    const now = Date.now();
    for (const [peer, held] of this.assemblies) if (now >= held.expires) this.assemblies.delete(peer);
    if (chunk['index'] === 0)
      this.assemblies.set(from, {
        id: chunk['id'],
        count: chunk['count'],
        next: 0,
        bytes: 0,
        parts: [],
        expires: now + 180000,
      });
    let total = 0;
    for (const held of this.assemblies.values()) total += held.bytes;
    const assembly = this.assemblies.get(from);
    if (
      assembly?.id !== chunk['id'] ||
      assembly.count !== chunk['count'] ||
      assembly.next !== chunk['index'] ||
      assembly.bytes + bytes.length > MAX_MESSAGE ||
      total + bytes.length > MAX_ASSEMBLY_BYTES
    ) {
      this.assemblies.delete(from);
      throw new Error('Invalid chunk sequence');
    }
    assembly.parts.push(bytes);
    assembly.bytes += bytes.length;
    assembly.next++;
    if (assembly.next !== assembly.count) return undefined;
    const result = new Uint8Array(assembly.bytes);
    let offset = 0;
    for (const part of assembly.parts) {
      result.set(part, offset);
      offset += part.length;
    }
    this.assemblies.delete(from);
    return result;
  }
}
