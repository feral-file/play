# Mint Pairing API Design

This document describes the target API contract between the two broker clients:

- Browser library: the token requester library embedded in the NFT display
  website.
- Mint library: the Go ephemeral token minter library embedded in FF1
  `feral-controld`.

The highest goal is end-to-end encryption of all application data transmitted
between these two clients. The Mint Pairing Broker provides channel discovery,
durable message storage, ordering, polling, and expiry. It must not understand
mint requests, approval results, minted token payloads, or DP1 playlist content.

## Protocol Roles

The broker API has only two data-plane roles. Either one may create a channel;
the other joins it. `creatorRole` on the channel records which.

- `browser`: the requester library in the NFT display website.
- `minter`: the Go minter library in FF1 `feral-controld`. It decrypts and
  validates requester binding and sends an encrypted result supplied by
  `feral-controld`.

**Site-initiated pairing (primary).** The browser creates the channel with its
public key; the broker attests the site origin from the HTTP `Origin` header.
The site shows an app link (button on a phone, QR on a desktop) and a six-digit
code. The Feral File app brings the Art Computer to the channel: it sends
`joinMintPairingChannel` to the device, and the minter joins with the pairing
token or the short code. The browser learns the minter key by polling and then
sends the encrypted mint request.

**Device-initiated pairing (legacy).** The minter creates the channel and the FF1
frontend shows its QR/deep-link or short code; the browser joins it. The broker
still serves this path for requester library versions before 0.4.0. A channel
that never sends `creatorRole` behaves exactly as before.

`ff-controller`, the FF1 frontend, and `ff-relayer` are integration points around
the two libraries, not additional broker API parties. `feral-controld`, not the
Go minter library, owns approval orchestration and `ff-relayer` session
creation.

## Shared Crypto Contract

Both libraries generate ephemeral ECDH key pairs per channel. The initial
algorithm remains:

```text
P256-HKDF-SHA256-AES-256-GCM
```

The broker may store public keys and algorithm identifiers, but all message
payloads are encrypted by the sender and decrypted only by the recipient.

Each encrypted message should bind stable public fields as AAD:

```json
{
  "v": 1,
  "channelId": "ch_...",
  "messageId": "msg_...",
  "seq": 12,
  "sender": "browser",
  "recipient": "minter",
  "algorithm": "P256-HKDF-SHA256-AES-256-GCM"
}
```

For messages encrypted before the broker has assigned a sequence number, clients
use `seq: 0` in the AAD and validate the broker-assigned `seq` from the stored
envelope separately. Browser-to-minter envelopes must also include the sender's
P-256 public JWK as public metadata so the minter can derive the ECDH shared
secret; this public key is not application plaintext.

The encrypted plaintext may contain message types such as:

- `mint_request`
- `mint_rejected`
- `mint_succeeded`
- `client_error`

The broker validates the envelope and size. It does not validate encrypted
message type or plaintext fields.

## Broker HTTP API

### Create Channel

```http
POST /v1/channels
Content-Type: application/json
Origin: https://www.artblocks.io        (browser creator; set by the browser)
```

Site-initiated request (browser creator):

```json
{
  "algorithm": "P256-HKDF-SHA256-AES-256-GCM",
  "creatorRole": "browser",
  "browserPublicKeyJwk": { "kty": "EC", "crv": "P-256", "x": "...", "y": "..." },
  "origin": "https://www.artblocks.io",
  "browserInfo": { "name": "Art Blocks", "label": "artblocks.io", "userAgent": "..." },
  "idleTtlSeconds": 300,
  "shortCodeRequested": true
}
```

Rules for a browser creator:

- `browserPublicKeyJwk` is required (at most 8 KiB); `minterPublicKeyJwk` must
  be absent.
- **Origin attestation.** The request must carry an `Origin` HTTP header that
  is a serialized `http`/`https` origin (no path; the opaque `null` origin is
  refused). Body `origin` must equal it exactly, or be absent, in which case the
  header value is used. Missing header or mismatch is `400 invalid_request`.
  Browsers set `Origin` on cross-origin `fetch` POSTs and a page cannot forge
  it, so a page on one site cannot present itself as another site in the
  approval sheet. The broker records the value on the channel.
