import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  RelayClient,
  relayURL,
  encodeRelayFrame,
  decodeRelayFrame,
} from '../src/relay-client.js';

class Socket extends EventTarget {
  binaryType = '';
  sent: unknown[] = [];
  closed = false;
  send(data: unknown) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
  }
  message(data: unknown) {
    this.dispatchEvent(new MessageEvent('message', { data }));
  }
}

test('routes by device ID and rejects credential-bearing endpoints', () => {
  assert.equal(
    relayURL('https://relay.example', 'FF1-TEST'),
    'wss://relay.example/v2/players/FF1-TEST/connections?role=controller'
  );
  for (const endpoint of [
    'https://secret@relay.example',
    'https://relay.example?topicID=x',
    'https://relay.example/api/connection',
  ]) {
    assert.throws(() => relayURL(endpoint, 'FF1-TEST'));
  }
});

test('RPC waits for device response, not the transport ACK', async () => {
  const socket = new Socket();
  const client = new RelayClient(
    'https://relay.example',
    'FF1-TEST',
    () => socket as unknown as WebSocket
  );
  socket.message(JSON.stringify({ type: 'hello', peers: ['player-1'] }));
  let finished = false;
  const result = client.request('getDeviceStatus', {}).then((value) => {
    finished = true;
    return value;
  });
  await new Promise((resolve) => setImmediate(resolve));
  const frame = socket.sent[0] as Uint8Array;
  const headerSize = new DataView(frame.buffer).getUint16(0);
  const header = JSON.parse(new TextDecoder().decode(frame.slice(2, 2 + headerSize))) as {id:string};
  const command = JSON.parse(new TextDecoder().decode(frame.slice(2 + headerSize))) as { messageID:string; message:{command:string} };
  assert.equal(command.message.command, 'getDeviceStatus');
  socket.message(JSON.stringify({ type: 'ack', from: 'player-1', id: header.id }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(finished, false);
  const response = { type: 'RPC', messageID: command.messageID, message: { ok: true } };
  const reply = encodeRelayFrame(
    { v: 2, id: 'reply-1', to: 'controller-1', from: 'player-1' },
    new TextEncoder().encode(JSON.stringify(response))
  );
  socket.message(reply.buffer);
  assert.deepEqual(await result, response);
  assert.equal((JSON.parse(socket.sent.at(-1) as string) as {type:string}).type, 'ack');
  client.close();
});

test('disconnect rejects pending commands and malformed frames are bounded', async () => {
  const socket = new Socket();
  const client = new RelayClient(
    'https://relay.example',
    'FF1-TEST',
    () => socket as unknown as WebSocket
  );
  const pending = client.request('getDeviceStatus', {});
  client.close();
  await assert.rejects(pending, /closed/);
  assert.throws(() => decodeRelayFrame(new ArrayBuffer(65537)));
  assert.throws(() => decodeRelayFrame(new Uint8Array([0, 255, 0]).buffer));
});

test('expired queued commands are never sent after transport credit is released', async () => {
  const socket = new Socket();
  const client = new RelayClient(
    'https://relay.example',
    'FF1-TEST',
    () => socket as unknown as WebSocket
  );
  socket.message(JSON.stringify({ type: 'hello', peers: ['player-1'] }));
  const first = client.request('first', {}, 1000);
  const firstRejected = assert.rejects(first);
  await new Promise((resolve) => setImmediate(resolve));
  const second = client.request('expired', {}, 10);
  await assert.rejects(second, /timed out|timeout/i);
  const frame = socket.sent[0] as Uint8Array;
  const size = new DataView(frame.buffer, frame.byteOffset).getUint16(0);
  const header = JSON.parse(new TextDecoder().decode(frame.slice(2, 2 + size))) as {id:string};
  socket.message(JSON.stringify({ type: 'ack', from: 'player-1', id: header.id }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(socket.sent.filter((item) => item instanceof Uint8Array).length, 1);
  client.close();
  await firstRejected;
});

test('large transfers stay below the Worker byte ceiling with immediate ACKs', async () => {
  const socket = new Socket();
  const writes: { at: number; bytes: number }[] = [];
  const parts: Buffer[] = [];
  const originalSend = socket.send.bind(socket);
  socket.send = (data: unknown) => {
    originalSend(data);
    if (!(data instanceof Uint8Array)) {
      return;
    }
    writes.push({ at: Date.now(), bytes: data.byteLength });
    const size = new DataView(data.buffer, data.byteOffset).getUint16(0);
    const header = JSON.parse(new TextDecoder().decode(data.slice(2, 2 + size))) as {id:string};
    const chunk = (JSON.parse(new TextDecoder().decode(data.slice(2 + size))) as {relayChunk:{data:string;count:number}}).relayChunk;
    parts.push(Buffer.from(chunk.data, 'base64'));
    queueMicrotask(() => {
      socket.message(JSON.stringify({ type: 'ack', from: 'player-1', id: header.id }));
      if (parts.length === chunk.count) {
        const command = JSON.parse(Buffer.concat(parts).toString()) as {messageID:string};
        const response = encodeRelayFrame(
          { v: 2, id: 'response', to: 'controller', from: 'player-1' },
          new TextEncoder().encode(
            JSON.stringify({ type: 'RPC', messageID: command.messageID, message: { ok: true } })
          )
        );
        socket.message(response.buffer);
      }
    });
  };
  const client = new RelayClient(
    'https://relay.example',
    'FF1-TEST',
    () => socket as unknown as WebSocket
  );
  socket.message(JSON.stringify({ type: 'hello', peers: ['player-1'] }));
  try {
    await client.request('displayPlaylist', { data: 'x'.repeat(2 * 1024 * 1024) });
    for (const start of writes) {
      const bytes = writes
        .filter((write) => write.at >= start.at && write.at < start.at + 1000)
        .reduce((sum, write) => sum + write.bytes, 0);
      assert.ok(bytes < 1048576, `one-second window exceeded limit: ${String(bytes)}`);
    }
  } finally {
    client.close();
  }
});
