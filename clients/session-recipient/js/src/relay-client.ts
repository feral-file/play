/** Maximum reconstructed command size, matching the FF1 command ingress. */
const MAX_MESSAGE = 4 * 1024 * 1024;
const CHUNK_SIZE = 32768;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

/** record rejects non-object protocol envelopes before accessing their fields. */
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid relay envelope');
  return value as Record<string, unknown>;
}

type Header = { v: 2; id: string; to: string; from?: string };
type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };
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
  url.pathname = `/v2/players/${deviceId}/connections`;
  url.search = 'role=controller';
  return url.toString();
}

/** encodeRelayFrame leaves the application payload byte-for-byte intact. */
export function encodeRelayFrame(header: Header, payload: Uint8Array): Uint8Array {
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
export function decodeRelayFrame(frame: ArrayBuffer): { header: Header; payload: Uint8Array } {
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
  return { header: header as unknown as Header, payload: new Uint8Array(frame, size + 2) };
}

/** RelayClient carries existing JSON commands and notifications over relay v2.
 * A selected player is a routing hint only. This development flow intentionally
 * provides no device authentication; receipt ACKs never imply command success.
 */
export class RelayClient {
  private nextFrameAt = 0;
  private socket: WebSocket;
  private player: string | undefined;
  private peers = new Set<string>();
  private pending = new Map<string, Pending>();
  private assemblies = new Map<string, Assembly>();
  private closed = false;
  private sequence = Promise.resolve();
  private readiness!: Pending;
  private ready: Promise<void>;
  onNotification?: (message: Record<string, unknown>) => void;

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
  }

  /** request resolves only on the correlated device RPC response. */
  async request(
    command: string,
    request: Record<string, unknown>,
    timeoutMs = 30000
  ): Promise<Record<string, unknown>> {
    const id = crypto.randomUUID();
    const result = this.wait(`rpc:${id}`, timeoutMs);
    void result.catch(() => undefined);
    const work = this.sequence.then(async () => {
      await Promise.race([this.ready, result]);
      if (!this.pending.has(`rpc:${id}`)) throw new Error('Relay request expired');
      if (this.closed || !this.player) throw new Error('Player unavailable');
      const body = encoder.encode(JSON.stringify({ messageID: id, message: { command, request } }));
      await this.send(body, this.player, () => this.pending.has(`rpc:${id}`));
    });
    this.sequence = work.catch(() => undefined);
    void work.catch((error: unknown) => { this.settle(`rpc:${id}`, undefined, error as Error); });
    return result as Promise<Record<string, unknown>>;
  }

  /** close releases the socket and all pending calls, including readiness. */
  close(error = new Error('Relay client closed')): void {
    if (this.closed) return;
    this.closed = true;
    this.readiness.reject(error);
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.assemblies.clear();
    this.socket.close();
  }

  /** wait owns one bounded transport or RPC deadline. */
  private wait(key: string, timeoutMs: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key);
        reject(new Error('Relay response timeout'));
      }, timeoutMs);
      this.pending.set(key, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
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

  /** send serializes chunks and waits for each receipt to respect relay credit. */
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
            relayChunk: { id: transfer, index, count, data: btoa(String.fromCharCode(...part)) },
          })
        );
      const delay = this.nextFrameAt - Date.now();
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      if (!active()) throw new Error('Relay request expired');
      const id = crypto.randomUUID();
      const frame = encodeRelayFrame({ v: 2, id, to }, part);
      // Leave headroom below the Worker's 1 MiB/s and 128 message/s caps.
      this.nextFrameAt = Date.now() + Math.max(20, Math.ceil(frame.byteLength * 1000 / 750000));
      const receipt = this.wait(`ack:${to}:${id}`, 5000);
      try {
        this.socket.send(frame);
      } catch (error) {
        this.settle(`ack:${to}:${id}`, undefined, error as Error);
      }
      await receipt;
    }
  }

  /** receive distinguishes relay controls from the existing application envelope. */
  private receive(data: unknown): void {
    if (typeof data === 'string') {
      this.control(JSON.parse(data));
      return;
    }
    if (!(data instanceof ArrayBuffer)) throw new Error('Invalid relay data');
    const { header, payload } = decodeRelayFrame(data);
    if (!header.from || header.from !== this.player) return;
    const body = this.assemble(header.from, payload);
    this.socket.send(JSON.stringify({ type: 'ack', from: header.from, id: header.id }));
    if (!body) return;
    const message = record(JSON.parse(decoder.decode(body)));
    if (message['type'] === 'RPC' && typeof message['messageID'] === 'string')
      this.settle(`rpc:${message['messageID']}`, message);
    else this.onNotification?.(message);
  }

  /** control keeps connection presence separate from command completion. */
  private control(raw: unknown): void {
    const event = record(raw);
    if (event['type'] === 'hello' && Array.isArray(event['peers'])) for (const peer of event['peers']) { if (typeof peer === 'string') this.peers.add(peer); }
    if (event['type'] === 'peer_connected' && typeof event['connectionId'] === 'string') this.peers.add(event['connectionId']);
    if (event['type'] === 'peer_disconnected' && typeof event['connectionId'] === 'string') {
      this.peers.delete(event['connectionId']);
      this.assemblies.delete(event['connectionId']);
      if (event['connectionId'] === this.player) {
        this.close(new Error('Player disconnected'));
        return;
      }
    }
    if (!this.player && this.peers.size) {
      this.player = this.peers.values().next().value;
      this.readiness.resolve(undefined);
    }
    if (event['type'] === 'ack' && typeof event['from'] === 'string' && typeof event['id'] === 'string') this.settle(`ack:${event['from']}:${event['id']}`);
    if (event['type'] === 'error' && typeof event['to'] === 'string' && typeof event['id'] === 'string' && typeof event['code'] === 'string')
      this.settle(`ack:${event['to']}:${event['id']}`, undefined, new Error(`Relay: ${event['code']}`));
  }

  /** assemble enforces one ordered 4 MiB transfer per selected player. */
  private assemble(from: string, payload: Uint8Array): Uint8Array | undefined {
    const value = record(JSON.parse(decoder.decode(payload)))["relayChunk"];
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
    if (chunk['index'] === 0)
      this.assemblies.set(from, {
        id: chunk['id'],
        count: chunk['count'],
        next: 0,
        bytes: 0,
        parts: [],
        expires: Date.now() + 30000,
      });
    const assembly = this.assemblies.get(from);
    if (
      assembly?.id !== chunk['id'] ||
      assembly.count !== chunk['count'] ||
      assembly.next !== chunk['index'] ||
      Date.now() >= assembly.expires ||
      assembly.bytes + bytes.length > MAX_MESSAGE
    )
      throw new Error('Invalid chunk sequence');
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
