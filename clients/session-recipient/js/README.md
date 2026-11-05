# @feralfile/display

`clients/session-recipient/js/` is `@feralfile/display`, the browser library websites embed to pair a visitor's browser with their Art Computer and display a DP-1 playlist on it. It was published as `@feralfile/play` through 0.4.0; see [Renamed from @feralfile/play](#renamed-from-feralfileplay). Internally it is the mint-pairing requester: the browser client that asks the Go token minter embedded in FF1 `feral-controld` for a **display grant**, a display-only controller record of the FF1 control protocol (ffos-user `docs/ff1-control-v1.md` §5.7), and then casts to the FF1 over relay v2 with the keys that grant was issued to. An FF1 on FF OS without display grants answers the same request with a **relayer session** instead, and the library casts with it through the legacy relayer, as 0.4 did; see [Both firmware generations](#both-firmware-generations).

```sh
npm i @feralfile/display
```

The published package ships compiled ESM + type declarations from `dist/` (`npm run build`). Source stays TypeScript-first in `src/`.

Browser runtimes check IndexedDB (database `ff-play`, a name kept so stored grants survive the rename; store `displayGrants`, keyed by the current website origin) for an existing display grant. If one is missing or expired, `requestEphemeralSession` generates fresh non-extractable P-256 keys, creates a Mint Pairing Broker channel as the browser (`creatorRole: "browser"`, with the origin from `window.location.origin`, which the broker checks against the `Origin` header the browser sets), hands the visitor the app link `https://link.feralfile.com/pair?channel=<id>&token=<pairingToken>` and a six-digit code through `onPairingMaterial`, and polls until the visitor's Art Computer joins the channel. It then sends an end-to-end encrypted `mint_request` carrying the public keys to the joined device's key, polls for the encrypted result, validates the channel binding, stores the grant with its keys and request counter as one IndexedDB record, and returns the pairing metadata. `displayDp1Playlist` seals a `displayPlaylist` command under those keys and sends it over relay v2 (`wss://<relayV2Endpoint>/v2/channels/<deviceId>/connections`), opening a socket per cast and closing it right after, without exposing the envelope to website code. See [Sequential Flow](../../../docs/sequential-flow.md) for the end-to-end model.

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

await displayDp1Playlist({ session, playlist: dp1Playlist });
```

## Wrapped Pairing UI

For a standard integration, mount the provided **Display on Art Computer** button.
It checks the origin's grant store first, opens the pairing dialog only when
there is no valid grant, waits for the Art Computer to join and the owner to
approve in the app, and then sends the DP1 playlist to the FF1 over relay v2.

```ts
import { mountDisplayOnArtComputerButton } from "@feralfile/display";

