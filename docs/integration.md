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
   - **On a phone**, it shows **Open the Feral File app**. They tap it, the app
     opens with the request, and they tap **Accept**. Below the button is a
     six-digit code they can type into the app instead; tapping the code
     copies it.
   - **On a desktop**, it shows a QR code. They scan it with the phone camera
     or the Feral File app, and tap **Accept** in the app. The same six-digit
     code sits under the QR for typing in the app instead.

   The dialog reads "Waiting for your Art Computer…" until the Art Computer
   joins, then "Approve in the Feral File app…". A code lasts five minutes;
   if it runs out, the dialog shows a fresh one, up to twice.
3. The playlist plays on their Art Computer. Subsequent plays from your site
   skip pairing entirely — the browser session is remembered per site origin
   until it expires or is removed.

The visitor never opens a settings page on the Art Computer or carries a code
from it to your site: your site shows the request, and the app that holds the
authority accepts it.

Your site never receives device API keys or account credentials. It receives a
revokable browser session token scoped to the display path only — short-lived
by default, or kept until the owner removes it when they choose that.
The mint request and the returned session travel end-to-end encrypted between
the visitor's browser and their FF1, so the broker in the middle never sees
session tokens or playlist content. The broker does see what channel creation
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

Your visitor needs an FF1 and the Feral File mobile app with their FF1 added.

## Quickest path: mount the button

```ts
import { mountPlayOnArtComputerButton } from "@feralfile/play";

mountPlayOnArtComputerButton({
  container: "#play-on-art-computer",
  playlist: () => buildDp1PlaylistFromSelection(),
  brokerBaseUrl: "https://handoff.feralfile.com",
  // Fallback when the session carries no relayer URL; the host from Network endpoints.
  relayerBaseUrl: "https://tv-cast-coordination.autonomy-system.workers.dev"
});
```

This renders the button, and on click: checks origin-scoped `localStorage` for
a valid browser session; when there is none, creates a pairing channel and
shows the pairing dialog (app button on a phone, QR on a desktop, the
six-digit code on both); waits for the Art Computer to join and the owner to
approve in the app; then sends the playlist to the FF1.

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
  picks the app button on a touch device with a phone-sized viewport and the
  QR everywhere else.
- `appLinkBaseUrl` — where the app link points. Defaults to
  `https://link.feralfile.com/pair`; the library appends
  `?channel=<id>&token=<pairingToken>`. That page opens the Feral File app
  when it is installed and offers the install otherwise. The link carries no
  broker URL: the Art Computer joins on the broker it is configured for.
- `onStatusChange`, `onSuccess`, `onError` — drive your own status UI.
- `browserInfo` — `{ name, userAgent, label }` shown to the user in the
  mobile-app approval prompt. Set `label` to something the visitor will
  recognize, e.g. your site name.
