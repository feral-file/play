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

- On a phone or tablet, the dialog shows **Open the Feral File app**, a link to `https://link.feralfile.com/pair?channel=<id>&token=<pairingToken>`, and below it the six-digit code, which copies on tap.
- On a desktop or laptop, it shows a QR code of the same link, rendered in the page, with the caption "Scan with your phone camera or the Feral File app", and the six-digit code.

The Feral File app brings the visitor's Art Computer to the channel: the app link opens it, or the visitor types the code on the Art Computer's settings page. The dialog then asks the visitor to approve in the app. If the channel expires before an Art Computer joins, the dialog shows a fresh code and QR, up to twice.

Once the Art Computer joins, the page sends requester metadata and its fresh display-grant public keys to the Go token minter in `feral-controld` over E2EE, waits for the encrypted display grant after approval in the app, stores the grant with its keys in IndexedDB, and then asks the requester library to display the DP1 payload over relay v2.

If a stored grant already exists, the page skips pairing and sends the DP1 payload directly. **Forget** calls `unpairArtComputer()`: a best-effort self-revoke on the Art Computer, then the grant is deleted.

## Delivered Grant Payload

The decrypted broker result is expected to be a `mint_succeeded` payload containing a top-level `displayGrant` with `ctl`, the FF1's `profile`, `relayV2Endpoint` and an optional expiry. An Art Computer on FF OS without display grants answers with a `session` instead, which the library discards with `device_unsupported`.

The expiry comes in two variants. A timed grant carries `expiresAt` as an RFC3339 timestamp and stops working when it passes. A grant the device owner chose to keep has no `expiresAt`: it does not expire, the lifetime the page asked for through `requestedExpiresInSeconds` is ignored, and it stays usable until the owner removes it in the mobile app or the site unpairs. Either way the sample stores what it received and re-pairs when a cast comes back `session_rejected`; on `device_unrecognized` the button reads "Pair again?" and re-pairs on the next click.

The wrapped requester button calls `displayDp1Playlist({ session, playlist })`; the requester library owns the control envelope, the relay v2 round trip and reply verification.
