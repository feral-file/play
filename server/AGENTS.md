# AGENTS.md

## Component

`server/` is the Mint Pairing Broker. It bridges NFT display websites and ephemeral token minters for short-lived, end-to-end encrypted mint request/response exchange.

Either role may create a channel; the other joins it. In the primary, site-initiated flow the browser creates the channel (`creatorRole: "browser"`) and the minter joins; the broker attests the site origin from the HTTP `Origin` header. The legacy device-initiated flow (minter creates, browser joins, `creatorRole` absent or `"minter"`) must stay wire-compatible for requester library versions before 0.4.0.

## Commands

```sh
test -z "$(gofmt -l .)"
go vet ./...
go test ./...
go build ./...
```

## Rules

- bbolt is the target source of truth for server state.
- Do not add in-memory maps for sessions, payloads, token state, expiry state, or test shortcuts.
- Do not log bearer tokens, pairing tokens, public keys, `browserInfo`, raw session tokens, or playlist content. Log an attested origin as its host only.
- Do not turn this service into a DP1 playlist proxy.
- Keep Go code idiomatic, formatted with `gofmt`, and covered by `go test ./...`.