- `browserInfo` is optional, a JSON object of at most 8 KiB.
- Creates are rate limited per source host with the same window and thresholds
  as the short-code resolve aggregate limit (8 per minute, then a 5-minute
  lockout); over the limit is `429 rate_limited`. Minter creates are exempt.

Response (browser creator):

```json
{
  "channelId": "ch_...",
  "creatorRole": "browser",
  "browserToken": "bt_...",
  "pairingToken": "pt_...",
  "shortCode": "123456",
  "expiresAt": "2026-09-25T21:00:00.000Z",
  "qrPayload": {
    "v": 2,
    "type": "ff-mint-pairing",
    "creatorRole": "browser",
    "brokerBaseUrl": "https://handoff.feralfile.com",
    "channelId": "ch_...",
    "pairingToken": "pt_...",
    "shortCode": "123456",
    "expiresAt": "2026-09-25T21:00:00.000Z",
    "algorithm": "P256-HKDF-SHA256-AES-256-GCM",
    "browserPublicKeyJwk": {},
    "origin": "https://www.artblocks.io"
  }
}
```

Device-initiated request (minter creator, legacy): `creatorRole` absent or
`"minter"`, `minterPublicKeyJwk` required, and `browserPublicKeyJwk`, `origin`
and `browserInfo` absent.

```json
{
  "algorithm": "P256-HKDF-SHA256-AES-256-GCM",
  "minterPublicKeyJwk": {},
  "idleTtlSeconds": 300,
  "shortCodeRequested": true
}
```

Response (minter creator): as before, plus a self-describing `creatorRole`.

```json
{
  "channelId": "ch_...",
  "creatorRole": "minter",
  "minterToken": "mt_...",
  "pairingToken": "pt_...",
  "shortCode": "123456",
  "expiresAt": "2026-06-16T10:00:00.000Z",
  "qrPayload": {
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
}
```

`pairingToken`, `shortCode`, and the creator's participant token are returned
once. The server stores only hashes. The pairing token is single-use and dies
with the channel.

### Resolve Short Code

```http
POST /v1/pairing-codes/resolve
Content-Type: application/json
```

```json
{ "shortCode": "123456" }
```

Resolution returns the `channelId`, `creatorRole` and the creator's public
fields; the joiner still joins the channel. For a browser-created channel:

```json
{
  "channelId": "ch_...",
  "creatorRole": "browser",
  "algorithm": "P256-HKDF-SHA256-AES-256-GCM",
  "browserPublicKeyJwk": {},
  "origin": "https://www.artblocks.io",
  "browserInfo": {},
  "expiresAt": "2026-09-25T21:00:00.000Z"
}
```

For a minter-created channel it returns `minterPublicKeyJwk` instead of the
three browser fields. Resolve attempts are rate limited per code and per source
host with durable state.

### Join Channel

```http
POST /v1/channels/{channelId}/join
Content-Type: application/json
```

The joiner is always the opposite of `creatorRole`. The credential is exactly
one of `pairingToken` or `shortCode`; short-code joins are rate limited per
channel. A join consumes the pairing token and short code (`waiting` →
`paired`); a second join is `401 unauthorized`. Sending the other role's key
field is `400 invalid_request`.

Minter joining a browser-created channel (site-initiated):

```json
{
  "pairingToken": "pt_...",
  "minterPublicKeyJwk": {}
}
```

`browserPublicKeyJwk`, `origin` and `browserInfo` must be absent: they were fixed
when the browser created the channel. Response:

```json
{
  "channelId": "ch_...",
  "role": "minter",
  "minterToken": "mt_...",
  "algorithm": "P256-HKDF-SHA256-AES-256-GCM",
  "browserPublicKeyJwk": {},
  "origin": "https://www.artblocks.io",
  "browserInfo": {},
  "expiresAt": "2026-09-25T21:00:00.000Z",
  "nextSeq": 1
}
```

Browser joining a minter-created channel (device-initiated, legacy):

```json
{
  "pairingToken": "pt_...",
  "browserPublicKeyJwk": {},
  "origin": "https://nft.example",
  "browserInfo": { "name": "Chrome", "userAgent": "Mozilla/5.0 ..." }
}
```

Response:

```json
{
  "channelId": "ch_...",
  "role": "browser",
  "browserToken": "bt_...",
  "algorithm": "P256-HKDF-SHA256-AES-256-GCM",
  "minterPublicKeyJwk": {},
  "expiresAt": "2026-06-16T10:00:00.000Z",
  "nextSeq": 1
}
```

