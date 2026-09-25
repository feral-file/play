# Sequential Flow

Pairing is **site-initiated**: the NFT display website creates the pairing
channel and shows the visitor how to bring their Art Computer to it, and the
Feral File app brings the device there. The party asking for access shows the
code; the party holding the authority consumes it. The approval sheet in the
app, the mint through `ff-relayer`, and the E2EE delivery of the session back
to the browser are the same as in the earlier device-initiated flow, which the
broker still serves for older requester library versions (see
[Legacy device-initiated pairing](#legacy-device-initiated-pairing)).

Parties:

- NFT display website: the website where the user selects works, exposes a DP1
  feed URL for playback, and runs the token requester browser library
  (`clients/session-recipient/js/`). The library creates the channel and shows
  an app link (a button on a phone, a QR code on a desktop) and a six-digit code.
- Feral File app (`ff-controller`): brings the Art Computer to the site's
  channel from a deep link, a QR scan, or a typed code by sending
  `joinMintPairingChannel` to the chosen device, and is the approval surface. It
  approves or rejects; it does not mint or receive browser session tokens.
- FF1 / `feral-controld`: the device backend that owns the topic authority
  needed to mint browser sessions. It embeds the Go minter library for Mint
  Pairing Broker communication and end-to-end encryption, joins the site's
  channel, asks the app for approval through `ff-relayer`, creates sessions
  through `ff-relayer`, and passes the final success or rejection payload back
  to the Go library for encrypted broker delivery.
- `ff-relayer`: the relay service that carries commands and approval requests
  between the app and the device, and mints, lists, revokes, expires, and
  authorizes ephemeral browser sessions for the cast/display path.
- FF1 frontend: the device web UI. It displays nothing in the site-initiated
  flow; in the legacy flow it shows the device's QR/code.

The transport component formerly called the handoff server is the **Mint
Pairing Broker**. The code lives in `server/`. It holds a temporary channel,
pairing token, short code, the site's attested origin, and opaque end-to-end
encrypted request/response messages while the website and the token minter
pair. The broker does not interpret mint requests, tokens, or DP1 playlist
content.

The browser session is scoped to browser cast/display access. DP1 playlist
content must stay out of `ff-controller`, the Go token minter, and the Mint
Pairing Broker. The browser casts a DP1 feed URL to `ff-relayer`, and the FF1
display path fetches the feed directly.

## Sequence

```mermaid
sequenceDiagram
    autonumber
    participant NFTSite as NFT display website + requester library
    participant Storage as website localStorage
    participant Broker as Mint Pairing Broker (/server)
    participant App as Feral File app (ff-controller)
    participant Relayer as ff-relayer
    participant Feral as FF1 feral-controld
    participant GoMinter as Go broker/E2EE minter library

    NFTSite->>NFTSite: User selects works and builds/hosts DP1 feed URL
    NFTSite->>Storage: Check for origin-scoped ephemeral browser session
    alt no stored or valid session
        NFTSite->>Broker: POST /v1/channels {creatorRole: browser, browserPublicKeyJwk, browserInfo} + Origin header
        Broker->>Broker: Attest origin from the Origin header
        Broker-->>NFTSite: channelId, browserToken, pairingToken, shortCode, expiresAt
        NFTSite->>NFTSite: Show app link (button on phone, QR on desktop) and short code
        alt phone: tap the link / desktop: scan the QR / typed code
            NFTSite-->>App: link.feralfile.com/pair?channel=&token= (or the code typed in the app)
        end
        App->>Feral: joinMintPairingChannel {channelId, pairingToken} or {shortCode} (LAN or via ff-relayer)
        Feral->>GoMinter: JoinChannel
        opt short code
            GoMinter->>Broker: POST /v1/pairing-codes/resolve
            Broker-->>GoMinter: channelId, creatorRole browser
        end
        GoMinter->>Broker: POST /v1/channels/{id}/join {pairingToken | shortCode, minterPublicKeyJwk}
        Broker-->>GoMinter: minterToken, browserPublicKeyJwk, attested origin, browserInfo
        GoMinter-->>Feral: Joined channel and attested requester
        Feral-->>App: {ok: true, status: joined, channelId, origin, browserInfo}
        loop until peer joined or channel expires
            NFTSite->>Broker: Poll messages with browserToken
            Broker-->>NFTSite: status waiting/paired, peer {role: minter, publicKeyJwk}
        end
        NFTSite->>Broker: E2EE mint_request (origin, browserInfo, browser key)
        loop until request arrives or channel expires
            GoMinter->>Broker: Poll with minterToken
            Broker-->>GoMinter: Encrypted mint_request
        end
        GoMinter->>GoMinter: Decrypt; check key == join key and origin == attested origin
        Feral->>Relayer: Send approval request for the app
        Relayer->>App: Deliver origin/client approval request
        alt user rejects
            App-->>Relayer: Reject
            Relayer-->>Feral: Return rejection
            Feral->>GoMinter: Send rejection result
            GoMinter->>Broker: E2EE mint_rejected
        else user approves
            App-->>Relayer: Approve (keep paired or timed)
            Relayer-->>Feral: Return approval
            Feral->>Relayer: POST /api/ephemeral-sessions?topicID=...
            Relayer-->>Feral: Return session metadata and one-time token
            Feral->>GoMinter: Send success result
            GoMinter->>Broker: E2EE mint_succeeded with the session
        end
        loop until result or expired
            NFTSite->>Broker: Poll for encrypted result
            Broker-->>NFTSite: Encrypted rejection or session
        end
        NFTSite->>NFTSite: Validate request binding and token metadata
        NFTSite->>Storage: Store token under current website origin
    end
    NFTSite->>Relayer: POST /api/cast with bearer browser session and DP1 feed URL
    Relayer->>Feral: Forward displayPlaylist command for the device topic
    Feral->>NFTSite: Fetch DP1 feed URL directly
    Feral->>Feral: Resolve DP1 and play through Chromium/frontend
    Feral-->>Relayer: Report playback success/failure
    Relayer-->>NFTSite: Return cast result
```

## Legacy device-initiated pairing

Requester library versions before 0.4.0 pair the other way round, and the
broker keeps serving them unchanged: `feral-controld` creates the channel
(`creatorRole` absent or `minter`) through the Go library's `StartChannel`, the
FF1 frontend shows the QR/deep-link payload or short code, and the website
joins with its browser key, origin and browser info. The mint request,
approval, mint and E2EE delivery are the same as above. In this path the origin
the device shows comes only from the encrypted mint request, not from a broker
attestation. The path is deleted after the last site on an older library
upgrades.

## Responsibilities

### NFT Display Website

The NFT display website lets the user select works, builds or hosts the DP1 feed
URL, and runs the token requester browser library. It first checks
`localStorage` for an existing ephemeral browser session scoped to the current
website origin. If one is missing or invalid, it creates a pairing channel on
the Mint Pairing Broker, shows the visitor the app link and short code, waits
for the Art Computer to join, establishes an end-to-end encrypted channel with
the token minter, submits a mint request containing origin and browser/client metadata, receives the
encrypted token result, stores the token in origin-scoped storage, and attaches
it only to the intended `ff-relayer` cast/display request. It does not receive
API keys or topic-management authority.

### Ephemeral Token Minter

The ephemeral token minter is the Go library used by FF1 `feral-controld` for
broker communication and end-to-end encryption. It joins a site-created channel
(`JoinChannel`) by pairing token or short code and returns the origin and
browser info the broker attested, decrypts requester mint requests, validates
requester binding (including that the request's origin and key match what the
broker attested at join), and sends encrypted success or rejection payloads back
through the broker. For the legacy path it still starts channels
(`StartChannel`) and returns QR/deep-link and short-code material for FF1
frontend display.

The Go library does not contact `ff-controller` or `ff-relayer` and does not
own session creation policy. `feral-controld` receives the decrypted
`MintRequest`, asks the user for approval through its controller/relayer path,
calls `ff-relayer` to create an ephemeral browser session on approval, then
passes either `MintResult` or `MintRejection` into the Go library for encrypted
delivery to the requester.

### ff-controller

`ff-controller` is the approval UI rather than the token minter. In the
site-initiated flow it also brings the device to the site's channel: it opens
from the app link, a QR scan, or a typed code and sends `joinMintPairingChannel`
to the chosen Art Computer. It never talks to the broker. `feral-controld`
contacts it through `ff-relayer` with a request summary,
selected FF1/device topic, origin, client information, and challenge details.
The controller returns approve or reject through `ff-relayer`. It must not
receive, copy, or proxy raw browser session tokens or DP1 playlist content.

### ff-relayer

`ff-relayer` owns the ephemeral session lifecycle used for display requests:
create, list, revoke, expire, and authorize browser casts. Per
`feral-file/ff-relayer#13`, `feral-controld` creates sessions with
`POST /api/ephemeral-sessions?topicID=...`, management clients can list and
revoke with `GET /api/ephemeral-sessions?topicID=...` and
`DELETE /api/ephemeral-sessions/{sessionID}?topicID=...`, and browsers cast with
`Authorization: Bearer <session-token>` or
`EPHEMERAL-SESSION: <session-token>`. Browser session tokens are accepted only
for the allowed cast/display path and do not grant broader API-key access.

### Mint Pairing Broker

The Mint Pairing Broker is a narrow bridge between token requesters and token
minters. It attests the creating site's origin from the HTTP `Origin` header,
so the approval sheet names the site that actually asked. It stores channel records and opaque encrypted messages in durable bbolt
state, backed by the Docker volume in deployed environments, for a short pairing
window. The broker does not interpret whether a message is a mint request, an
approval result, a token payload, or any other content because request and
response messages are end-to-end encrypted between the requester and minter.

The broker enforces strict request and payload limits to bound abuse and storage
growth. The current encrypted payload limit is 64 KiB, which is intentionally
larger than expected token-mint metadata while still small enough for short-lived
bbolt storage and HTTP polling.

### FF1 / feral-controld and Frontend

`feral-controld` is the FF1 backend and embeds the Go broker/E2EE minter
library. In the site-initiated flow it receives `joinMintPairingChannel` from the
app, joins the site's channel, and shows nothing on the FF1 frontend; in the
legacy flow the FF1 frontend presents the pairing QR/deep-link or short code
returned by the library. `feral-controld` owns approval orchestration, `ff-relayer` session creation, and topic authority.
The FF1 display path receives the relayer cast command after the browser
presents a valid ephemeral session, fetches the DP1 feed URL directly, resolves
DP1 content, and plays it through Chromium/frontend. The device path, not
`ff-controller`, fetches playlist content.

## Security Notes

- Ephemeral browser session tokens are bearer credentials and must not be logged.
- Tokens stored by the browser library are scoped by browser origin through `localStorage`.
- Mint request and token response payloads are opaque to the Mint Pairing Broker and are retained only for the short pairing window.
- `feral-controld` obtains raw token material from `ff-relayer` and passes it to the Go minter library only for E2EE requester delivery.
- Revocation and expiry are enforced by `ff-relayer`.
- The broker records the creating site's origin from the HTTP `Origin` header, which a page running in a browser cannot forge, and the device refuses a mint request whose origin differs from it. The header binds pages, not programs: a client outside a browser can send any `Origin`, so the attestation stops one web page from impersonating another, not a server-side creator.
- The pairing token and short code are single-use and die with the channel (idle TTL, at most 300 s). The app link carries the pairing token but no broker URL; the device always joins on its configured broker.
- `ff-controller` approves or rejects requests but does not receive raw tokens or DP1 playlist content.
- DP1 feed URLs travel through the browser cast request; DP1 playlist content is fetched directly by the FF1 display path.
- Session-management actions remain controlled by `feral-controld` or another API-key-authorized party outside the Go broker/E2EE library.
