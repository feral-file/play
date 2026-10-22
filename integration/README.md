# Generic carrier integration checks

Build the browser library first (`npm run build` and `npm run bundle` in
`clients/session-recipient/js`), then run `npm ci`, `npm run lint`,
`npm run typecheck`, `npm test`, and `npm run sample:build` here.

The local WebSocket integration verifies generic channel URL/subprotocol,
targeted opaque envelope delivery and correlation. Its endpoint seam is synthetic;
it does not validate registration or assert protected device readiness.

The [sample](sample/README.md) reports the blocked secure integration. The shared
ps-bound fixtures and browser grant/key-custody workflow are pending. No plaintext
cast or owner grant substitutes for them. Existing Go minter helper remains for
legacy production tests; no broker/minter behavior is changed.
