# Device-ID playback sample

Build `clients/session-recipient/js` with `npm run build && npm run bundle`.
Then in `integration`, run:

```sh
VITE_RELAYER_URL=https://ff-relayer-device-test.bitmark-development.workers.dev npm run sample:dev
```

Open the printed URL, enter the FF1 device ID, paste a valid DP-1 playlist,
and press **Play on Art Computer**. Point the FF1 at the same relayer.
No app approval, browser pairing, or broker channel is involved.
