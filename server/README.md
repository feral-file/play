# Mint Pairing Broker

`server/` contains the Go HTTP service used as the Mint Pairing Broker between NFT display websites and token minters.

Its role is to hold short-lived mint receivers, QR/deep-link or short-code pairing material, and opaque end-to-end encrypted messages between the NFT display website and the Go ephemeral token minter embedded in FF1 `feral-controld`. The broker does not inspect mint requests, approval results, or token payloads. It is not `ff-relayer`, and it should not become a playlist relay. See [Sequential Flow](../docs/sequential-flow.md) for the full party model.

The target database and message-channel design is documented in [Server Design](../docs/server-design.md).

## Commands

```sh
test -z "$(gofmt -l .)"
go vet ./...
go test ./...
go build ./...
```

Run locally:

```sh
BROKER_DB_PATH=./mint-pairing.db ADDR=:8080 go run .
```

Configuration:

| Env | Default | Meaning |
| :-- | :-- | :-- |
| `ADDR` | `:8080` | Listen address. |
| `BROKER_DB_PATH` | `/data/mint-pairing.db` | bbolt database file. |
| `BROKER_BASE_URL` | request host | Public base URL written into pairing payloads. |
| `BROKER_TRUST_PROXY` | `false` | `true` takes the client address for per-source rate limits (browser channel creates, short-code resolves) and logs from the last `X-Forwarded-For` entry, which the reverse proxy appends; it falls back to the connection address when the header is absent or unparsable. Set it only when every request arrives through that proxy, otherwise clients can choose their own rate-limit bucket. |

Production (`handoff.feralfile.com`) runs behind Caddy, so every connection comes from Caddy's address; the deployment sets `BROKER_TRUST_PROXY=true`. Without it all sites would share one rate-limit bucket.

Build the container:

```sh
docker build -t mint-pairing-broker .
```

## Storage

The implementation uses `go.etcd.io/bbolt`. Server state transitions read from and write to durable bbolt buckets; do not add in-memory session, token, expiry, rate-limit, or payload maps.

Pairing receiver records live only for a short mint window. Expiry and close paths persist status/index changes in bbolt, and a bounded cleanup scan removes expired or closed channel buckets plus stale usable indexes from durable state. In Docker deployments, bbolt should use a single durable database file such as `/data/mint-pairing.db`, so mount `/data` as a persistent volume.

## Boundaries

- Do not log ephemeral browser session tokens.
- Do not store or relay DP1 playlist content.
- Treat submitted mint request and token response payloads as opaque encrypted content and enforce the 64 KiB encrypted payload limit.
- Keep this service focused on temporary mint pairing between NFT display websites and token minters.
- Do not add Redis, Postgres, WebSockets, SSE, or external queues without approval.
