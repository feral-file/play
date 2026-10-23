import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import {
  RelayClient,
  relayURL,
  encodeRelayFrame,
  decodeRelayFrame,
  type PreparedRequest,
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
    'wss://relay.example/v2/channels/FF1-TEST/connections'
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
  const result = request(client, 'getDeviceStatus', {}).then((value) => {
    finished = true;
    return value;
  });
  await new Promise((resolve) => setImmediate(resolve));
  const frame = socket.sent[0] as Uint8Array;
  const headerSize = new DataView(frame.buffer).getUint16(0);
  const header = JSON.parse(new TextDecoder().decode(frame.slice(2, 2 + headerSize))) as {id:string};
  const command = JSON.parse(new TextDecoder().decode(frame.slice(2 + headerSize))) as { messageID:string; message:{command:string} };
  assert.equal(command.message.command, 'ff1Envelope');
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
  const pending = request(client, 'getDeviceStatus', {});
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
  const first = request(client, 'first', {}, 1000);
  const firstRejected = assert.rejects(first);
  await new Promise((resolve) => setImmediate(resolve));
  const second = request(client, 'expired', {}, 10);
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
    await request(client, 'displayPlaylist', { data: 'x'.repeat(2 * 1024 * 1024) });
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

// Synthetic endpoint seam tests transport only, not cryptography or enrollment.
function request(client: RelayClient, _command: string, body: Record<string, unknown>, timeout = 30000) {
	return client.requestPrepared(() => Promise.resolve({command: 'ff1Envelope', request: body, verify: () => Promise.resolve(true)}), timeout);
}


test('malformed reconstructed candidate payload is ACKed without closing a valid peer', () => {
  const socket = new Socket();
  const client = new RelayClient('https://relay.test', 'FF1-TEST', () => socket as unknown as WebSocket);
  socket.message(JSON.stringify({type:'hello', peers:['attacker', 'ff1']}));
  for (let index = 0; index < 2; index++) {
    const payload = new TextEncoder().encode(JSON.stringify({relayChunk:{id:'bad-transfer',index,count:2,data:btoa('x')}}));
    const frame = encodeRelayFrame({v:2,id:`bad-${String(index)}`,to:'cli',from:'attacker'},payload);
    socket.message(frame.buffer);
  }
  assert.equal(socket.closed, false);
  assert.equal(socket.sent.length, 2);
  client.close();
});


test('discovers FF1 joining after another controller without resealing or resending', async () => {
  const socket = new Socket();
  socket.send = (data: unknown) => {
    socket.sent.push(data);
    if (!(data instanceof Uint8Array)) return;
    const length = new DataView(data.buffer, data.byteOffset).getUint16(0);
    const header = JSON.parse(new TextDecoder().decode(data.slice(2, 2+length))) as {to:string;id:string};
    const body = JSON.parse(new TextDecoder().decode(data.slice(2+length))) as {messageID:string};
    queueMicrotask(() => {
      // A fan-out is ACKed by each recipient under its own connection ID.
      for (const peer of header.to === 'peers' ? ['other-controller'] : [header.to]) socket.message(JSON.stringify({type:'ack',from:peer,id:header.id}));
      if (header.to === 'ff1') {
        const frame = encodeRelayFrame({v:2,id:'verified',to:'cli',from:'ff1'},new TextEncoder().encode(JSON.stringify({type:'RPC',messageID:body.messageID})));
        socket.message(frame.buffer);
      }
    });
  };
  const client = new RelayClient('https://relay.test','FF1-TEST',() => socket as unknown as WebSocket);
  socket.message(JSON.stringify({type:'hello',peers:['other-controller']}));
  let seals = 0;
  const result = client.requestPrepared(() => {
    seals++;
    return Promise.resolve({command:'ff1Envelope',request:{jwe:'opaque'},verify: () => Promise.resolve(true)});
  }, 2000);
  await new Promise((resolve) => setTimeout(resolve, 30));
  socket.message(JSON.stringify({type:'peer_connected',connectionId:'ff1'}));
  await result;
  assert.equal(seals, 1);
  assert.equal(socket.sent.filter((data) => data instanceof Uint8Array).length, 2);
  client.close();
});

type Sent = { header: { to: string; id: string }; body: { messageID: string } };
function sentFrames(socket: Socket): Sent[] {
  return socket.sent.filter((data): data is Uint8Array => data instanceof Uint8Array).map((data) => {
    const length = new DataView(data.buffer, data.byteOffset).getUint16(0);
    return {
      header: JSON.parse(new TextDecoder().decode(data.slice(2, 2 + length))) as Sent['header'],
      body: JSON.parse(new TextDecoder().decode(data.slice(2 + length))) as Sent['body'],
    };
  });
}
async function nth(socket: Socket, index: number): Promise<Sent> {
  // Frames are paced at least 20 ms apart, so a later frame needs a moment.
  for (let tries = 0; tries < 50; tries++) {
    const frame = sentFrames(socket)[index];
    if (frame) return frame;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`frame ${String(index)} was never sent`);
}
function reply(socket: Socket, from: string, messageID: string, jwe: string) {
  const frame = encodeRelayFrame({v:2,id:`reply-${from}`,to:'cli',from}, new TextEncoder().encode(JSON.stringify({type:'RPC',messageID,message:{v:1,jwe}})));
  socket.message(frame.buffer);
}
// Deterministic stand-in for the devSig check: only FF1's reply verifies.
const genuineOnly = (value: Record<string, unknown>) => Promise.resolve((value['message'] as {jwe?:unknown} | undefined)?.jwe === 'genuine');
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('first request fans out once to peers; later requests go only to the verified peer', async () => {
  const socket = new Socket();
  const client = new RelayClient('https://relay.test', 'FF1-TEST', () => socket as unknown as WebSocket);
  socket.message(JSON.stringify({type:'hello', peers:['attacker','ff1']}));
  const first = client.requestPrepared(() => Promise.resolve({command:'ff1Envelope', request:{v:1,jwe:'a'}, verify: genuineOnly}), 2000);
  const fanout = await nth(socket, 0);
  assert.equal(sentFrames(socket).length, 1);
  assert.equal(fanout.header.to, 'peers');
  // Recipients ACK independently; a refusal by one does not fail the frame.
  socket.message(JSON.stringify({type:'error', code:'backpressure', id:fanout.header.id, to:'attacker'}));
  socket.message(JSON.stringify({type:'ack', from:'ff1', id:fanout.header.id}));
  reply(socket, 'ff1', fanout.body.messageID, 'genuine');
  await first;
  const second = client.requestPrepared(() => Promise.resolve({command:'ff1Envelope', request:{v:1,jwe:'b'}, verify: genuineOnly}), 2000);
  const unicast = await nth(socket, 1);
  assert.equal(unicast.header.to, 'ff1');
  socket.message(JSON.stringify({type:'ack', from:'ff1', id:unicast.header.id}));
  reply(socket, 'ff1', unicast.body.messageID, 'genuine');
  await second;
  assert.equal(sentFrames(socket).length, 2);
  client.close();
});

test('a forged reply never settles a request or pins its sender', async () => {
  const socket = new Socket();
  const client = new RelayClient('https://relay.test', 'FF1-TEST', () => socket as unknown as WebSocket);
  socket.message(JSON.stringify({type:'hello', peers:['attacker','ff1']}));
  let settled = false;
  const result = client.requestPrepared(() => Promise.resolve({command:'ff1Envelope', request:{v:1,jwe:'a'}, verify: genuineOnly}), 2000)
    .then((value) => { settled = true; return value; });
  const fanout = await nth(socket, 0);
  socket.message(JSON.stringify({type:'ack', from:'attacker', id:fanout.header.id}));
  reply(socket, 'attacker', fanout.body.messageID, 'forged');
  await tick();
  assert.equal(settled, false);
  reply(socket, 'ff1', fanout.body.messageID, 'genuine');
  assert.equal(((await result)['message'] as {jwe:string}).jwe, 'genuine');
  client.close();
});

test('only a forged reply times the request out', async () => {
  const socket = new Socket();
  const client = new RelayClient('https://relay.test', 'FF1-TEST', () => socket as unknown as WebSocket);
  socket.message(JSON.stringify({type:'hello', peers:['attacker']}));
  const result = client.requestPrepared(() => Promise.resolve({command:'ff1Envelope', request:{v:1,jwe:'a'}, verify: genuineOnly}), 200);
  const fanout = await nth(socket, 0);
  socket.message(JSON.stringify({type:'ack', from:'attacker', id:fanout.header.id}));
  reply(socket, 'attacker', fanout.body.messageID, 'forged');
  await assert.rejects(result, /timeout/);
  client.close();
});

test('a missing verifier is refused before anything is sent', async () => {
  const socket = new Socket();
  const client = new RelayClient('https://relay.test', 'FF1-TEST', () => socket as unknown as WebSocket);
  socket.message(JSON.stringify({type:'hello', peers:['ff1']}));
  const unverified = {command:'ff1Envelope', request:{v:1,jwe:'a'}} as unknown as PreparedRequest;
  await assert.rejects(client.requestPrepared(() => Promise.resolve(unverified), 1000), /verifier/);
  assert.equal(sentFrames(socket).length, 0);
  client.close();
});

test('notifications are dropped: Play never subscribes (§9)', async () => {
  const socket = new Socket();
  const client = new RelayClient('https://relay.test', 'FF1-TEST', () => socket as unknown as WebSocket);
  assert.equal('onNotification' in client, false);
  socket.message(JSON.stringify({type:'hello', peers:['ff1']}));
  const frame = encodeRelayFrame({v:2,id:'n1',to:'cli',from:'ff1'}, new TextEncoder().encode(JSON.stringify({v:1,jwe:'notification'})));
  socket.message(frame.buffer);
  await tick();
  assert.equal(socket.closed, false);
  client.close();
});

test('reassembly memory is capped across peers and expired buffers are swept', () => {
  const socket = new Socket();
  const client = new RelayClient('https://relay.test', 'FF1-TEST', () => socket as unknown as WebSocket);
  const held = (client as unknown as {assemblies: Map<string, {bytes:number}>}).assemblies;
  socket.message(JSON.stringify({type:'hello', peers:['a','b','c']}));
  const data = Buffer.alloc(32768, 1).toString('base64');
  const chunk = (from: string, index: number) => {
    const payload = new TextEncoder().encode(JSON.stringify({relayChunk:{id:`t-${from}`,index,count:128,data}}));
    socket.message(encodeRelayFrame({v:2,id:`${from}-${String(index)}`,to:'cli',from}, payload).buffer);
  };
  for (let index = 0; index < 127; index++) { chunk('a', index); chunk('b', index); }
  chunk('c', 0);
  chunk('c', 1);
  assert.equal(held.get('c')?.bytes, 65536);
  chunk('c', 2);
  assert.equal(held.has('c'), false, 'a transfer past the 8 MiB total is dropped');
  const now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 181000);
  try {
    chunk('c', 0);
    assert.deepEqual([...held.keys()], ['c']);
  } finally {
    clock.mockRestore();
    client.close();
  }
});

test('pings every 25 s, ignores the relay pong and stops pinging once closed', () => {
  vi.useFakeTimers();
  try {
    const socket = new Socket();
    const client = new RelayClient('https://relay.example', 'FF1-TEST', () => socket as unknown as WebSocket);
    socket.message(JSON.stringify({ type: 'hello', connectionId: 'controller', peers: [] }));
    vi.advanceTimersByTime(25_000);
    assert.deepEqual(socket.sent.filter((value) => value === 'ping'), ['ping']);
    // Before: the text frame "pong" went to JSON.parse and closed the client.
    socket.message('pong');
    assert.equal(socket.closed, false);
    vi.advanceTimersByTime(25_000);
    assert.equal(socket.sent.filter((value) => value === 'ping').length, 2);
    client.close();
    vi.advanceTimersByTime(100_000);
    assert.equal(socket.sent.filter((value) => value === 'ping').length, 2);
  } finally {
    vi.useRealTimers();
  }
});
