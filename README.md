# Play on Art Computer

This repository contains everything behind the **Play on Art Computer** action:
a visitor selects works on a website, presses play, and the works appear on
their Feral File Art Computer (FF1).

**Integrating a website?** Start with the
[Integration Guide](docs/integration.md).

Three components make the flow work. A website embeds the
[`@feralfile/play`](clients/session-recipient/js) browser library. On a play
with no stored session, the library creates a pairing channel on the **Mint
Pairing Broker** in [server/](server), a short-lived opaque transport for
end-to-end encrypted mint request/response messages, and shows the visitor an
app link (a button on a phone, a QR on a desktop) and a six-digit code. The
Feral File mobile app brings the visitor's FF1 to that channel. On the device,
`feral-controld` embeds the [Go ephemeral token minter](clients/ephemeral-token-minter/go),
which joins the channel and carries the site's encrypted request and the
result; `feral-controld` asks the owner for approval in the Feral File mobile
app via `ff-relayer` and mints a revokable browser session scoped to the
display path. The full flow is documented in
[docs/sequential-flow.md](docs/sequential-flow.md).

The hosted broker at `https://handoff.feralfile.com`, the mobile-app approval,
and the FF1 display path work end to end today. `@feralfile/play` 0.4.0 starts
pairing from the site; 0.3.x paired from the device, and the broker keeps
serving that path for sites that have not upgraded. The
integration surface is pre-1.0: expect additive change, and open issues freely
— integration feedback is exactly what this stage is for.

## Components

- [clients/session-recipient/js](clients/session-recipient/js/README.md): the `@feralfile/play` browser library websites embed.
- [server](server/README.md): Go Mint Pairing Broker backed by durable bbolt storage.
- [clients/ephemeral-token-minter/go](clients/ephemeral-token-minter/go/README.md): Go library used by FF1 `feral-controld` to communicate with the broker, handle E2EE mint request/result payloads, and return encrypted mint results.
- [integration](integration/README.md): integration tests and the sample website.
- `.github/workflows/ci.yml`: CI for the broker, browser library, token minter, and integration tests.
- `.github/workflows/publish-npm.yml`: publishes `@feralfile/play` on GitHub release.
- `Dockerfile`: production image for the Mint Pairing Broker.

Go module paths still use the pre-rename repository path
(`github.com/feral-file/ff-art-computer-handoff/...`); GitHub redirects keep
them resolving, and the module paths will move in a later coordinated change
with `ffos-user`.

## Design Docs

- [Integration guide](docs/integration.md)
- [Sequential flow](docs/sequential-flow.md)
- [Server design](docs/server-design.md)
- [API design](docs/api-design.md)

## Commands

```sh
cd server && test -z "$(gofmt -l .)" && go vet ./... && go test ./... && go build ./...
cd clients/session-recipient/js && npm ci && npm run build && npm run lint && npm run typecheck && npm test
cd clients/ephemeral-token-minter/go && test -z "$(gofmt -l .)" && go vet ./... && go test ./...
cd integration && npm ci && npm run sample:build && npm run lint && npm run typecheck && npm test
```

## Deployment

The Docker image runs the Mint Pairing Broker. It listens on `ADDR`, defaults to `:8080`, and stores bbolt state at `BROKER_DB_PATH`, expected to be a file path such as `/data/mint-pairing.db`. Mount `/data` as durable storage in persistent environments.

```sh
docker build -t ff-mint-pairing-broker:local .
docker run --rm -p 8080:8080 -v ff-mint-pairing-broker-data:/data ff-mint-pairing-broker:local
```

The manual GitHub Actions workflow `.github/workflows/build-image.yml` publishes to DigitalOcean Container Registry under `registry.digitalocean.com/feral-file/apps`. It requires the `DIGITALOCEAN_DOCR_TOKEN` secret in the production environment.

## License

This repository's source code is licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

The license does not grant rights to Feral File trademarks, service marks, product names, artwork, production credentials, hosted services, or DP1 playlist content.
