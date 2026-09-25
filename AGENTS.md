# AGENTS.md

## Project Purpose

This repository is a minimal secure prototype for ephemeral browser session mint pairing.

The target parties are an NFT display website embedding the token requester browser library, FF1 `feral-controld` using a Go ephemeral token minter library, `ff-controller` (the Feral File app) as the surface that brings the device to the site's channel and approves the request, `ff-relayer`, and the FF1 display path. Pairing is site-initiated: the requester library creates the channel on the server in `server/` and shows an app link and short code; the app sends `joinMintPairingChannel` to the device; the Go minter library *joins* that site-created channel, establishes end-to-end encrypted communication with the NFT display website, and transfers approval results or token payloads back through the encrypted broker path. The FF1 frontend displays no pairing material in the site-initiated flow. The legacy device-initiated flow (the minter creates the channel and the FF1 frontend shows its QR/code for the site to join) is still served by the broker for requester library versions before 0.4.0. `feral-controld`, not the Go minter library, asks `ff-controller` to approve or reject requester metadata through `ff-relayer` and mints ephemeral browser sessions through `ff-relayer` on approval. The current token requester implementation is a browser library that stores the recovered token in `localStorage` under the current website origin and uses it to request DP1 playlist display through `ff-relayer`. DP1 playlist content must not travel through `ff-controller`, the token minter, or the server.

The server in `server/` is now referred to in design docs as the Mint Pairing Broker rather than the handoff server. It remains a short-lived opaque E2EE transport backed by durable bbolt state in the target design.

The sequential flow lives in `docs/sequential-flow.md`. Component-specific rules live in each component's `AGENTS.md`.

## Directory Structure

- `docs/`: shared architecture, flow, server design, and API design documentation.
- `server/`: the Go, bbolt-backed Mint Pairing Broker.
- `clients/session-recipient/js/`: TypeScript token requester library embedded by NFT display websites.
- `clients/ephemeral-token-minter/go/`: Go ephemeral token minter library used by FF1 `feral-controld`.
- `clients/ff-controller/flutter/`: legacy Flutter/Dart implementation from the old flow; remove or replace in the code migration.
- `integration/`: Vitest integration tests.
- `.github/workflows/ci.yml`: CI jobs for server, NFT display website requester library, token minter, and integration tests after the code migration.
- `.github/workflows/build-image.yml`: Manual production image build/push workflow for Feral File DOCR.

## Commands

Server:

```sh
cd server
test -z "$(gofmt -l .)"
go vet ./...
go test ./...
go build ./...
```

Go ephemeral token minter:

```sh
cd clients/ephemeral-token-minter/go
test -z "$(gofmt -l .)"
go vet ./...
go test ./...
```

NFT display website requester library:

```sh
cd clients/session-recipient/js
npm ci
npm run lint
npm run typecheck
npm test
```

Integration:

```sh
cd integration
npm ci
npm run lint
npm run typecheck
npm test
```

## Security Invariants

1. DP1 playlist content does not travel through `ff-controller`.
2. Ephemeral browser session tokens are bearer credentials and must not be logged.
3. Browser token storage is scoped to the current website origin.
4. `ff-relayer` enforces session expiry and revocation.
5. Browser sessions authorize only the intended display/cast path.
6. Browser sessions do not grant API-key access or session-management access.
7. Raw tokens are never stored where a hash or opaque handle is sufficient.
8. Durable server state must not be replaced with process-local maps.
9. Payloads and request bodies keep strict size limits.
10. Tests must not hardcode production credentials.
11. `ff-controller` approves or rejects mint requests but does not receive raw browser session tokens.

## Coding Rules

- Do not introduce in-memory maps for sessions, payloads, token state, expiry state, or test shortcuts.
- Every server state transition must read from and write to bbolt in the target design.
- Keep TypeScript strict mode, `noUncheckedIndexedAccess`, and type-aware ESLint rules enabled.
- Keep Go code idiomatic, formatted with `gofmt`, and covered by `go test ./...` once the minter exists.
- Prefer small, explicit protocol structures over loosely typed JSON.
- Do not add website-specific concepts to public APIs.

## Dependency Rules

- Server storage must remain a local durable embedded KV store, target bbolt.
- Do not add Redis, Postgres, WebSockets, SSE, or external queue dependencies without human approval.
- Go crypto must use maintained standard-library or reviewed crypto packages. Do not implement elliptic-curve math manually.

## Product Scope Rules

- Optimize names and APIs for NFT display websites, the requester library they embed, the ephemeral token minter, `ff-controller`, the Mint Pairing Broker, and `ff-relayer`.
- Keep the requester library general for NFT display websites and future third-party browser clients granted through the token minter.
- Keep `ff-controller` as an approval surface; do not make it the browser-session token minter in the new flow.
- Do not implement flow changes unless explicitly requested.

## Do Not Change Without Human Approval

- Durable storage requirement.
- Payload size limits.
- Token hashing behavior.
- Deployment assumptions for Feral File infrastructure.
- The responsibility boundary that keeps DP1 playlist content out of `ff-controller`.

## Review Checklist

Server:

- bbolt is the target source of truth.
- No in-memory session or payload state.
- Token hashes are stored where tokens must be persisted.
- Expiry, revoke, duplicate claim, and oversized payload paths are covered when implemented.
- API validation rejects malformed input.
- Browser-created channels attest origin from the HTTP `Origin` header; minter-created (legacy) channels stay wire-compatible.
- Server logs do not expose tokens or playlist content.

NFT display website requester library:

- Token storage is origin-scoped.
- Public API does not expose raw tokens unnecessarily.
- Display requests use ephemeral browser session auth only for the intended `ff-relayer` path.
- Errors and logs do not leak tokens or playlist content.

`ff-controller` approval UI and legacy controller client:

- Treat the Flutter controller library as legacy until it is removed.
- `ff-controller` approves or rejects mint requests through `ff-relayer` communication.
- Does not receive or proxy DP1 playlist content.
- Does not receive raw browser session tokens.
- Errors and logs do not leak tokens.

Ephemeral token minter:

- Joins site-created channels through the Mint Pairing Broker by pairing token or short code, and exposes the broker-attested origin and browser info.
- Rejects a mint request whose origin or browser key differs from what the broker attested at join.
- Legacy path: starts channels and provides QR/deep-link and short-code pairing material for the FF1 frontend to display.
- Receives requester origin and browser/client metadata through E2EE.
- Does not call `ff-controller` or `ff-relayer`; `feral-controld` owns approval and session creation.
- Sends host-provided minted token information back only through the E2EE broker path.

Integration/CI:

- Integration tests cover the full mint pairing sequence as implementation support lands.
- Tests use isolated temporary storage.
- CI runs lint, typecheck/analyze, and tests for all components.
- CI does not require a git repository to exist locally before first commit.

## Definition of Done

- Required files exist in the expected directories.
- Server, NFT display website requester library, token minter, and integration tests are present.
- Lint/type/analyzer configurations are strict.
- CI workflow is ready for GitHub Actions.
- Docker image build succeeds before deployment broker work is considered ready.
- Security invariants remain documented and enforced by code or tests where practical.
- Reviewer findings are fixed or documented as known limitations.

## Commit Message Format

Use Conventional Commits:

- `<type>(<optional-scope>): <description>`
- Types: `feat`, `fix`, `refactor`, `test`, `chore`, `docs`, `build`, `ci`, `perf`, `style`