### Send Message

Used by both libraries. This is the only operation that extends channel TTL.

```http
POST /v1/channels/{channelId}/messages
Authorization: Bearer <browserToken | minterToken>
Content-Type: application/json
```

Request:

```json
{
  "messageId": "msg_...",
  "sender": "browser",
  "recipient": "minter",
  "algorithm": "P256-HKDF-SHA256-AES-256-GCM",
  "senderPublicKeyJwk": {},
  "aad": "...",
  "nonce": "...",
  "ciphertext": "..."
}
```

Response:

```json
{
  "channelId": "ch_...",
  "seq": 12,
  "expiresAt": "2026-06-16T10:04:30.000Z"
}
```

The server assigns `seq` and persists the message in the same transaction that
updates `lastMessageAt` and `expiresAt`.

A message with `sender: "browser"` must carry `senderPublicKeyJwk` equal to the
browser key on the channel, whichever way the browser got into it (at create or
at join). Messages are accepted only once the channel is `paired`.

### Poll Messages

Used by both libraries.

```http
GET /v1/channels/{channelId}/messages?afterSeq=12
Authorization: Bearer <browserToken | minterToken>
```

Response:

```json
{
  "channelId": "ch_...",
  "status": "paired",
  "expiresAt": "2026-06-16T10:04:30.000Z",
  "peer": { "role": "minter", "publicKeyJwk": {} },
  "messages": [
    {
      "seq": 13,
      "messageId": "msg_...",
      "sender": "minter",
      "recipient": "browser",
      "algorithm": "P256-HKDF-SHA256-AES-256-GCM",
      "senderPublicKeyJwk": {},
      "aad": "...",
      "nonce": "...",
      "ciphertext": "..."
    }
  ]
}
```

`status` is `waiting` or `paired`. `peer` is the other participant's role and
public key once it has joined, else `null`. The creator may poll while the
channel is `waiting`: messages stay empty, and this is how the browser creator
learns the minter key before it sends `mint_request`. Polling does not extend
TTL.

### Close Channel

Used by either library after success, rejection, cancellation, or local timeout.

```http
DELETE /v1/channels/{channelId}
Authorization: Bearer <browserToken | minterToken>
```

The server persists a closed or consumed state and removes usable pairing
indexes.

## Browser Library API

The browser library is embedded by the NFT display website. Public APIs hide
broker polling and E2EE details. From 0.4.0 the library creates the channel;
there is no pairing input. (See `docs/integration.md` for the full public API.)

Example TypeScript shape:

```ts
type PairingMaterial = {
  appLink: string; // https://link.feralfile.com/pair?channel=<id>&token=<pairingToken>
  shortCode: string;
  expiresAt: string;
};

type RequestEphemeralSessionOptions = {
  onPairingMaterial?: (material: PairingMaterial) => void;
  appLinkBaseUrl?: string;
  browserInfo?: {
    name?: string;
    userAgent?: string;
    label?: string;
  };
  requestedExpiresInSeconds?: number;
};

type EphemeralBrowserSession = {
  token: string;
  sessionId: string;
  expiresAt?: string;
  persistent?: boolean;
  relayerBaseUrl?: string;
};

async function requestEphemeralSession(
  options: RequestEphemeralSessionOptions
): Promise<EphemeralBrowserSession>;
```

Required behavior:

- Generate a per-channel browser ECDH key pair.
- Create the channel with `creatorRole: "browser"`; the broker attests the
  origin from the `Origin` header. Do not accept caller-controlled origin in the
  public browser API.
- Hand the app link and short code to the pairing UI; the app link carries no
  broker URL (the device joins on its configured broker).
- Poll until `peer` is present, then derive the shared secret from
  `peer.publicKeyJwk`.
- Encrypt the mint request before sending it; its `origin` is
  `window.location.origin`, which the device checks against the attested origin.
- Poll only for encrypted messages addressed to `browser`.
- Decrypt and validate channel binding before returning the token.
- Store the token only in origin-scoped browser storage when storage is enabled.
- Never expose raw token values through logs, analytics, or thrown error text.
- Send `requestedExpiresInSeconds` in the mint request only when the caller set it; the device decides the lifetime.
- Send `supportsPersistentSessions: true` in every mint request. It is the capability flag for the owner-kept session shape: a client that can hold a session with no expiry declares it, and the device may send the nullable shape only to a requester that did.
- Treat a session with a null or absent `expiresAt` (`persistent: true`) as valid until it is revoked.