- `relayerBaseUrl` — fallback relayer for a session that carries no URL of its
  own; `session.relayerBaseUrl` wins when present, and without the fallback
  such a session fails with `relayer base URL is required`. Set it to the host
  in [Network endpoints](#network-endpoints).
- `requestedExpiresInSeconds` — session lifetime your site asks for, a whole
  number of seconds from 1 to 31536000 (one year); a value outside that throws
  where you set it, stored session or not. Leave it unset to take the device
  default. The device owner decides: if they keep your site paired, the request
  is ignored.

## Custom UI path

If the wrapped button does not fit, compose the pieces yourself:

```ts
import {
  requestEphemeralSessionWithPairingUi,
  displayDp1Playlist,
  hasStoredEphemeralBrowserSession,
  clearStoredEphemeralBrowserSession
} from "@feralfile/play";

const session = await requestEphemeralSessionWithPairingUi({
  brokerBaseUrl: "https://handoff.feralfile.com",
  browserInfo: { label: "My Gallery" }
});

await displayDp1Playlist({
  session,
  playlist,
  // Fallback when the session carries no relayer URL; the host from Network endpoints.
  relayerBaseUrl: "https://tv-cast-coordination.autonomy-system.workers.dev"
});
```

- `requestEphemeralSessionWithPairingUi` reuses a stored session when one
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
- `displayDp1Playlist` owns the relayer request envelope and response
  validation. Website code never constructs relayer commands directly.

## Sessions

- A session is `{ token, sessionId, expiresAt?, persistent?, relayerBaseUrl? }`.
  The token is a bearer credential: do not log it, report it to analytics, or
  expose it in thrown errors.
- Stored in `localStorage` under `ff:ephemeral-browser-session:<origin>`,
  scoped to your site's origin. Pass `storage: false` to manage persistence
  yourself.
- Approving in the app, the device owner can keep your site paired until they
  remove it (Settings → Art Computers → the FF1 → Paired sites). Such a session
  comes back with `persistent: true` and no `expiresAt`: it does not expire,
  and any `requestedExpiresInSeconds` your site asked for is ignored. Sessions
  the owner does not keep carry an `expiresAt` and expire as before.
- Keeping a site paired takes effect only for sites on `@feralfile/play` 0.3.0
  or newer. Each request declares the capability, and the device sends the
  no-expiry shape only to a site that declared it; a site on an older version
  gets a timed session even when the owner chose to keep it. Upgrading the
  library is the whole fix — nothing changes on the device.
- Expiry and revocation are enforced by `ff-relayer`. The user can revoke a
  browser session from the Feral File side at any time.
- On a display attempt with a dead session the library throws a `PlayError`
  with code `session_rejected`; the wrapped button clears the stored session
  automatically so the next click re-pairs. Custom integrations should call
  `clearStoredEphemeralBrowserSession` on that code and prompt to pair again.

## Errors

Errors are `PlayError` instances carrying a stable `code`. Match on
`error.code` — messages are for humans and may change between versions;
codes will not. `pairingErrorMessage(error)` maps them to user-facing text.

| `error.code` | Meaning |
| :-- | :-- |
| `pairing_code_expired` | The channel expired before an Art Computer joined (headless `requestEphemeralSession` with no `channelRegenerations`). Press play again for a fresh code. |
| `mint_rejected` | User declined the approval in the mobile app. |
| `approval_timeout` | No approval within `maxWaitMs` (default 5 minutes) after the Art Computer joined, or every replacement channel expired before one joined. |
| `session_rejected` | Stored session expired or revoked — the wrapped button clears it; custom integrations clear and re-pair. |
| `pairing_canceled` | User closed the pairing dialog, or your `signal` aborted. |
| `display_failed` / `display_rejected` | The relayer or FF1 refused the display request. |

## Network endpoints

The visitor's browser talks to two hosts. If your site sets a
`Content-Security-Policy`, allow them in `connect-src`:

- the Mint Pairing Broker (`https://handoff.feralfile.com`) — channel
  creation, encrypted message send/poll, channel close
- `ff-relayer` — the display request. Allow
  `https://tv-cast-coordination.autonomy-system.workers.dev`, the relayer Feral
  File operates today; you have to write the policy before any session exists.
  The approved session then carries the base URL actually used
  (`session.relayerBaseUrl`) — read it from there at runtime rather than
  hard-coding a host in your display code. If the host changes, the change is
  announced in the release notes for `@feralfile/play`.

`https://link.feralfile.com` needs no entry. The app link is a navigation (the
visitor taps it, or scans its QR with another device), never a `fetch`, and the
QR is drawn in the page from the bundled library, with no image request.

Playlist content does not travel through either host: the browser sends the
DP-1 document to the relayer as part of the display command, and artwork media
is fetched directly by the FF1 from the URLs inside the playlist.

## Try it against the sample

The [integration sample](../integration/sample) is this exact flow as a
minimal page — paste a DP-1 payload, press play. From the repo root:

```sh
cd integration && npm ci && npm run sample:dev
```

Pairing against real hardware requires an FF1 and the mobile app; the sample
uses the hosted broker by default, so no local server is needed.

## Status

This guide documents `@feralfile/play` 0.4.0, where the site starts pairing.
Libraries up to 0.3.x paired the other way — the Art Computer showed a code
and the visitor typed it into the site — and the hosted broker still serves
that path for sites that have not upgraded. Upgrading from 0.3.x: drop the
`pairing` input from `requestEphemeralSession` and pass `brokerBaseUrl` plus
`onPairingMaterial`; rename `createPairingCodeDialog` to `createPairingDialog`;
stop matching `pairing_code_not_found` and `pairing_code_used`, which a site
can no longer hit. The wrapped button needs no change.

Site-initiated pairing needs the Art Computer software and Feral File app
releases that can join a site's channel; until those are out, 0.3.x is the
version that pairs. The hosted broker, the mobile-app approval flow, and the
FF1 display path are the same for both. One honest
caveat while this is pre-1.0: expect additive API change between 0.x versions.
Sessions authorize the display/cast path only — that is by design, and the
scope will stay narrow.

Tell us what is unclear, impractical, or missing — open an issue on this repo.
Integration questions and API-shape feedback are exactly what this stage is
for.
