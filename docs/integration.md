# Integration Guide

This guide adds a **Play on Art Computer** action to your product: someone
selects works, presses play, and the works appear on their Feral File Art
Computer (FF1). It is for any product where people encounter art — a
marketplace, an artist's site, a gallery app, an agent. You embed a browser
library; everything else — pairing, approval, encryption, device delivery — is
handled by Feral File infrastructure.

The library targets the web runtime, so it drops into websites, web apps,
Electron, and web views inside native apps. A fully native client can
implement the same flow directly against the documented protocol
([API design](api-design.md), [sequential flow](sequential-flow.md)).

What the visitor experiences:

1. They press **Play on Art Computer** on your site.
2. First time only, a pairing dialog opens:
   - **On a phone or tablet**, it shows **Open the Feral File app**. They tap it, the app
     opens with the request, and they tap **Accept**. Below the button is a
     six-digit code they can type into the app instead; tapping the code
     copies it.
   - **On a desktop or laptop**, it shows a QR code. They scan it with the phone camera
     or the Feral File app, and tap **Accept** in the app. The same six-digit
     code sits under the QR for typing in the app instead.

   The dialog reads "Waiting for your Art Computer…" until the Art Computer
   joins, then "Approve in the Feral File app…". A code lasts five minutes;
   if it runs out, the dialog shows a fresh one, up to twice.
3. The playlist plays on their Art Computer. Subsequent plays from your site
   skip pairing entirely — the display grant is remembered per site origin
   until it expires or is removed.

The visitor never opens a settings page on the Art Computer or carries a code
from it to your site: your site shows the request, and the app that holds the
authority accepts it.

Your site never receives device API keys or account credentials. The FF1
issues the visitor's browser a **display grant**: a display-only controller
record of the FF1 control protocol, bound to keys the browser generates and
never exports, that can do one thing — play a playlist — and that the owner
can revoke in the app. It is short-lived by default, or kept until the owner
removes it when they choose that. The mint request and the returned grant
travel end-to-end encrypted between the visitor's browser and their FF1, and
every cast is a signed, encrypted envelope the FF1 verifies, so neither the
broker nor the relay in the middle sees playlist content or can forge a play. The broker does see what channel creation
sends in the clear: your site's origin, the browser metadata you supply in
`browserInfo`, and the pairing code it issues. Your origin is attested, not
claimed: the broker takes it from the `Origin` header your visitor's browser
sets, so the approval sheet in the app names the site that actually asked. The
full model is in [Sequential Flow](sequential-flow.md).

## What you need

