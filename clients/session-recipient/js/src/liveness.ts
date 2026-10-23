/**
 * PING_INTERVAL_MS keeps a relay v2 socket alive (ff1-control-v1 §10
 * Liveness): the relay closes a connection that sends nothing for 90 s and
 * answers the text frame `ping` with `pong` without waking. 25 s matches
 * ff-cli and leaves room for a late timer.
 */
export const PING_INTERVAL_MS = 25_000;

/**
 * startPinging sends `ping` every PING_INTERVAL_MS. A send before the socket
 * opens or after it closed is ignored: the close handler reports a dead
 * socket. In Node the timer never keeps the process alive.
 */
export function startPinging(socket: WebSocket): ReturnType<typeof setInterval> {
  const timer = setInterval(() => {
    try {
      socket.send('ping');
    } catch {
      /* The close handler reports a dead socket. */
    }
  }, PING_INTERVAL_MS);
  (timer as { unref?: () => void }).unref?.();
  return timer;
}
