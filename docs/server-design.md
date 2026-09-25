# Mint Pairing Broker Server Design

This document describes the target server design for the Mint Pairing Broker in
`server/`. It is a design document, not a statement that the current code has
already been migrated from the earlier handoff implementation.

The broker has one job: allow an NFT display website and the FF1
`feral-controld` Go mint library to find a shared channel and exchange
end-to-end encrypted messages. The broker must not decrypt, interpret, or log the
application data being transmitted.

## Goals

- Provide a temporary channel identified by one `channelId`.
- Support site-initiated pairing: the NFT display website creates the channel
  with an attested origin, and the minter joins it by pairing token (app link
  or QR) or short code. Keep serving the legacy device-initiated pairing, where
  the minter creates the channel and the website joins from the FF1 frontend's
  QR/deep-link or short code.
- Treat the QR pairing token as plaintext bootstrap material, not E2EE data.
- Store only hashes for bearer tokens and short codes when validation is needed.
- Support bidirectional E2EE message transmission on the same channel.
- Count channel TTL from the last accepted message sent to that `channelId`.
- Store all channel, token, message, expiry, and rate-limit state durably in a
  bbolt database.
- Use no process-local maps for sessions, tokens, messages, expiry, rate-limit
  shortcuts, cursors, sequence counters, or pairing state.

## Channel Model

A channel is the durable unit of pairing and message transport. Both clients
send and receive messages by referencing the same `channelId`.

The two broker clients are:

- `browser`: the token requester library embedded in the NFT display website.
- `minter`: the Go ephemeral token minter library embedded in FF1
  `feral-controld`.

Either role may create a channel (`creatorRole`); the other joins. In the legacy
flow the FF1 frontend displays pairing material produced by the minter. It is
not a broker protocol participant unless a future implementation makes it one.
`ff-controller` and `ff-relayer` are outside the broker data plane; `feral-controld`
uses them for approval and token minting after the Go minter library decrypts a
browser request.

## QR Pairing Token

The QR/deep-link payload is intentionally not encrypted. It is bootstrap data
that lets the NFT display website join the channel.

Legacy (minter-created) QR payload, displayed on the FF1:

```json
{
  "v": 1,
  "type": "ff-mint-pairing",
  "brokerBaseUrl": "https://pairing.example",
  "channelId": "ch_...",
  "pairingToken": "pt_...",
  "shortCode": "123456",
  "expiresAt": "2026-06-16T10:00:00.000Z",
  "algorithm": "P256-HKDF-SHA256-AES-256-GCM",
  "minterPublicKeyJwk": {}
}
```

A browser-created channel returns a `v: 2` payload with `creatorRole: "browser"`,
`browserPublicKeyJwk` and `origin` in place of `minterPublicKeyJwk` (see
`docs/api-design.md`); the site turns it into an app link
`https://link.feralfile.com/pair?channel=<id>&token=<pairingToken>`.

`pairingToken` is a high-entropy bearer join secret. It may appear in the app
link or QR code the site shows (site-initiated) or in the QR code or deep link
shown on the FF1 display (legacy), but the server stores only
`hash(pairingToken)`. The raw value is returned only to the channel creator so it
can render it.

`shortCode` is optional, lower entropy, and user-entered. It must be short-lived,
rate limited, and stored only as a hash. A short-code lookup index may map
`hash(shortCode)` to `channelId`, but failed attempts and lockout state must also
be durable, not in memory.

After the joiner (the minter on a browser-created channel, the browser on a
legacy minter-created one) successfully joins, the broker mints its participant
token, stores only its hash, and marks the pairing token as consumed.
This makes the plaintext QR token a one-time bootstrap credential rather than a
long-lived channel credential.

## E2EE Message Transport

All application messages are encrypted before they reach the broker. The broker
stores message envelopes and ciphertext, but not plaintext. Public metadata such
as `channelId`, sequence number, sender role, recipient role, algorithm, and
timestamps are visible to the broker.

The same channel supports both directions:

- `browser -> minter`: mint request, requester/browser metadata, requester public
  key, and any follow-up control messages.
- `minter -> browser`: rejection, minted token result, recoverable errors, and
  any follow-up control messages.

Every accepted message references exactly one `channelId`. The broker assigns a
monotonic `seq` inside the channel transaction so both clients can poll by
cursor, for example `afterSeq=12`.

## TTL Semantics

The channel has an idle TTL. `expiresAt` is computed from `lastMessageAt`:

```text
expiresAt = lastMessageAt + idleTtlSeconds
```

On channel creation, `lastMessageAt` is initialized to `createdAt` so a channel
without any messages still expires. On every accepted message append, the broker
updates `lastMessageAt` and `expiresAt` in the same durable transaction that
stores the message. Polls, reads, short-code lookups, and failed auth attempts do
not extend TTL.

Expired channels reject new messages. Cleanup may either delete expired records
or mark them expired first, but the decision must be persisted in bbolt.

## bbolt Storage Model

The target server should use `go.etcd.io/bbolt` as the local embedded database.
bbolt is a single-file, pure Go key/value store with ACID transactions,
serializable isolation, many concurrent read-only transactions, and one
read-write transaction at a time. Its core hierarchy is a `DB` containing
buckets; each bucket contains unique keys with values and may also contain nested
buckets. This maps well to one durable bucket tree per `channelId`.

Relevant bbolt design points to rely on:

- Use `DB.View` for poll/read paths and `DB.Update` for create, join, append,
  close, and cleanup paths.
- Keep read transactions short. Values returned by bbolt are valid only for the
  lifetime of the transaction, so implementation code should copy bytes before
  returning them to HTTP handlers.
- Use bucket cursors for ordered scans, especially cleanup indexes and message
  pagination.