mountDisplayOnArtComputerButton({
  container: "#display-on-art-computer",
  playlist: dp1Playlist,
  brokerBaseUrl: "https://handoff.feralfile.com",
  // Where a relayer session casts when the FF1 names no relayer of its own;
  // only FF1s on FF OS without display grants use it.
  relayerBaseUrl: "https://tv-cast-coordination.autonomy-system.workers.dev",
  // Optional; this is the default.
  appLinkBaseUrl: "https://link.feralfile.com/pair"
});
```

The relay v2 endpoint arrives inside the grant (`relayV2Endpoint`) and is the
only one a grant uses, so never hard-code a relay v2 host in display code. A
`Content-Security-Policy` still has to be written before any pairing exists,
so `connect-src` needs the hosts up front: the
[Integration Guide](../../../docs/integration.md#network-endpoints) lists them.

On a touch device (phone or tablet) the dialog shows an
**Open the Feral File app** link and, below it, the six-digit code, which
copies on tap. On a pointer device it shows a QR code of the app link, drawn in the
page with the bundled `qrcode-generator` (no image request), captioned "Scan
with your phone camera or the Feral File app", with the code below. A status
line reads "Waiting for your Art Computer…" and then "Approve in the Feral
File app…". If the channel expires before an Art Computer joins, the dialog
shows fresh material, up to twice, and then the button fails with
`approval_timeout`.

When the FF1 answers a cast with an unverified `unknown_controller` or
`bad_envelope` (a factory reset, or the site was removed on the device), the
button fails with `device_unrecognized`, keeps the stored grant, and reads
"Pair again?"; only the visitor's next click clears it and pairs again. When
the legacy relayer answers a relayer session's cast with
`400 {"error":{"id":1003}}` (no FF1 on the session's channel: updated, or
off), the button also reads "Pair again?", but that click pairs without
deleting the session; only a successful pairing replaces it.

For custom UI, use `createPairingDialog`,
`requestEphemeralSessionWithPairingUi`, `hasStoredEphemeralBrowserSession`,
`clearStoredEphemeralBrowserSession` and `unpairArtComputer`. The dialog accepts copy, class-name, and
layout overrides so a website can keep its own styling while preserving the
pairing sequence and approval handoff; `createDialog` replaces it with any
implementation of `PairingDialog` (`{ show, setStatus, close }`).

## Both firmware generations

One pairing request serves every FF1. It carries the display-grant keys, and
the FF1 answers with what its firmware can issue:

- **FF OS with display grants**: a display grant. `EphemeralBrowserSession` is
  `{ kind: "displayGrant", deviceId, ctl, expiresAt?, persistent }`, the grant
  and its keys live in IndexedDB, and casts go over relay v2.
- **FF OS without display grants** (2.0.x): its minter ignores the keys and
  mints a relayer session. `EphemeralBrowserSession` is
  `{ kind: "relayerSession", sessionId, expiresAt?, persistent, relayerBaseUrl? }`;
  the token is stored in `localStorage` under
  `ephemeralBrowserSessionStorageKey(origin)` (the 0.4 key and record, so a
  session 0.4 stored keeps working) and never appears in the returned value.
  A cast is one HTTPS `POST /api/cast` on the session's `relayerBaseUrl`, or
  the `relayerBaseUrl` option when the session names none; with neither, the
  cast throws.

On each display request the library takes a stored grant first, then a stored
session, and pairs only when neither is valid. A grant replaces any stored
session. When an FF1 that paired on 2.0.x moves to FF OS with display grants,
the legacy relayer answers the old session's cast with
`400 {"error":{"id":1003}}`; the library throws `device_unrecognized` and keeps
the session, because an old FF1 that is only switched off answers the same.
The button then reads "Pair again?", and that pairing yields a grant.

## Renamed from @feralfile/play

The verb for putting art on a display is display, not play, so the package is
`@feralfile/display` from 0.5.0 and the button reads **Display on Art
Computer**. `@feralfile/play` stops at 0.4.0. To move, change the dependency
and the import specifier, then follow [Upgrading from 0.4.x](#upgrading-from-04x).
The old names were deprecated aliases in 0.5.x and are gone in 0.6.0:

| Removed in 0.6.0 | Use |
| :-- | :-- |
| `mountPlayOnArtComputerButton` | `mountDisplayOnArtComputerButton` |
| `PlayOnArtComputerButtonOptions` | `DisplayOnArtComputerButtonOptions` |
| `PlayOnArtComputerButtonHandle` | `DisplayOnArtComputerButtonHandle` |
| `PlayError` | `DisplayError` |
| `PlayErrorCode` | `DisplayErrorCode` |
| CSS classes `ff-ac-play`, `ff-ac-play-button`, `ff-ac-play-status` | `ff-ac-display`, `ff-ac-display-button`, `ff-ac-display-status` |

What reads differently: the default button label is "Display on Art
Computer", the dialog title "Display on your Art Computer", the messages that
told the visitor to press play now say try again, and an error's `name` is
`"DisplayError"`. `buttonLabel` and `dialog.copy` overrides work as before, and
error codes are unchanged. The IndexedDB database keeps the name `ff-play`. The
self-hosted bundle is `display.js`; only 0.5.x releases also attached it as
`play.js`.

## Upgrading from 0.5.x

0.6.0 pairs with every FF1 instead of failing older firmware with
`device_unsupported`. `EphemeralBrowserSession` is a union discriminated by
`kind` (`"displayGrant"` or `"relayerSession"`); code that reads `deviceId` or
`ctl` checks `kind === "displayGrant"` first. `relayerBaseUrl` is an option
again on `DisplayDp1PlaylistOptions` and the button (no default), and
`DisplayDp1PlaylistOptions` takes `fetchImpl` again for the relayer cast. A
stored 0.4 session is kept and used, no longer removed. The deprecated
`Play` aliases, the `ff-ac-play*` class names and the `play.js` release asset
are gone ([table above](#renamed-from-feralfileplay)). See
[CHANGELOG.md](CHANGELOG.md).

## Upgrading from 0.4.x

Move straight to 0.6: it keeps the visitor's stored 0.4 session, and an FF1 on
FF OS with display grants is paired again with a grant the first time the old
session stops reaching it. What changed against 0.4 is below (written for
0.5.0; 0.6.0 brings back the relayer session, `relayerBaseUrl`,
`fetchImpl` and `ephemeralBrowserSessionStorageKey` described above).

0.5.0 is a breaking release. The library casts only with
a device-issued display grant over relay v2; there is no relayer token, no
`/api/cast` and no `relayerBaseUrl`. `EphemeralBrowserSession` is now
`{ deviceId, ctl, expiresAt?, persistent }`, the grant lives in IndexedDB
(the `storage` option is a boolean; `false` makes pairing fail with
`storage_unavailable`), `hasStoredEphemeralBrowserSession(origin)` and
`readStoredEphemeralBrowserSession(origin)` are async and take only the
origin, as does `clearStoredEphemeralBrowserSession(origin)`;
`storeEphemeralBrowserSession`, `ephemeralBrowserSessionStorageKey`,
`TokenStorage` and `TokenStorageOptions` are gone (`storage` is a
`GrantStorageOptions` boolean). `DisplayDp1PlaylistOptions` loses `fetchImpl`
and `relayerBaseUrl` and gains `socketFactory` and `timeoutMs`. Stored 0.4 session records are removed
on first use, so each visitor pairs once more. 0.5 needs an FF1 on FF OS with
display grants; older firmware fails with `device_unsupported`.

## Commands

```sh
npm ci
npm run lint
npm run typecheck
npm test
npm run build
npm run bundle
```

`npm test` runs the FF1 control protocol v1 fixtures vendored under
`test/fixtures/ff1-control-v1` (see `SOURCE.md` there) against the codec, and
casts against a stub relay v2 channel with a stub FF1 that opens every
envelope with the fixture device keys.

## Boundaries

- Keep a grant's private keys non-extractable and only in origin-scoped IndexedDB, together with the grant and its request counter.
- Keep a relayer session's token only in origin-scoped `localStorage`; never return it from the public API or put it in a thrown error.
- Do not expose key material or the pairing token through logs, thrown errors, analytics, or public callbacks. The one exception is the channel's pairing token inside the app link, which `onPairingMaterial` hands over because the visitor has to open or scan it; it is single-use and dies with the channel.
- A grant seals only `displayPlaylist` in the Play shape (the FF1 control protocol's name for that command form) and its own `revokeController`; the FF1 refuses everything else with `permission_denied`.
- Connect to relay v2 per cast and close at once; never hold an idle socket.
- Keep API names requester-oriented rather than tied to a specific website.
