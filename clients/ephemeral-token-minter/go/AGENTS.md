# AGENTS.md

## Component

`clients/ephemeral-token-minter/go/` is the Go ephemeral token minter library embedded by FF1 `feral-controld`.

It joins channels that NFT display websites create on the Mint Pairing Broker (`JoinChannel`, by pairing token or short code), exposes the origin and browser info the broker attested, decrypts browser mint requests, checks that a joined channel's mint request matches the attested origin and browser key, and sends encrypted success or rejection results back through the broker. For the legacy device-initiated flow it still creates channels (`StartChannel`) and exposes QR/deep-link and short-code pairing material for the FF1 frontend.

## Commands

```sh
test -z "$(gofmt -l .)"
go vet ./...
go test ./...
```

## Rules

- Keep Go code idiomatic, formatted with `gofmt`, and covered by `go test ./...`.
- Use P-256 ECDH, HKDF-SHA256, and AES-256-GCM through maintained standard-library crypto packages.
- Do not implement or abstract `ff-controller` approval UI or `ff-relayer` session business logic here; this package should only communicate with the Mint Pairing Broker and handle E2EE payloads.
- Do not log ephemeral browser session tokens, DP1 playlist content, or decrypted mint payloads.
- Send raw browser session tokens only inside the end-to-end encrypted broker response.
- Treat broker messages as opaque transport envelopes; broker-visible errors and HTTP errors must not include token material.