Requester library versions before 0.4.0 join a device-created channel from a
QR payload or short code instead; the broker still serves that path.

## Mint Library API

The mint library is a Go package embedded by FF1 `feral-controld`. It keeps token
transport encrypted whichever side created the channel.

Example Go shape:

```go
// Site-initiated: join a channel a browser created.
type JoinChannelOptions struct {
    BrokerBaseURL string
    ChannelID     string // required with PairingToken
    PairingToken  string // exactly one of PairingToken or ShortCode
    ShortCode     string // resolved first
}

type JoinedRequester struct {
    Origin      string // attested by the broker from the browser's Origin header
    BrowserInfo BrowserInfo
}

func (c *Client) JoinChannel(ctx context.Context, opts JoinChannelOptions) (*Channel, error)
func (ch *Channel) Requester() JoinedRequester // zero value for a created channel
func (ch *Channel) ChannelID() string

var ErrOriginMismatch error     // mint_request origin != attested origin
var ErrBrowserKeyMismatch error // mint_request key != key returned at join

// BrokerError carries the HTTP status and broker error code of a failed call.
type BrokerError struct {
    Method, Path string
    StatusCode   int
    Code         string
}

// Device-initiated (legacy): create a channel for the FF1 frontend to display.
type StartChannelOptions struct {
    BrokerBaseURL      string
    IdleTTL            time.Duration
    ShortCodeRequested bool
}

type PairingDisplay struct {
    ChannelID string
    QRPayload []byte
    ShortCode string
    ExpiresAt time.Time
}

type MintRequest struct {
    ChannelID                  string
    Origin                     string
    BrowserInfo                BrowserInfo
    RequestedExpiresInSeconds  int
    SupportsPersistentSessions bool
}

type MintResult struct {
    SessionID  string
    Token      string
    ExpiresAt  time.Time
    Persistent bool
}
```

`Persistent` marks a session the device owner kept until they remove it:
`feral-controld` sets it, the encrypted session payload carries
`"persistent": true` with a null `expiresAt`, and `ExpiresAt` is ignored.

The owner-kept shape is gated on the requester's capability. A request without
`supportsPersistentSessions` decodes as incapable — the browser library sends it
from 0.3.0, and every earlier client requires a string `expiresAt` — and the
mint library refuses
a persistent result for it, so the host sends a timed session instead. The wire
version stays `v: 1`: the nullable shape only ever reaches a requester that
declared support for it.

Expected library operations:

- Site-initiated: join a browser-created channel by pairing token or short code
  and expose the attested origin and browser info to `feral-controld` for the
  approval request. There is no display material.
- Legacy: start a channel and return `PairingDisplay` for the FF1 frontend to
  render as a QR/deep-link payload or short code.
- Poll broker messages for encrypted browser requests.
- Decrypt and validate requester origin, public key, and channel binding. On a
  joined channel, the request's origin must equal the attested origin
  (`ErrOriginMismatch`) and its key must equal the key returned at join
  (`ErrBrowserKeyMismatch`).
- Accept a host-provided success or rejection payload from `feral-controld`.
- Encrypt success or rejection back to the browser over the broker channel.
- Close the channel after terminal success or rejection delivery, timeout, cancellation, or local cleanup policy permits removal. The minter must not close immediately after sending a terminal result if that prevents the browser from polling the encrypted message.

## Error Model

Broker-visible errors should be generic:

- `invalid_request`
- `unauthorized`
- `not_found`
- `expired`
- `closed`
- `payload_too_large`
- `rate_limited`

Application-specific rejection reasons should be encrypted inside the minter to
browser message. The broker should not receive plaintext user approval decisions
except for coarse transport state such as a closed channel.

## Non-Goals

- The broker does not mint `ff-relayer` sessions.
- The broker does not call `ff-controller`.
- The broker does not parse DP1 feeds or playlist content.
- The browser library does not receive API keys or topic-management authority.
- The mint library does not call `ff-relayer` or `ff-controller`; `feral-controld`
  performs those integrations and passes final result payloads into the library.
- The mint library does not send raw browser session tokens outside the E2EE
  broker response to the browser.
