# Integration Tests

`integration/` contains Vitest tests for cross-component behavior.

Integration coverage exercises the site-initiated mint pairing flow described in [Sequential Flow](../docs/sequential-flow.md): the NFT display website's requester library creates a channel on the Mint Pairing Broker, the Go ephemeral token minter embedded in FF1 `feral-controld` joins it (by the app link's channel and pairing token, or by the six-digit code), and the E2EE mint request and result travel through the broker as a short-lived opaque transport. `ff-controller` approval through `ff-relayer` and the FF1 display path sit outside these tests.

## Commands

```sh
# The file: dependency on @feralfile/play resolves to its dist/ output,
# so build the library first.
(cd ../clients/session-recipient/js && npm ci && npm run build)
npm ci
npm run lint
npm run typecheck
npm test
```

`npm test` builds the Go broker Docker image, launches it with an isolated
temporary `/data` volume, and verifies the mint pairing sequence over HTTP. The
tests run under Node, whose `fetch` sends no `Origin` header, so they add the
header a browser would send; the broker attests it for browser-created
channels.

## Expectations

- Tests use isolated temporary storage.
- Tests must not hardcode production credentials.
- Tests should verify that DP1 playlist content does not travel through `ff-controller`.
- Tests should verify token expiry, revocation, and unauthorized paths when those behaviors are implemented locally.
