# @feralfile/play

`clients/session-recipient/js/` is `@feralfile/play`, the browser library websites embed to pair a visitor's browser with their Art Computer and play a DP-1 playlist on it. Internally it is the mint-pairing requester: the browser client that requests an ephemeral browser session from the Go token minter embedded in FF1 `feral-controld`.

```sh
npm i @feralfile/play
```

The published package ships compiled ESM + type declarations from `dist/` (`npm run build`). Source stays TypeScript-first in `src/`.

Browser runtimes check `localStorage` under the current website origin for an existing ephemeral browser session. If one is missing or invalid, `requestEphemeralSession` creates a Mint Pairing Broker channel as the browser (`creatorRole: "browser"`, with the origin from `window.location.origin`, which the broker checks against the `Origin` header the browser sets), hands the visitor the app link `https://link.feralfile.com/pair?channel=<id>&token=<pairingToken>` and a six-digit code through `onPairingMaterial`, and polls until the visitor's Art Computer joins the channel. It then sends an end-to-end encrypted `mint_request` to the joined device's key, polls for the encrypted minter result, validates the channel binding, stores the recovered token in origin-scoped storage when storage is enabled, and returns the session metadata. `displayDp1Playlist` uses that session to request DP1 playlist display through `ff-relayer` without exposing the relayer command envelope to website code. See [Sequential Flow](../../../docs/sequential-flow.md) for the end-to-end model.

```ts
import {
  displayDp1Playlist,
  requestEphemeralSession
} from "@feralfile/play";

const session = await requestEphemeralSession({
  brokerBaseUrl: "https://handoff.feralfile.com",
  browserInfo: { name: "Chrome", label: "Gallery wall browser" },
  // Show the link (button or QR) and the code; do not log them.
  onPairingMaterial: ({ appLink, shortCode, expiresAt }) => showPairing(appLink, shortCode, expiresAt)
});

await displayDp1Playlist({
  session,
  playlist: dp1Playlist,
  // Fallback when the session carries no relayer URL; the host from Network endpoints.
  relayerBaseUrl: "https://tv-cast-coordination.autonomy-system.workers.dev"
});
```

## Wrapped Pairing UI

For a standard integration, mount the provided **Play on Art Computer** button.
It checks origin-scoped storage first, opens the pairing dialog only when
there is no valid local browser session, waits for the Art Computer to join
and the owner to approve in the app, and then sends the DP1 playlist to
`ff-relayer`.

```ts
import { mountPlayOnArtComputerButton } from "@feralfile/play";

mountPlayOnArtComputerButton({
  container: "#play-on-art-computer",
  playlist: dp1Playlist,
  brokerBaseUrl: "https://handoff.feralfile.com",
  // Optional; this is the default.
  appLinkBaseUrl: "https://link.feralfile.com/pair",
  // Fallback when the session carries no relayer URL; the host from Network endpoints.
  relayerBaseUrl: "https://tv-cast-coordination.autonomy-system.workers.dev"
});
```

The relayer base URL arrives inside the approved session
(`session.relayerBaseUrl`) and wins whenever it is there, so never hard-code a
host in display code. The `relayerBaseUrl` option above is the fallback for a
session that carries none — without it such a session fails with `relayer base
URL is required`. A `Content-Security-Policy` also has to be written before any
session exists, so `connect-src` needs the relayer origin up front: the
[Integration Guide](../../../docs/integration.md#network-endpoints) lists the
hosts to allow.

On a touch device (phone or tablet) the dialog shows an
**Open the Feral File app** link and, below it, the six-digit code, which
copies on tap. On a pointer device it shows a QR code of the app link, drawn in the
page with the bundled `qrcode-generator` (no image request), captioned "Scan
with your phone camera or the Feral File app", with the code below. A status
line reads "Waiting for your Art Computer…" and then "Approve in the Feral
File app…". If the channel expires before an Art Computer joins, the dialog
shows fresh material, up to twice, and then the play fails with
`approval_timeout`.

For custom UI, use `createPairingDialog`,
`requestEphemeralSessionWithPairingUi`, `hasStoredEphemeralBrowserSession`, and
`clearStoredEphemeralBrowserSession`. The dialog accepts copy, class-name, and
layout overrides so a website can keep its own styling while preserving the
pairing sequence and approval handoff; `createDialog` replaces it with any
implementation of `PairingDialog` (`{ show, setStatus, close }`).

Upgrading from 0.3.x: the `pairing` input (`{ shortCode }` / `{ qrPayload }`)
is gone because the site now starts pairing; `requestEphemeralSession` takes
`brokerBaseUrl` and `onPairingMaterial` instead. `createPairingCodeDialog` is
now `createPairingDialog`, and the error codes `pairing_code_not_found` and
`pairing_code_used` no longer exist. The wrapped button is unchanged apart
from the new optional `appLinkBaseUrl`.

## Commands

```sh
npm ci
npm run lint
npm run typecheck
npm test
npm run build
npm run bundle
```

## Boundaries

- Store browser session tokens only in origin-scoped browser storage.
- Do not expose token values through logs, thrown errors, analytics, or public callbacks. The one exception is the channel's pairing token inside the app link, which `onPairingMaterial` hands over because the visitor has to open or scan it; it is single-use and dies with the channel.
- Use the token only for the intended `ff-relayer` display/cast path.
- Keep API names requester-oriented rather than tied to a specific website.
