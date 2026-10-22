# Browser sample

Run `npm ci` and `npm run sample:dev` from `integration/` after building the
browser library. `npm run sample:build` checks the distributable sample.

This build displays **Protected pairing and casting are not available**.
The action returns `secure_integration_unavailable` without opening a socket.
The generic device and temporary adapters are implemented, but shared ps-bound
validators and the agreed browser grant/key-custody integration are pending.
A device ID alone never authorizes casting. Do not use this branch to replace
production mint pairing. No device manual casting result is claimed.
