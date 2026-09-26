# AGENTS.md

## Component

`clients/session-recipient/js/` is the TypeScript token requester implementation for browser runtimes. It creates a pairing channel on the Mint Pairing Broker, shows the visitor the app link and six-digit code that bring their Art Computer to it, and requests an ephemeral browser session from the Go token minter embedded in FF1 `feral-controld` once that minter joins.

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

- Treat ephemeral browser session tokens as bearer credentials.
- Store token state under the current website origin when browser storage is used.
- Do not add website-specific concepts to the public API.
- Do not route DP1 playlist content through `ff-controller`, the token minter, or the Mint Pairing Broker.
- The site's origin comes from `window.location.origin` and is attested by the browser's `Origin` header at channel creation; never accept a caller-supplied origin.
- The pairing token travels only inside the app link handed to the visitor; never log it or put it in thrown errors.
- Render the pairing QR locally from the bundled `qrcode-generator`; no network fetch for pairing images.
- Keep TypeScript strict mode, `noUncheckedIndexedAccess`, and type-aware ESLint rules enabled.