- The requester library: [`@feralfile/play`](https://www.npmjs.com/package/@feralfile/play)
  (`npm i @feralfile/play`), source in this repo at
  [`clients/session-recipient/js`](../clients/session-recipient/js). For a
  site with no build step, download `play.js` from the
  [latest release](https://github.com/feral-file/play/releases/latest) — a
  self-contained ESM bundle — host it next to your pages, and
  `import { mountPlayOnArtComputerButton } from "./play.js"`. A CDN import
  (`https://esm.sh/@feralfile/play`) also works for quick experiments, but
  self-hosting keeps your integration free of infrastructure that neither of
  us operates.
- A [DP-1](https://github.com/display-protocol/dp1) playlist document for the
  works the visitor selected. DP-1 is an open spec; each playlist item points
  at a URL the FF1 can render (artwork pages, media files, generative works).
- Nothing server-side. No API key, no registration, no backend changes. The
  hosted Mint Pairing Broker at `https://handoff.feralfile.com` is the default
  and is open for integration use.

Your visitor needs an FF1 on FF OS with display grants, the Feral File mobile
app with their FF1 added, and a browser with IndexedDB (every evergreen
browser; a private window that blocks site data fails with
`storage_unavailable`).

## Quickest path: mount the button

```ts
import { mountPlayOnArtComputerButton } from "@feralfile/play";

mountPlayOnArtComputerButton({
  container: "#play-on-art-computer",
  playlist: () => buildDp1PlaylistFromSelection(),
  brokerBaseUrl: "https://handoff.feralfile.com"
});
```

This renders the button, and on click: checks origin-scoped IndexedDB for a
valid display grant; when there is none, creates a pairing channel and
shows the pairing dialog (app button on a phone, QR on a desktop, the
six-digit code on both); waits for the Art Computer to join and the owner to
approve in the app; then seals the playlist under the grant's keys and sends
it to the FF1 over relay v2.

`playlist` and `brokerBaseUrl` accept either a value or a (possibly async)
function, so you can build the DP-1 document at click time from the visitor's
current selection.

Useful options (see `PlayOnArtComputerButtonOptions` in
[`ui.ts`](../clients/session-recipient/js/src/ui.ts) for the full set):

- `buttonLabel`, `busyLabel`, `className`, `statusClassName` — restyle the
  button to match your site.
- `dialog.copy`, `dialog.classNames` — override the dialog's copy and styling
  while keeping the pairing sequence (`PairingDialogCopy` and
  `PairingDialogClassNames` in [`ui.ts`](../clients/session-recipient/js/src/ui.ts)).
  `dialog.layout` forces `"mobile"` or `"desktop"`; the default, `"auto"`,
  picks the app button on any touch device (a phone or tablet cannot scan a
  QR on its own screen) and the QR on pointer devices.
- `appLinkBaseUrl` — where the app link points. Defaults to
  `https://link.feralfile.com/pair`; the library appends
  `?channel=<id>&token=<pairingToken>`. That page opens the Feral File app
  when it is installed and offers the install otherwise. The link carries no
  broker URL: the Art Computer joins on the broker it is configured for.
- `onStatusChange`, `onSuccess`, `onError` — drive your own status UI.
- `pairAgainLabel` — the button label after `device_unrecognized` (default
  "Pair again?"); the next click clears the grant and pairs again.
- `socketFactory`, `castTimeoutMs` — a custom `WebSocket` opener and the
  per-cast relay deadline, passed through to `displayDp1Playlist`.
- `browserInfo` — `{ name, userAgent, label }` shown to the user in the
  mobile-app approval prompt. Set `label` to something the visitor will
  recognize, e.g. your site name.
- `requestedExpiresInSeconds` — grant lifetime your site asks for, a whole
  number of seconds from 1 to 31536000; a value outside that throws where you
  set it, stored grant or not. The Art Computer clamps every timed grant to
  86400 seconds (one day), so a longer request gets one day, and the approval
  sheet shows the clamped duration. Leave it unset to take the device default.
  The device owner decides: if they keep your site paired, the request is
  ignored and the grant has no expiry.

## Custom UI path

If the wrapped button does not fit, compose the pieces yourself:

```ts
import {
  requestEphemeralSessionWithPairingUi,
  displayDp1Playlist,
  hasStoredEphemeralBrowserSession,
  clearStoredEphemeralBrowserSession,
  unpairArtComputer
} from "@feralfile/play";

const session = await requestEphemeralSessionWithPairingUi({
  brokerBaseUrl: "https://handoff.feralfile.com",
  browserInfo: { label: "My Gallery" }
});

await displayDp1Playlist({ session, playlist });
```

- `requestEphemeralSessionWithPairingUi` reuses a stored grant when one
  exists, otherwise creates a channel, shows the pairing dialog, and waits for
  the Art Computer and the approval. It replaces an expired channel up to
  twice, then fails with `approval_timeout`. Pass `createDialog` to replace
  the dialog entirely: implement `PairingDialog`
  (`{ show(material), setStatus(text), close() }`), and call the
  `onCancel` you are handed when the visitor cancels. `show` is called again
  with fresh material when a channel is replaced.
- `requestEphemeralSession` is the headless core. It takes `brokerBaseUrl`
  and hands you the pairing material through
  `onPairingMaterial({ appLink, shortCode, expiresAt })`: open or encode
  `appLink`, show `shortCode`. `onPeerJoined` fires when the Art Computer has
  joined and approval has moved to the app. Pass an `AbortSignal` as `signal`
  to cancel (`pairing_canceled`). It throws `pairing_code_expired` when the
  channel expires before an Art Computer joins; set `channelRegenerations`
  (up to 5) to have it replace the channel instead, calling
  `onPairingMaterial` again each time.

  ```ts
  const session = await requestEphemeralSession({
    brokerBaseUrl: "https://handoff.feralfile.com",
    browserInfo: { label: "My Gallery" },
    onPairingMaterial: ({ appLink, shortCode }) => showMyPairingUi(appLink, shortCode),
    onPeerJoined: () => showMyStatus("Approve in the Feral File app…")
  });
  ```

  The app link carries the channel's single-use pairing token. It dies with
  the channel after five minutes idle, but until then it admits one Art
  Computer: show it to the visitor, do not log it or send it to analytics.
- `displayDp1Playlist` owns the control envelope (sealing, the relay v2
  round trip, reply verification against the FF1's pinned profile). Website
  code never constructs envelopes or relay frames directly. It opens one relay
  socket per cast and closes it right after.
- `unpairArtComputer()` sends a best-effort self-revoke to the FF1 with the
  stored keys, then deletes the grant. `clearStoredEphemeralBrowserSession(origin)`
  only deletes it (synchronously) and tells the FF1 nothing;
  `hasStoredEphemeralBrowserSession(origin)` is async.

## Display grants

- A pairing is `{ deviceId, ctl, expiresAt?, persistent }`: the FF1 that
  issued the grant, the grant's controller id, and its lifetime. There is no
  token. The grant's P-256 keys are generated non-extractable in the browser,
  never leave it, and are stored with the grant and its request counter as one
  IndexedDB record (database `ff-play`, store `displayGrants`, keyed by your
  site's origin). Every pairing generates fresh keys.
- IndexedDB is required: without it, or with `storage: false`, pairing fails
  with `storage_unavailable`.
- Approving in the app, the device owner can keep your site paired until they
  remove it (Settings → Art Computers → the FF1 → Paired sites). Such a grant
  comes back with `persistent: true` and no `expiresAt`: it does not expire,
  and any `requestedExpiresInSeconds` your site asked for is ignored. Grants
  the owner does not keep carry an `expiresAt` and expire as before.
- A grant can only play a playlist: the FF1 refuses any other command from it.
  Expiry and revocation are enforced by the FF1 itself; the owner can remove
  the site in the app at any time, and the site can `unpairArtComputer()`.
- On a cast the FF1 answers with a verified `access_revoked` or `expired`, or
  with the grant past its `expiresAt`, the library throws a `PlayError` with
  code `session_rejected` and deletes the grant; the wrapped button then
  re-pairs on the next click. Custom integrations should prompt to pair again.
- On a cast some channel peer answers with an unverified `unknown_controller`
  or `bad_envelope` and nothing verified arrives, the library throws
  `device_unrecognized` and **keeps** the grant: anyone on the public channel
  can send that body. The wrapped button offers "Pair again?" and clears the
  grant only on the visitor's next click. This is how a site recovers after
  the FF1 was factory reset or the site was removed on the device.
- Upgrading from 0.4: stored session records are ignored and removed on first
  use, so each visitor pairs once more, and the old session row stays under
  Paired sites until it expires or the owner removes it.

## Errors

Errors are `PlayError` instances carrying a stable `code`. Match on
`error.code` — messages are for humans and may change between versions;
codes will not. `pairingErrorMessage(error)` maps them to user-facing text.

| `error.code` | Meaning |
| :-- | :-- |
| `pairing_code_expired` | The channel expired before an Art Computer joined (headless `requestEphemeralSession` with no `channelRegenerations`). Press play again for a fresh code. |
| `mint_rejected` | The owner declined the approval in the mobile app, or the FF1 refused the request for another reason. |
| `approval_timeout` | Nobody approved: no answer within `maxWaitMs` (default 5 minutes) after the Art Computer joined, the FF1's own 5-minute approval deadline passed (`mint_rejected` reason `approval_expired`, mapped to this code), or every replacement channel expired before one joined. |
| `device_unsupported` | The FF1 cannot issue a display grant: its FF OS predates display grants, or it has no relay v2 endpoint configured. Tell the visitor to update the Art Computer. |
| `too_many_sites` | The FF1 holds as many paired sites as it allows (16). The owner removes one under Paired sites first. |
| `storage_unavailable` | IndexedDB is unavailable (or `storage: false`), so the grant and its keys cannot be kept. |
| `session_rejected` | The grant expired or was revoked (a verified FF1 reply) — the library deletes it and the wrapped button re-pairs on the next click; custom integrations prompt to pair again. |
| `device_unrecognized` | The FF1 answered that it does not know this grant, but unverified. The grant is kept; the wrapped button offers "Pair again?", custom integrations ask the visitor before clearing. |
| `pairing_canceled` | User closed the pairing dialog, or your `signal` aborted. |
| `display_rejected` | The FF1 verified the request and refused it (`permission_denied`, or the player failed). |
| `display_failed` | This page's pairing was replaced by another tab's (reload and play again), the FF1 is offline (no peer on its relay channel), the relay refused the connection (its per-address cap: more than 6 tabs casting at once from one network answer "Too many casts at once…"), no verified reply arrived before the deadline, the relay dropped the connection after the send, or the FF1 reported a replayed request. Nothing is resent automatically: press play again. |

## Network endpoints

The visitor's browser talks to two hosts. If your site sets a
`Content-Security-Policy`, allow them in `connect-src`:

- the Mint Pairing Broker (`https://handoff.feralfile.com`) — channel
  creation, encrypted message send/poll, channel close
- the relay v2 host — the cast, as a WebSocket
  (`wss://<relay host>/v2/channels/<deviceId>/connections`), so allow it with
  the `wss:` scheme. The FF1 names the host in the grant it issues
  (`relayV2Endpoint`), and the library uses only that; you have to write the
  policy before any grant exists, so allow the relay v2 host Feral File
  announces in the release notes for `@feralfile/play`. The 0.4 relayer host
  (`tv-cast-coordination.autonomy-system.workers.dev`) is no longer used.

`https://link.feralfile.com` needs no entry. The app link is a navigation (the
visitor taps it, or scans its QR with another device), never a `fetch`, and the
QR is drawn in the page from the bundled library, with no image request.

Playlist content is readable by neither host: the browser sends the DP-1
document to the FF1 inside the encrypted envelope the relay forwards, and
artwork media is fetched directly by the FF1 from the URLs inside the
playlist.

## Try it against the sample

The [integration sample](../integration/sample) is this exact flow as a
minimal page — paste a DP-1 payload, press play. From the repo root:

```sh
cd integration && npm ci && npm run sample:dev
```

Pairing against real hardware requires an FF1 and the mobile app; the sample
uses the hosted broker by default, so no local server is needed.

## Status

This guide documents `@feralfile/play` 0.5.0, which casts only with a
device-issued display grant over relay v2. It is a breaking 0.x release:

- `EphemeralBrowserSession` is `{ deviceId, ctl, expiresAt?, persistent }`;
  `token`, `sessionId` and `relayerBaseUrl` are gone, as is the
  `relayerBaseUrl` option everywhere.
- `storage` is a boolean (`GrantStorageOptions`); the grant lives in IndexedDB,
  not `localStorage`, and there is no custom storage adapter:
  `TokenStorage`, `TokenStorageOptions`, `ephemeralBrowserSessionStorageKey`
  and `storeEphemeralBrowserSession` are gone.
  `hasStoredEphemeralBrowserSession(origin)` and
  `readStoredEphemeralBrowserSession(origin)` are async and take only the
  origin, as does `clearStoredEphemeralBrowserSession(origin)`;
  `unpairArtComputer()` is new.
- `DisplayDp1PlaylistOptions` loses `fetchImpl` (there is no HTTP cast) and
  gains `socketFactory` (a custom `WebSocket` opener) and `timeoutMs`.
- New error codes: `device_unsupported`, `device_unrecognized`,
  `storage_unavailable`, `too_many_sites`.
- Stored 0.4 session records are removed on first use; every visitor pairs
  once more after a site upgrades.

Which library works with which Art Computer:

| Art Computer | `@feralfile/play` | Result |
| :-- | :-- | :-- |
| FF OS without display grants | 0.4 | browser session, as before |
| FF OS without display grants | 0.5 | `device_unsupported` (the device mints a session, which 0.5 discards; the row stays under Paired sites until it expires or is removed) |
| FF OS with display grants | 0.4 | browser session, unchanged, until the legacy controller API is retired |
| FF OS with display grants | 0.5 | display grant, cast over relay v2 |
| FF OS with display grants, not yet secured (no owner), legacy controller API retired | 0.5 | existing grants keep casting; a new pairing ends in `approval_timeout` (the request is sent, but no app receives it; whichever of the library's `maxWaitMs` and the FF1's approval deadline passes first) until the owner secures the FF1 in the app |
| any, legacy controller API retired | 0.4 | broken: upgrade to 0.5 first |

Upgrade to 0.5 once Feral File announces that FF OS with display grants is
broadly deployed; before that, visitors on older Art Computers get
`device_unsupported`. One honest caveat while this is pre-1.0: expect API
change between 0.x versions. A display grant authorizes the display/cast path
only — that is by design, and the scope will stay narrow.

Tell us what is unclear, impractical, or missing — open an issue on this repo.
Integration questions and API-shape feedback are exactly what this stage is
for.
