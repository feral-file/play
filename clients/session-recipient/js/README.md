# @feralfile/play

`clients/session-recipient/js/` is `@feralfile/play`, the browser library websites embed to pair a visitor's browser with their Art Computer and play a DP-1 playlist on it. Internally it is the mint-pairing requester: the browser client that asks the Go token minter embedded in FF1 `feral-controld` for a **display grant**, a display-only controller record of the FF1 control protocol (ffos-user `docs/ff1-control-v1.md` §5.7), and then casts to the FF1 over relay v2 with the keys that grant was issued to.

```sh
npm i @feralfile/play
```

The published package ships compiled ESM + type declarations from `dist/` (`npm run build`). Source stays TypeScript-first in `src/`.

Browser runtimes check IndexedDB (database `ff-play`, store `displayGrants`, keyed by the current website origin) for an existing display grant. If one is missing or expired, `requestEphemeralSession` generates fresh non-extractable P-256 keys, creates a Mint Pairing Broker channel as the browser (`creatorRole: "browser"`, with the origin from `window.location.origin`, which the broker checks against the `Origin` header the browser sets), hands the visitor the app link `https://link.feralfile.com/pair?channel=<id>&token=<pairingToken>` and a six-digit code through `onPairingMaterial`, and polls until the visitor's Art Computer joins the channel. It then sends an end-to-end encrypted `mint_request` carrying the public keys to the joined device's key, polls for the encrypted result, validates the channel binding, stores the grant with its keys and request counter as one IndexedDB record, and returns the pairing metadata. `displayDp1Playlist` seals a `displayPlaylist` command under those keys and sends it over relay v2 (`wss://<relayV2Endpoint>/v2/channels/<deviceId>/connections`), opening a socket per cast and closing it right after, without exposing the envelope to website code. See [Sequential Flow](../../../docs/sequential-flow.md) for the end-to-end model.

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

await displayDp1Playlist({ session, playlist: dp1Playlist });
```

## Wrapped Pairing UI

For a standard integration, mount the provided **Play on Art Computer** button.
It checks the origin's grant store first, opens the pairing dialog only when
there is no valid grant, waits for the Art Computer to join and the owner to
approve in the app, and then sends the DP1 playlist to the FF1 over relay v2.

```ts
import { mountPlayOnArtComputerButton } from "@feralfile/play";

mountPlayOnArtComputerButton({
  container: "#play-on-art-computer",
  playlist: dp1Playlist,
  brokerBaseUrl: "https://handoff.feralfile.com",
  // Optional; this is the default.
  appLinkBaseUrl: "https://link.feralfile.com/pair"
});
```

The relay endpoint arrives inside the grant (`relayV2Endpoint`) and is the only
one used, so never hard-code a host in display code. A
`Content-Security-Policy` still has to be written before any grant exists, so
`connect-src` needs the relay v2 host up front: the
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

When the FF1 answers a cast with an unverified `unknown_controller` or
`bad_envelope` (a factory reset, or the site was removed on the device), the
button fails with `device_unrecognized`, keeps the stored grant, and reads
"Pair again?"; only the visitor's next click clears it and pairs again.

For custom UI, use `createPairingDialog`,
`requestEphemeralSessionWithPairingUi`, `hasStoredEphemeralBrowserSession`,
`clearStoredEphemeralBrowserSession` and `unpairArtComputer`. The dialog accepts copy, class-name, and
layout overrides so a website can keep its own styling while preserving the
pairing sequence and approval handoff; `createDialog` replaces it with any
implementation of `PairingDialog` (`{ show, setStatus, close }`).

Upgrading from 0.4.x: 0.5.0 is a breaking release. The library casts only with
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
- Do not expose key material or the pairing token through logs, thrown errors, analytics, or public callbacks. The one exception is the channel's pairing token inside the app link, which `onPairingMaterial` hands over because the visitor has to open or scan it; it is single-use and dies with the channel.
- A grant seals only `displayPlaylist` in the Play shape and its own `revokeController`; the FF1 refuses everything else with `permission_denied`.
- Connect to relay v2 per cast and close at once; never hold an idle socket.
- Keep API names requester-oriented rather than tied to a specific website.
