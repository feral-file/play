# Play on Art Computer

Send a DP-1 playlist to an FF1 by its physical device ID. Browser pairing,
API keys, topic IDs, and stored session tokens are no longer used.

```ts
import { mountPlayOnArtComputerButton, displayDp1Playlist } from '@feralfile/play';

mountPlayOnArtComputerButton({
  container: '#play',
  deviceId: () => deviceInput.value.trim(),
  relayerBaseUrl: 'https://your-relayer.example',
  playlist: () => playlist,
});

await displayDp1Playlist({
  deviceId: 'FF1-XXXXXXXX',
  relayerBaseUrl: 'https://your-relayer.example',
  playlist,
});
```

The library connects to `/v2/players/{deviceId}/connections?role=controller`
with `ff-relay.v2`. It preserves the JSON `displayPlaylist` command and waits
for the correlated device execution response. Receipt ACKs release transport
credit only. Payloads over 32 KiB are chunked and paced, up to 4 MiB.
Disconnects and timeouts reject the request; ambiguous commands are not retried.

Device IDs are public routing addresses, not proof of identity. Peer
authentication and payload confidentiality are deferred for this rollout.
The broker is no longer part of browser playback. Existing browser tokens
are ignored; no network revocation is attempted against retired endpoints.

Run `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`, and
`npm run bundle`. The example is in `integration/sample`.
