# Changelog

## 0.6.0

One release for every Art Computer in the field.

- **Both firmware generations.** The pairing request is the one 0.5 sends. An
  FF1 on FF OS with display grants answers with a grant (relay v2, as in
  0.5); an FF1 on older FF OS answers with a relayer session, which 0.5
  discarded with `device_unsupported` and 0.6 keeps and casts with, through
  the legacy relayer's HTTPS `POST /api/cast`, as 0.4 did.
- **`EphemeralBrowserSession` is a union** discriminated by `kind`:
  `"displayGrant"` (`{ deviceId, ctl, expiresAt?, persistent }`) or
  `"relayerSession"` (`{ sessionId, expiresAt?, persistent, relayerBaseUrl? }`).
  The session's token stays in `localStorage` and is never returned.
- **Storage precedence.** A stored grant first (IndexedDB), then a stored
  session (`localStorage`, under `ephemeralBrowserSessionStorageKey(origin)`,
  the 0.4 key and record), else pair. A new grant replaces a stored session.
  Sessions 0.4 stored are used, no longer removed.
- **`relayerBaseUrl`** is an option again on `DisplayDp1PlaylistOptions` and
  `mountDisplayOnArtComputerButton` (a value or a function), with no default;
  the session's own `relayerBaseUrl` wins. `DisplayDp1PlaylistOptions` takes
  `fetchImpl` again.
- **Relayer answers.** `400 {"error":{"id":1003}}` (no FF1 on the session's
  channel: the FF1 updated, or it is off) is `device_unrecognized`: the
  session is kept and the button offers "Pair again?". `401`/`403` is
  `session_rejected`, and the session is deleted.
- `unpairArtComputer()` and `clearStoredEphemeralBrowserSession(origin)` also
  forget a stored session.
- **Removed** the 0.5 deprecated aliases: `mountPlayOnArtComputerButton`,
  `PlayOnArtComputerButtonOptions`, `PlayOnArtComputerButtonHandle`,
  `PlayError`, `PlayErrorCode`, the `ff-ac-play`, `ff-ac-play-button` and
  `ff-ac-play-status` class names, and the `play.js` release asset. Use the
  `Display` names and `ff-ac-display*` classes.
- **Removed** `legacySessionStorageKey`: use `ephemeralBrowserSessionStorageKey`
  (the same key).
- On a session's 1003 the button says "Could not reach your Art Computer. If
  it is on and was updated recently, pair again." and its "Pair again?" pairs
  without deleting the session first: if that pairing fails, the session
  still works once the FF1 is back. A storage-less browser (no IndexedDB)
  still casts with a stored session; only a new pairing needs IndexedDB.

## 0.5.0

Renamed from `@feralfile/play`; casts with a display grant over relay v2. See
the README's "Upgrading from 0.4.x".
