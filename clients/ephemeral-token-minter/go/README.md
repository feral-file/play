# Go Ephemeral Token Minter

This package is the FF1 `feral-controld` side of browser session mint pairing. It joins Mint Pairing Broker channels that sites create, decrypts browser mint requests, and sends encrypted success or rejection responses back to the requester.

## Site-initiated pairing

The site creates the channel and the Feral File app brings the device to it. `feral-controld` receives `joinMintPairingChannel` with `{channelId, pairingToken}` or `{shortCode}` and calls:

```go
channel, err := client.JoinChannel(ctx, minter.JoinChannelOptions{
    BrokerBaseURL: configuredBroker, // never taken from the app
    ChannelID:     channelID,        // with PairingToken
    PairingToken:  pairingToken,     // or ShortCode, resolved first
})
requester := channel.Requester()     // origin and browser info attested by the broker
```

The joined channel's `PollMintRequest`, `SendMintSuccess`, `SendMintRejection` and `Close` work as for a created channel; `PairingDisplay` is empty. `PollMintRequest` returns `ErrOriginMismatch` when the decrypted request names another origin than the attested one, and `ErrBrowserKeyMismatch` when it was encrypted with another browser key than the one returned at join. Broker failures are `*BrokerError` with the HTTP status and the broker's error code (`not_found`, `expired`, `unauthorized`, `rate_limited`, ...).

## Legacy device-initiated pairing

`StartChannel` creates a channel and returns display material for the FF1 frontend; the site joins it. The broker still serves this path for requester library versions before 0.4.0.

The package deliberately does not implement or abstract `ff-controller` approval behavior or `ff-relayer` session creation. `feral-controld` owns those integrations and passes only the final success or rejection payload back into this broker/E2EE library.

## Protocol Notes

- Crypto: `P256-HKDF-SHA256-AES-256-GCM`.
- Public keys use JSON/JWK-compatible P-256 coordinates.
- Encrypted envelopes include channel-binding AAD.
- Browser-to-minter envelopes must carry the browser public JWK as public envelope metadata so the minter can derive the ECDH shared secret without exposing plaintext to the broker.
- Session tokens must not be logged and are sent to the browser only inside encrypted `mint_succeeded` payloads.
- `SendMintSuccess` and `SendMintRejection` send terminal encrypted results but deliberately do not close the broker channel immediately, because the browser must still poll the accepted message. Host code should call `Close` after result delivery, timeout, cancellation, or local cleanup policy permits channel removal.

## Test

```sh
test -z "$(gofmt -l .)"
go vet ./...
go test ./...
```
