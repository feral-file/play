# play Local Review Delta

This file adds repository-specific context to the generated Canon local review contract in `prompts/code-review.md`.

## Required context

- Read `docs/sequential-flow.md` and the applicable component `AGENTS.md` before reviewing changed protocol or component behavior.

## Protocol and storage invariants

- DP1 playlist content must not travel through `ff-controller`, the ephemeral token minter, or the Mint Pairing Broker.
- Browser session tokens and privileged credentials must not be logged or exposed. Browser token storage remains scoped to the current website origin.
- `ff-controller` approves or rejects mint requests but does not receive raw browser session tokens. `feral-controld` owns approval coordination and session creation through `ff-relayer`.
- The Mint Pairing Broker treats payloads as opaque E2EE content, enforces request and payload size limits, and persists channel, message, expiry, cleanup, and rate-limit state in bbolt rather than process-local maps.
- Docker deployments preserve the bbolt database through the `/data` volume.
- Preserve expiry, revocation, duplicate-claim, retry, cleanup, and restart-durability behavior at the component that owns each responsibility.

## Verification

- Relevant server, requester, minter, and integration checks cover malformed input, unauthorized access, expiry, revocation, duplicate claims, oversized payloads, and durable restart behavior when those paths change.
- Browser and integration checks preserve party boundaries and public API constraints.
- Deployment changes verify Docker image behavior, persistent storage, and production defaults without weakening protocol assumptions.
