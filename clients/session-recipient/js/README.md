# @feralfile/display

`clients/session-recipient/js/` is `@feralfile/display`, the browser library websites embed to pair a visitor's browser with their Art Computer and display a DP-1 playlist on it. Through 0.4.1 it was published as `@feralfile/play`; see [Renamed from @feralfile/play](#renamed-from-feralfileplay). Internally it is the mint-pairing requester: the browser client that requests an ephemeral browser session from the Go token minter embedded in FF1 `feral-controld`.

```sh
npm i @feralfile/display
```

The published package ships compiled ESM + type declarations from `dist/` (`npm run build`). Source stays TypeScript-first in `src/`.

Browser runtimes check `localStorage` under the current website origin for an existing ephemeral browser session. If one is missing or invalid, `requestEphemeralSession` creates a Mint Pairing Broker channel as the browser (`creatorRole: "browser"`, with the origin from `window.location.origin`, which the broker checks against the `Origin` header the browser sets), hands the visitor the app link `https://link.feralfile.com/pair?channel=<id>&token=<pairingToken>` and a six-digit code through `onPairingMaterial`, and polls until the visitor's Art Computer joins the channel. It then sends an end-to-end encrypted `mint_request` to the joined device's key, polls for the encrypted minter result, validates the channel binding, stores the recovered token in origin-scoped storage when storage is enabled, and returns the session metadata. `displayDp1Playlist` uses that session to request DP1 playlist display through `ff-relayer` without exposing the relayer command envelope to website code. See [Sequential Flow](../../../docs/sequential-flow.md) for the end-to-end model.

```ts
import {
  displayDp1Playlist,
  requestEphemeralSession
} from "@feralfile/display";

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

For a standard integration, mount the provided **Display on Art Computer** button.
It checks origin-scoped storage first, opens the pairing dialog only when
there is no valid local browser session, waits for the Art Computer to join
and the owner to approve in the app, and then sends the DP1 playlist to
`ff-relayer`.

```ts
import { mountDisplayOnArtComputerButton } from "@feralfile/display";

mountDisplayOnArtComputerButton({
  container: "#display-on-art-computer",
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
shows fresh material, up to twice, and then the send fails with
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

## Renamed from @feralfile/play

The verb for putting art on a display is display, so the package is
`@feralfile/display` from 0.4.2 and the button reads **Display on Art
Computer**. 0.4.2 is the 0.4.1 library under its new name: it works with the
FF OS on Art Computers today, and a site that is already paired stays paired.
`@feralfile/play` stops at 0.4.1. To move, change the dependency and the
import specifier. The old names keep working as deprecated aliases through
0.5.x and go in 0.6.0:

| Deprecated | Use |
| :-- | :-- |
| `mountPlayOnArtComputerButton` | `mountDisplayOnArtComputerButton` |
| `PlayOnArtComputerButtonOptions` | `DisplayOnArtComputerButtonOptions` |
| `PlayOnArtComputerButtonHandle` | `DisplayOnArtComputerButtonHandle` |
| `PlayError` | `DisplayError` (the same class: `instanceof PlayError` still matches) |
| `PlayErrorCode` | `DisplayErrorCode` |
| CSS classes `ff-ac-play`, `ff-ac-play-button`, `ff-ac-play-status` | `ff-ac-display`, `ff-ac-display-button`, `ff-ac-display-status` (the button carries both; the default styles use only the new ones) |

What reads differently: the default button label is "Display on Art
Computer", the dialog title "Display on your Art Computer", the approved
status "Approved. Sending the playlist…", the messages that told the visitor
to press play say try again, and an error's `name` is `"DisplayError"`.
`buttonLabel` and `dialog.copy` overrides work as before, and error codes are
unchanged. The self-hosted bundle is `display.js`.

0.5.0 sends over relay v2 with display grants, which need FF OS 3.0. Stay on
0.4.x until the Art Computers your visitors own run it.

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
