# FF1 DP1 Mint Pairing Sample

This sample should act as an NFT display website that integrates the browser token requester library with the Mint Pairing Broker.

## Run

```sh
cd clients/session-recipient/js && npm ci && npm run build && cd ../../../integration
npm ci
npm run sample:dev
```

Open the printed local URL, paste a DP1 JSON payload, and press **Play on Art Computer**. The broker defaults to `https://handoff.feralfile.com` and the app link to `https://link.feralfile.com/pair`.

If this website origin has no stored browser session, the button creates a pairing channel on the broker and opens the pairing dialog:

- On a phone, the dialog shows **Open the Feral File app**, a link to `https://link.feralfile.com/pair?channel=<id>&token=<pairingToken>`, and below it the six-digit code, which copies on tap.
- On a desktop, it shows a QR code of the same link, rendered in the page, with the caption "Scan with your phone camera or the Feral File app", and the six-digit code.

The Feral File app brings the visitor's Art Computer to the channel: the app link opens it, or the visitor types the code on the Art Computer's settings page. The dialog then asks the visitor to approve in the app. If the channel expires before an Art Computer joins, the dialog shows a fresh code and QR, up to twice.

Once the Art Computer joins, the page sends requester metadata to the Go token minter in `feral-controld` over E2EE, waits for an encrypted token result after approval in the app, stores that recovered session in `localStorage`, and then asks the requester library to display the DP1 payload through `ff-relayer`.

If a stored session already exists, the page skips pairing and sends the DP1 payload directly.

## Delivered Session Payload

The decrypted broker result is expected to be a `mint_succeeded` payload containing `session.token`, `session.sessionId`, an expiry, and optional `session.relayerBaseUrl`.

The expiry comes in two variants. A timed session carries `session.expiresAt` as an RFC3339 timestamp and stops working when it passes. A session the device owner chose to keep carries `session.persistent: true` with `session.expiresAt` null or absent: it does not expire, the lifetime the page asked for through `requestedExpiresInSeconds` is ignored, and it stays usable until the owner removes it in the mobile app or it is revoked. Either way the sample stores what it received and re-pairs when a display attempt comes back rejected.

The wrapped requester button calls `displayDp1Playlist({ session, playlist })`; the requester library owns the `POST /api/cast` command envelope and FF1 response validation.
