# AGENTS.md

## Component

`clients/session-recipient/js/` is the TypeScript token requester implementation for browser runtimes. It creates a pairing channel on the Mint Pairing Broker, shows the visitor the app link and six-digit code that bring their Art Computer to it, requests a display grant (FF1 control protocol v1 §5.7) from the Go token minter embedded in FF1 `feral-controld` once that minter joins, and casts to the FF1 over relay v2 with the grant's keys.

## Commands

```sh
npm ci
npm run lint
npm run typecheck
npm test
npm run build
npm run bundle
```

## Rules

- A display grant's private keys are non-extractable WebCrypto keys that live only in IndexedDB under the current website origin, as one record with the grant and its request counter. Never export, log or serialize them.
- Do not add website-specific concepts to the public API.
- Do not route DP1 playlist content through `ff-controller`, the token minter, or the Mint Pairing Broker.
- The site's origin comes from `window.location.origin` and is attested by the browser's `Origin` header at channel creation; never accept a caller-supplied origin.
- The pairing token travels only inside the app link handed to the visitor; never log it or put it in thrown errors.
- Render the pairing QR locally from the bundled `qrcode-generator`; no network fetch for pairing images.
- `src/control/` is a port of the maintained ff-cli client (`src/utilities/relay-client.ts`, `src/utilities/control/{codec,jwk,strict-json}.ts`) onto WebCrypto and `btoa`/`atob`. Keep its closed-header and strict-JSON checks exactly; a check must never be relaxed into a `jose` option. When ff-cli changes, port the change rather than diverging.
- `test/fixtures/ff1-control-v1` is vendored verbatim from ffos-user; do not edit it by hand. Re-vendor the directory and update `SOURCE.md` when ffos-user regenerates the fixtures (display-grant vectors arrive that way).
- Connect to relay v2 per cast and close the socket right after; never hold an idle connection.
- A public `unknown_controller`/`bad_envelope` from the channel is unverified: surface `device_unrecognized` and keep the grant; only the visitor's action clears it.
- Keep TypeScript strict mode, `noUncheckedIndexedAccess`, and type-aware ESLint rules enabled.
