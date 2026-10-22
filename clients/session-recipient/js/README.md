# Play generic carrier integration

This development branch provides transport seams, not a finished secure browser
pairing workflow. `displayDp1Playlist` fails with
`PlayError.code === "secure_integration_unavailable"`; the sample displays that
state. Do not ship this branch as a replacement for production mint pairing.

`RelayClient.requestPrepared(prepare, timeoutMs)` waits for connection and queue
readiness before invoking the endpoint sealer. The returned command must be
`ff1Envelope`; its `verify` callback must use the reviewed pinned profile/reply
validator. Candidate peers cannot settle a request without that verifier.
An integration must send a fresh sealed `getDeviceStatus` on every new socket
before commands, and must retain that socket for notifications. Receipt ACKs do
not prove approval or execution. Malformed candidate application payloads are
ignored after transport ACK. Commands are never automatically resubmitted.

`TemporaryChannel(endpoint, channelId?, timeoutMs?)` generates a UUID by default.
Await `ready` before displaying QR; `connectionId` identifies that secondary
socket. The owner joins the same channel and `send(connectionId, ciphertext)`
targets the result. `onPayload` delivers bytes after receipt ACK, for the shared
result validator; `close` cancels locally. Timeout means incomplete, not rejected.
Reopening creates a new socket identity; no unverified result becomes a grant.
The adapter never adds tokens, origin joins, polling, a broker mailbox or TTL.

Both carriers use `/v2/channels/{channelId}/connections`, `ff-relay.v2`, existing
binary framing and endpoint chunk wrappers. Device RPCs enforce a 4 MiB bound,
32 KiB chunks, bounded concurrent writes and socket-wide pacing. Private payloads
stay at endpoints, never in the owner app or relay application logic.

## Dependency and release gate

[Latest agreement](https://github.com/feral-file/feral-file/issues/3551#issuecomment-6332777506)
supersedes the earlier plaintext rollout. There is no corresponding Brandon Play
PR. His app/CLI/FFOS heads `441246e9`, `73b1735c`, `51164c8c` still lack promised
registration changes and shared ps/channel/controller/device-profile fixtures.
Those validators must be wired before enabling browser enrollment/casting.
Reuse the existing reviewed ECDH/HKDF/AES-GCM modules; preserve origin-held keys,
optional legacy result topicId, and FF1 browser LAN restrictions. Browser
permissions/key-custody details remain an explicit joint-release blocker; this
branch invents none.

Checks: `npm ci`, `npm run lint`, `npm run typecheck`, `npm test`,
`npm run build`, `npm run bundle`; then the corresponding integration checks and
`npm run sample:build`. Transport tests use synthetic endpoint seams and do not
claim security-fixture interoperability. Historical plaintext hardware results
are not current secure evidence. Joint FF1-SKYZ2E3A manual matrix is blocked.
Fleet floors, recovery images, shelf-stock migration, channel rollback policy and
production retirement remain release prerequisites, not actions taken here.