- Use a per-channel `messages` bucket and `Bucket.NextSequence()` for monotonic
  message sequence numbers inside that channel.
- Use nested buckets to keep a channel's metadata, participants, and messages
  together while keeping lookup indexes in top-level buckets.
- Run one broker process per bbolt database file. bbolt takes an exclusive file
  lock on open, so horizontal scaling requires independent database files or a
  different storage topology.

Primary references:

- [bbolt package docs](https://pkg.go.dev/go.etcd.io/bbolt)
- [bbolt README](https://github.com/etcd-io/bbolt)

## Bucket Layout

The exact byte encoding can change during implementation, but the durable bucket
layout should use bbolt buckets rather than flat string prefixes.

Top-level buckets:

```text
meta
channels
pairing_tokens
short_codes
cleanup_by_expiry
```

`meta` stores schema version and migration state:

```text
meta["schema_version"] = "1"
```

`channels` contains one nested bucket per channel:

```text
channels
  <channelId>
    meta
    participants
    messages
```

`pairing_tokens` indexes high-entropy QR/deep-link join tokens:

```text
pairing_tokens[hash(pairingToken)] = channelId
```

`short_codes` indexes lower-entropy manual entry codes:

```text
short_codes[hash(shortCode)] = channelId
```

`cleanup_by_expiry` is ordered by an encoded expiry timestamp and channel ID:

```text
cleanup_by_expiry[bigEndianUnixMillis(expiresAt) + "\x00" + channelId] = ""
```

The cleanup worker can cursor-scan from the first key until the encoded expiry
is greater than `now`. Because channel messages extend TTL, cleanup may encounter
stale index entries. It must load the channel's current `meta` record before
closing or deleting a channel.

## Channel Bucket Records

The exact key prefixes can change during implementation, but the durable records
should cover these concepts.

### `channels/<channelId>/meta["record"]`

```ts
type ChannelRecord = {
  channelId: string;
  version: 1;
  status: "waiting" | "paired" | "closed" | "expired";
  algorithm: "P256-HKDF-SHA256-AES-256-GCM";
  createdAt: string;
  pairedAt?: string;
  lastMessageAt: string;
  expiresAt: string;
  idleTtlSeconds: number;
  creatorRole?: "minter" | "browser"; // absent on older records = "minter"
  minterPublicKeyJwk?: JsonWebKey;     // set at create or at join, by role
  browserPublicKeyJwk?: JsonWebKey;    // set at create or at join, by role
  origin?: string;                     // attested from the Origin header; browser creators only
  browserInfo?: object;                // browser creators only
  pairingTokenHash: string;
  pairingConsumedAt?: string;
  shortCodeHash?: string;
  shortCodeAttemptCount: number;
};
```

### `participant:<channelId>:<role>`

```ts
type ParticipantRecord = {
  channelId: string;
  role: "browser" | "minter";
  tokenHash: string;
  createdAt: string;
  revokedAt?: string;
};
```

The creator's participant token is returned on channel creation; the joiner's
after a successful join. Raw participant tokens must never be stored.

Storage:

```text
channels/<channelId>/participants["minter"] = ParticipantRecord
channels/<channelId>/participants["browser"] = ParticipantRecord
```

### `channels/<channelId>/messages`

```ts
type MessageRecord = {
  channelId: string;
  seq: number;
  messageId: string;
  sender: "browser" | "minter";
  recipient: "browser" | "minter";
  createdAt: string;
  algorithm: "P256-HKDF-SHA256-AES-256-GCM";
  aad: string;
  nonce: string;
  ciphertext: string;
  sizeBytes: number;
};
```

The message key is `uint64(seq)` encoded as big-endian bytes so cursor iteration
returns messages in sequence order. The per-channel `messages` bucket owns the
sequence counter via bbolt `NextSequence()`.

Message bodies remain opaque to the broker. The server validates envelope shape,
sender authorization, recipient role, and size limits only.

## Required Transactions

- Initialize database: create all top-level buckets in one `DB.Update`
  transaction.
- Create channel: create `channels/<channelId>` and its `meta`, `participants`,
  and `messages` nested buckets; write channel metadata; write
  the creator's participant record; for a browser creator, record the attested
  origin and count the create against the per-source rate limit; write `pairing_tokens`; write optional
  `short_codes`; and write the initial `cleanup_by_expiry` entry in one
  transaction.
- Join channel: validate that the request carries the joiner role's key field,
  validate pairing token hash or short-code hash, reject expired or consumed
  channels, write the joiner's participant record, persist its public key,
  mark pairing consumed, delete the usable `pairing_tokens` entry, and update
  channel status in one transaction.
- Append message: validate participant token hash, load channel, reject expired
  channels, assign `seq` through the per-channel `messages.NextSequence()`,
  write message, update `lastMessageAt`, update `expiresAt`, and write a new
  `cleanup_by_expiry` index key in one transaction.
- Close channel: persist closed status and remove usable indexes in one
  transaction.
- Expire channel: persist expired status or delete channel-related records from
  durable state. Do not rely on process memory.

## Logging

Logs may include `channelId`, status transitions, response codes, and bounded
message sizes. Logs must not include raw pairing tokens, raw participant tokens,
short codes, ciphertext bodies, bearer session tokens minted by `ff-relayer`, or
DP1 playlist content.

## Current Implementation Notes

The current server is a Go Mint Pairing Broker backed by bbolt buckets. It uses
the channel-based `/v1/channels` API, durable bidirectional encrypted message
records, one-time QR pairing tokens, hashed participant tokens, persisted
short-code rate-limit state, and TTL extension from accepted channel messages.
Downstream `ff-relayer` ephemeral session creation remains outside this broker
and is intentionally implemented by the minter host integration rather than by
the broker.
