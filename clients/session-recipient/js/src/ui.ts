import { displayDp1Playlist, type Dp1Playlist } from "./client.js";

export type ValueProvider<T> = T | (() => T | Promise<T>);
export type PlayOnArtComputerButtonOptions = {
  container: HTMLElement | string;
  playlist: ValueProvider<Dp1Playlist>;
  deviceId: ValueProvider<string>;
  relayerBaseUrl: ValueProvider<string>;
  document?: Document;
  buttonLabel?: string;
  busyLabel?: string;
  className?: string;
  statusClassName?: string;
  onStatusChange?: (message: string) => void;
  onSuccess?: () => void;
  onError?: (error: unknown) => void;
};
export type PlayOnArtComputerButtonHandle = {
  element: HTMLButtonElement;
  statusElement: HTMLElement;
  destroy: () => void;
};

async function resolve<T>(value: ValueProvider<T>): Promise<T> {
  return typeof value === "function" ? (value as () => T | Promise<T>)() : value;
}

/** Mount a direct-play button. The host supplies a device selection or input. */
export function mountPlayOnArtComputerButton(options: PlayOnArtComputerButtonOptions): PlayOnArtComputerButtonHandle {
  const document = options.document ?? globalThis.document;
  const container = typeof options.container === "string" ? document.querySelector(options.container) : options.container;
  if (!container) throw new Error("play button container not found");
  const wrapper = document.createElement("div");
  const button = document.createElement("button");
  const status = document.createElement("p");
  button.type = "button";
  button.className = options.className ?? "ff-ac-play-button";
  button.textContent = options.buttonLabel ?? "Play on Art Computer";
  status.className = options.statusClassName ?? "ff-ac-play-status";
  status.setAttribute("aria-live", "polite");
  wrapper.append(button, status);
  container.append(wrapper);
  let destroyed = false;
  const isDestroyed = (): boolean => destroyed;
  const setStatus = (message: string): void => {
    if (destroyed) return;
    status.textContent = message;
    options.onStatusChange?.(message);
  };
  const click = async (): Promise<void> => {
    if (button.disabled || destroyed) return;
    button.disabled = true;
    button.textContent = options.busyLabel ?? "Sending...";
    try {
      setStatus("Sending playlist to Art Computer.");
      await displayDp1Playlist({
        playlist: await resolve(options.playlist),
        deviceId: await resolve(options.deviceId),
        relayerBaseUrl: await resolve(options.relayerBaseUrl)
      });
      setStatus("Playlist sent to Art Computer.");
      if (!isDestroyed()) options.onSuccess?.();
    } catch (error) {
      setStatus("Could not send playlist to Art Computer.");
      if (!isDestroyed()) options.onError?.(error);
    } finally {
      button.disabled = false;
      button.textContent = options.buttonLabel ?? "Play on Art Computer";
    }
  };
  const listener = (): void => { void click(); };
  button.addEventListener("click", listener);
  return { element: button, statusElement: status, destroy: () => {
    destroyed = true;
    button.removeEventListener("click", listener);
    wrapper.remove();
  } };
}
