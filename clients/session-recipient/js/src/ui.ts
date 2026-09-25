import qrcode from "qrcode-generator";
import {
  displayDp1Playlist,
  readStoredEphemeralBrowserSession,
  requestEphemeralSession,
  validateAppLinkBaseUrl,
  validateRequestedExpiresInSeconds,
  type BrowserInfo,
  type DisplayDp1PlaylistOptions,
  type Dp1Playlist,
  type EphemeralBrowserSession,
  type RequestEphemeralSessionOptions,
  type TokenStorage,
  type TokenStorageOptions
} from "./client.js";
import { PlayError } from "./errors.js";
import type { PairingMaterial } from "./pairingPayload.js";

export type PairingDialogCopy = {
  title: string;
  /** Primary action on a phone: opens the Feral File app through the app link. */
  openAppLabel: string;
  /** Caption under the QR code on a desktop. */
  qrCaption: string;
  /** Accessible name of the QR code image. */
  qrLabel: string;
  /** Line above the six-digit code. */
  codeLabel: string;
  /** Hint under the code; tapping the code copies it. */
  copyHint: string;
  /** Shown in place of the hint once the code is on the clipboard. */
  copiedHint: string;
  /** Status while the channel waits for an Art Computer to join. */
  waitingStatus: string;
  /** Status once the Art Computer has joined and approval is in the app. */
  approveStatus: string;
  /** Status once the session is approved, just before the dialog closes. */
  approvedStatus: string;
  cancelLabel: string;
};

export type PairingDialogClassNames = {
  overlay?: string;
  panel?: string;
  title?: string;
  appLink?: string;
  qr?: string;
  caption?: string;
  codeLabel?: string;
  code?: string;
  status?: string;
  actions?: string;
  secondaryButton?: string;
};

/**
 * `auto` (the default) picks the phone layout on a touch device with a
 * phone-sized viewport and the QR layout everywhere else.
 */
export type PairingDialogLayout = "auto" | "mobile" | "desktop";

export type PairingDialogOptions = {
  copy?: Partial<PairingDialogCopy>;
  classNames?: PairingDialogClassNames;
  document?: Document;
  layout?: PairingDialogLayout;
  /** Called when the visitor cancels; the library stops pairing with `pairing_canceled`. */
  onCancel: () => void;
};

export type PairingDialog = {
  /** Shows the pairing material; called again with fresh material when an expired channel is replaced. */
  show: (material: PairingMaterial) => void;
  setStatus: (text: string) => void;
  close: () => void;
};

type PairingPassThroughOptions = Omit<
  RequestEphemeralSessionOptions,
  "onPairingMaterial" | "onPeerJoined" | "signal" | "channelRegenerations"
>;

export type RequestEphemeralSessionWithPairingUiOptions = PairingPassThroughOptions & {
  createDialog?: (options: PairingDialogOptions) => PairingDialog;
  dialog?: Omit<PairingDialogOptions, "onCancel">;
};

export type ValueProvider<T> = T | (() => T | Promise<T>);

export type PlayOnArtComputerButtonOptions = {
  container: HTMLElement | string;
  playlist: ValueProvider<Dp1Playlist>;
  brokerBaseUrl: ValueProvider<string>;
  relayerBaseUrl?: ValueProvider<string | undefined>;
  /**
   * Base of the link that brings the visitor's Art Computer to the pairing
   * channel. Defaults to `https://link.feralfile.com/pair`.
   */
  appLinkBaseUrl?: string;
  browserInfo?: BrowserInfo;
  storage?: TokenStorageOptions;
  pollIntervalMs?: number;
  maxWaitMs?: number;
  /**
   * Session lifetime this site asks for, in whole seconds, from 1 to
   * 31536000 (one year). Leave unset to take the device default. The device
   * owner decides: if they keep this site paired until removed, the requested
   * lifetime is ignored and the session has no expiry.
   */
  requestedExpiresInSeconds?: number;
  fetchImpl?: typeof fetch;
  document?: Document;
  buttonLabel?: string;
  busyLabel?: string;
  className?: string;
  statusClassName?: string;
  dialog?: Omit<PairingDialogOptions, "onCancel">;
  createDialog?: (options: PairingDialogOptions) => PairingDialog;
  onStatusChange?: (message: string) => void;
  onSuccess?: () => void;
  onError?: (error: unknown) => void;
};

export type PlayOnArtComputerButtonHandle = {
  element: HTMLButtonElement;
  statusElement: HTMLElement;
  destroy: () => void;
};

type OptionalBrowserGlobals = {
  document?: Document;
  location?: { origin?: unknown };
  localStorage?: Storage;
};

const dialogStyleElementId = "ff-art-computer-pairing-ui-style";
const defaultButtonLabel = "Play on Art Computer";
const svgNamespace = "http://www.w3.org/2000/svg";
/** Largest viewport short side, in CSS pixels, treated as a phone. */
const phoneShortSideMaxPx = 600;
/** Expired channels the wrapped flow replaces before giving up. */
const wrappedChannelRegenerations = 2;
const qrQuietZoneModules = 4;

export const defaultPairingDialogCopy: PairingDialogCopy = {
  title: "Play on your Art Computer",
  openAppLabel: "Open the Feral File app",
  qrCaption: "Scan with your phone camera or the Feral File app",
  qrLabel: "QR code that opens the Feral File app",
  codeLabel: "Or enter this code in the app",
  copyHint: "Tap to copy",
  copiedHint: "Copied",
  waitingStatus: "Waiting for your Art Computer…",
  approveStatus: "Approve in the Feral File app…",
  approvedStatus: "Approved. Starting playback…",
  cancelLabel: "Cancel"
};

export function pairingErrorMessage(error: unknown): string {
  if (error instanceof PlayError && error.code !== undefined) {
    switch (error.code) {
      case "pairing_code_expired":
        return "The pairing code expired. Press play to get a new one.";
      case "pairing_canceled":
        return "Pairing canceled.";
      case "mint_rejected":
        return "The browser session was not approved in Feral File.";
      case "approval_timeout":
        return "Timed out waiting for your Art Computer. Press play to try again.";
      case "session_rejected":
        return "The stored browser session was rejected. Pair again.";
      default:
        break;
    }
  }
  return error instanceof Error ? error.message : "request failed";
}

export function clearStoredEphemeralBrowserSession(storage: TokenStorage, origin: string): void {
  storage.removeItem(`ff:ephemeral-browser-session:${origin}`);
}

export function hasStoredEphemeralBrowserSession(storage: TokenStorage, origin: string): boolean {
  return readStoredEphemeralBrowserSession(storage, origin) !== undefined;
}

/**
 * True on a touch device (coarse pointer or touch points) whose viewport is
 * phone-sized. That visitor has the Feral File app on the device in hand, so
 * the dialog offers the app link as a button rather than a QR to scan.
 */
export function isPhoneLikeViewport(view: Window | null | undefined): boolean {
  if (view === null || view === undefined) {
    return false;
  }
  const coarsePointer = typeof view.matchMedia === "function" && view.matchMedia("(pointer: coarse)").matches;
  const touchPoints = typeof view.navigator === "object" && view.navigator.maxTouchPoints > 0;
  const shortSide = Math.min(view.innerWidth, view.innerHeight);
  return (coarsePointer || touchPoints) && shortSide > 0 && shortSide <= phoneShortSideMaxPx;
}

/** Renders `text` as an inline SVG QR code, locally, with no network fetch. */
export function renderQrSvg(ownerDocument: Document, text: string, label: string): SVGSVGElement {
  const code = qrcode(0, "M");
  code.addData(text, "Byte");
  code.make();
  const modules = code.getModuleCount();
  const size = modules + qrQuietZoneModules * 2;
  let path = "";
  for (let row = 0; row < modules; row += 1) {
    for (let col = 0; col < modules; col += 1) {
      if (code.isDark(row, col)) {
        path += `M${String(col + qrQuietZoneModules)} ${String(row + qrQuietZoneModules)}h1v1h-1z`;
      }
    }
  }
  const svg = ownerDocument.createElementNS(svgNamespace, "svg");
  svg.setAttribute("viewBox", `0 0 ${String(size)} ${String(size)}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", label);
  svg.setAttribute("shape-rendering", "crispEdges");
  const background = ownerDocument.createElementNS(svgNamespace, "rect");
  background.setAttribute("width", String(size));
  background.setAttribute("height", String(size));
  background.setAttribute("fill", "#ffffff");
  const dark = ownerDocument.createElementNS(svgNamespace, "path");
  dark.setAttribute("d", path);
  dark.setAttribute("fill", "#000000");
  svg.append(background, dark);
  return svg;
}

export function createPairingDialog(options: PairingDialogOptions): PairingDialog {
  const ownerDocument = options.document ?? requiredDocument();
  ensureDefaultStyles(ownerDocument);
  const copy = { ...defaultPairingDialogCopy, ...options.copy };
  const layout = options.layout ?? "auto";
  const mobile = layout === "mobile" || (layout === "auto" && isPhoneLikeViewport(ownerDocument.defaultView));

  const overlay = ownerDocument.createElement("div");
  overlay.className = className("ff-ac-pairing-overlay", options.classNames?.overlay);
  overlay.setAttribute("role", "presentation");

  const panel = ownerDocument.createElement("section");
  panel.className = className("ff-ac-pairing-panel", options.classNames?.panel);
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.setAttribute("aria-labelledby", "ff-ac-pairing-title");
  panel.setAttribute("data-layout", mobile ? "mobile" : "desktop");
  overlay.append(panel);

  const title = ownerDocument.createElement("h2");
  title.id = "ff-ac-pairing-title";
  title.className = className("ff-ac-pairing-title", options.classNames?.title);
  title.textContent = copy.title;

  // Filled by show(): the app-link button (phone) or the QR (desktop).
  const primary = ownerDocument.createElement("div");
  primary.className = "ff-ac-pairing-primary-area";

  const codeLabel = ownerDocument.createElement("p");
  codeLabel.className = className("ff-ac-pairing-code-label", options.classNames?.codeLabel);
  codeLabel.textContent = copy.codeLabel;

  const code = ownerDocument.createElement("button");
  code.type = "button";
  code.className = className("ff-ac-pairing-code", options.classNames?.code);

  const copyHint = ownerDocument.createElement("p");
  copyHint.className = "ff-ac-pairing-copy-hint";
  copyHint.setAttribute("aria-live", "polite");
  copyHint.textContent = copy.copyHint;

  const status = ownerDocument.createElement("p");
  status.className = className("ff-ac-pairing-status", options.classNames?.status);
  status.setAttribute("aria-live", "polite");

  const actions = ownerDocument.createElement("div");
  actions.className = className("ff-ac-pairing-actions", options.classNames?.actions);

  const cancel = ownerDocument.createElement("button");
  cancel.className = className("ff-ac-pairing-secondary", options.classNames?.secondaryButton);
  cancel.type = "button";
  cancel.textContent = copy.cancelLabel;
  actions.append(cancel);

  panel.append(title, primary, codeLabel, code, copyHint, status, actions);

  let currentCode = "";

  function renderPrimary(material: PairingMaterial): void {
    for (const child of Array.from(primary.children)) {
      child.remove();
    }
    if (mobile) {
      const appLink = ownerDocument.createElement("a");
      appLink.className = className("ff-ac-pairing-app-link", options.classNames?.appLink);
      appLink.href = material.appLink;
      appLink.target = "_self";
      appLink.textContent = copy.openAppLabel;
      primary.append(appLink);
      return;
    }
    const qr = ownerDocument.createElement("div");
    qr.className = className("ff-ac-pairing-qr", options.classNames?.qr);
    qr.append(renderQrSvg(ownerDocument, material.appLink, copy.qrLabel));
    const caption = ownerDocument.createElement("p");
    caption.className = className("ff-ac-pairing-caption", options.classNames?.caption);
    caption.textContent = copy.qrCaption;
    primary.append(qr, caption);
  }

  function setStatus(text: string): void {
    status.textContent = text;
  }

  function close(): void {
    overlay.remove();
  }

  code.addEventListener("click", () => {
    const clipboard = ownerDocument.defaultView?.navigator.clipboard;
    if (currentCode.length === 0 || clipboard === undefined) {
      return;
    }
    const copied = currentCode;
    clipboard.writeText(copied).then(() => {
      if (currentCode === copied) {
        copyHint.textContent = copy.copiedHint;
      }
    }, () => {
      // Clipboard refused (permissions, insecure context): the code stays on
      // screen to read and type.
    });
  });

  cancel.addEventListener("click", () => {
    close();
    options.onCancel();
  });

  return {
    show: (material) => {
      currentCode = material.shortCode;
      renderPrimary(material);
      code.textContent = material.shortCode;
      code.setAttribute("aria-label", `${copy.codeLabel}: ${material.shortCode.split("").join(" ")}. ${copy.copyHint}`);
      copyHint.textContent = copy.copyHint;
      setStatus(copy.waitingStatus);
      if (!ownerDocument.body.contains(overlay)) {
        ownerDocument.body.append(overlay);
      }
    },
    setStatus,
    close
  };
}

export async function requestEphemeralSessionWithPairingUi(
  options: RequestEphemeralSessionWithPairingUiOptions
): Promise<EphemeralBrowserSession> {
  validateRequestedExpiresInSeconds(options.requestedExpiresInSeconds);
  validateAppLinkBaseUrl(options.appLinkBaseUrl);
  const storage = resolveUiStorage(options.storage);
  const origin = currentOriginForUi();
  const existingSession = storage === undefined ? undefined : readStoredEphemeralBrowserSession(storage, origin);
  if (existingSession !== undefined) {
    return existingSession;
  }

  const copy = { ...defaultPairingDialogCopy, ...options.dialog?.copy };
  const cancelController = new AbortController();
  const { createDialog: createDialogOption, dialog: dialogOptions, ...requestOptions } = options;
  const createDialog = createDialogOption ?? createPairingDialog;
  const dialog = createDialog({
    ...dialogOptions,
    onCancel: () => {
      cancelController.abort();
    }
  });
  try {
    const session = await requestEphemeralSession({
      ...requestOptions,
      channelRegenerations: wrappedChannelRegenerations,
      signal: cancelController.signal,
      onPairingMaterial: (material) => {
        dialog.show(material);
        dialog.setStatus(copy.waitingStatus);
      },
      onPeerJoined: () => {
        dialog.setStatus(copy.approveStatus);
      }
    });
    dialog.setStatus(copy.approvedStatus);
    dialog.close();
    return session;
  } catch (error) {
    dialog.close();
    throw error;
  }
}

export function mountPlayOnArtComputerButton(options: PlayOnArtComputerButtonOptions): PlayOnArtComputerButtonHandle {
  validateRequestedExpiresInSeconds(options.requestedExpiresInSeconds);
  validateAppLinkBaseUrl(options.appLinkBaseUrl);
  const ownerDocument = options.document ?? requiredDocument();
  ensureDefaultStyles(ownerDocument);
  const container = resolveContainer(ownerDocument, options.container);
  const wrapper = ownerDocument.createElement("div");
  wrapper.className = "ff-ac-play";

  const button = ownerDocument.createElement("button");
  button.type = "button";
  button.className = className("ff-ac-play-button", options.className);
  button.textContent = options.buttonLabel ?? defaultButtonLabel;

  const status = ownerDocument.createElement("p");
  status.className = className("ff-ac-play-status", options.statusClassName);
  status.setAttribute("aria-live", "polite");
  wrapper.append(button, status);
  container.append(wrapper);

  const clickController = new AbortController();
  button.addEventListener("click", () => {
    void playFromButton(options, ownerDocument, button, status);
  }, { signal: clickController.signal });

  return {
    element: button,
    statusElement: status,
    destroy: () => {
      clickController.abort();
      wrapper.remove();
    }
  };
}

async function playFromButton(
  options: PlayOnArtComputerButtonOptions,
  ownerDocument: Document,
  button: HTMLButtonElement,
  status: HTMLElement
): Promise<void> {
  const idleLabel = options.buttonLabel ?? defaultButtonLabel;
  button.disabled = true;
  button.textContent = options.busyLabel ?? "Preparing...";
  try {
    setStatus(options, status, "Checking browser session.");
    const brokerBaseUrl = await resolveProvider(options.brokerBaseUrl);
    const storage = resolveUiStorage(options.storage);
    const origin = currentOriginForUi();
    if (storage !== undefined && !hasStoredEphemeralBrowserSession(storage, origin)) {
      setStatus(options, status, "Waiting for your Art Computer.");
    }
    const session = await requestEphemeralSessionWithPairingUi({
      brokerBaseUrl,
      ...(options.appLinkBaseUrl === undefined ? {} : { appLinkBaseUrl: options.appLinkBaseUrl }),
      browserInfo: options.browserInfo ?? defaultButtonBrowserInfo(ownerDocument),
      ...(options.storage === undefined ? {} : { storage: options.storage }),
      ...(options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs }),
      ...(options.maxWaitMs === undefined ? {} : { maxWaitMs: options.maxWaitMs }),
      ...(options.requestedExpiresInSeconds === undefined ? {} : { requestedExpiresInSeconds: options.requestedExpiresInSeconds }),
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      ...(options.createDialog === undefined ? {} : { createDialog: options.createDialog }),
      dialog: {
        document: ownerDocument,
        ...options.dialog
      }
    });
    setStatus(options, status, "Sending playlist to Art Computer.");
    await displayDp1Playlist(displayOptions(options, session, await resolveProvider(options.playlist), await resolveOptionalProvider(options.relayerBaseUrl)));
    setStatus(options, status, "Playlist sent to Art Computer.");
    options.onSuccess?.();
  } catch (error) {
    if (error instanceof PlayError && error.code === "session_rejected") {
      const storage = resolveUiStorage(options.storage);
      if (storage !== undefined) {
        clearStoredEphemeralBrowserSession(storage, currentOriginForUi());
      }
    }
    setStatus(options, status, pairingErrorMessage(error));
    options.onError?.(error);
  } finally {
    button.disabled = false;
    button.textContent = idleLabel;
  }
}

function displayOptions(
  buttonOptions: PlayOnArtComputerButtonOptions,
  session: EphemeralBrowserSession,
  playlist: Dp1Playlist,
  relayerBaseUrl: string | undefined
): DisplayDp1PlaylistOptions {
  return {
    session,
    playlist,
    ...(relayerBaseUrl === undefined ? {} : { relayerBaseUrl }),
    ...(buttonOptions.fetchImpl === undefined ? {} : { fetchImpl: buttonOptions.fetchImpl })
  };
}

function defaultButtonBrowserInfo(ownerDocument: Document): BrowserInfo {
  return ownerDocument.title.length > 0 ? { label: ownerDocument.title } : {};
}

function setStatus(options: PlayOnArtComputerButtonOptions, status: HTMLElement, message: string): void {
  status.textContent = message;
  options.onStatusChange?.(message);
}

async function resolveProvider<T>(provider: ValueProvider<T>): Promise<T> {
  if (typeof provider === "function") {
    return (provider as () => T | Promise<T>)();
  }
  return provider;
}

async function resolveOptionalProvider<T>(provider: ValueProvider<T | undefined> | undefined): Promise<T | undefined> {
  if (provider === undefined) {
    return undefined;
  }
  return resolveProvider(provider);
}

function resolveContainer(ownerDocument: Document, container: HTMLElement | string): HTMLElement {
  if (typeof container !== "string") {
    return container;
  }
  const element = ownerDocument.querySelector(container);
  if (element instanceof HTMLElement) {
    return element;
  }
  throw new Error(`container not found: ${container}`);
}

function requiredDocument(): Document {
  const documentValue = (globalThis as unknown as OptionalBrowserGlobals).document;
  if (documentValue === undefined) {
    throw new Error("document is required");
  }
  return documentValue;
}

function currentOriginForUi(): string {
  const origin = (globalThis as unknown as OptionalBrowserGlobals).location?.origin;
  if (typeof origin === "string" && origin.length > 0) {
    return origin;
  }
  throw new Error("origin is required");
}

function resolveUiStorage(options: TokenStorageOptions | undefined): TokenStorage | undefined {
  if (options === false) {
    return undefined;
  }
  if (typeof options === "object") {
    if (options.enabled === false) {
      return undefined;
    }
    if (options.storage !== undefined) {
      return options.storage;
    }
  }
  return (globalThis as unknown as OptionalBrowserGlobals).localStorage;
}

function className(base: string, extra: string | undefined): string {
  return extra === undefined || extra.length === 0 ? base : `${base} ${extra}`;
}

function ensureDefaultStyles(ownerDocument: Document): void {
  if (ownerDocument.getElementById(dialogStyleElementId) !== null) {
    return;
  }
  const style = ownerDocument.createElement("style");
  style.id = dialogStyleElementId;
  style.textContent = `
.ff-ac-pairing-overlay {
  position: fixed;
  inset: 0;
  z-index: 2147483647;
  display: grid;
  place-items: center;
  padding: 16px;
  background: rgba(18, 18, 18, 0.72);
}
.ff-ac-pairing-panel {
  box-sizing: border-box;
  display: grid;
  justify-items: center;
  gap: 12px;
  width: min(420px, 100%);
  max-height: calc(100vh - 32px);
  overflow: auto;
  border: 1px solid #d7d2c8;
  border-radius: 8px;
  background: #fbfaf7;
  color: #1d1d1b;
  padding: 24px;
  box-shadow: 0 24px 80px rgba(0, 0, 0, 0.28);
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  text-align: center;
}
.ff-ac-pairing-title {
  margin: 0;
  font-size: 22px;
  line-height: 1.25;
}
.ff-ac-pairing-primary-area {
  display: grid;
  justify-items: center;
  gap: 8px;
  width: 100%;
}
.ff-ac-pairing-app-link {
  box-sizing: border-box;
  display: block;
  width: 100%;
  min-height: 48px;
  border-radius: 6px;
  padding: 14px 16px;
  background: #df3f2d;
  color: #ffffff;
  font-weight: 800;
  line-height: 20px;
  text-decoration: none;
}
.ff-ac-pairing-qr {
  width: min(240px, 100%);
  aspect-ratio: 1;
}
.ff-ac-pairing-qr svg {
  display: block;
  width: 100%;
  height: 100%;
}
.ff-ac-pairing-caption,
.ff-ac-pairing-code-label,
.ff-ac-pairing-copy-hint,
.ff-ac-pairing-status,
.ff-ac-play-status {
  line-height: 1.5;
}
.ff-ac-pairing-caption,
.ff-ac-pairing-code-label {
  margin: 0;
  color: #56534d;
}
.ff-ac-pairing-code {
  border: 1px dashed #bdb7ac;
  border-radius: 6px;
  padding: 6px 16px;
  background: #ffffff;
  color: #171614;
  cursor: copy;
  font: 700 36px/1.2 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.12em;
}
.ff-ac-pairing-copy-hint {
  min-height: 21px;
  margin: 0;
  color: #6c675f;
  font-size: 14px;
}
.ff-ac-pairing-status {
  min-height: 24px;
  margin: 4px 0 0;
  font-weight: 700;
}
.ff-ac-pairing-actions {
  display: flex;
  justify-content: center;
  width: 100%;
}
.ff-ac-pairing-secondary,
.ff-ac-play-button {
  min-height: 42px;
  border-radius: 6px;
  padding: 0 16px;
  font-weight: 800;
  cursor: pointer;
}
.ff-ac-play-button {
  border: 1px solid #df3f2d;
  background: #df3f2d;
  color: #ffffff;
}
.ff-ac-pairing-secondary {
  border: 1px solid #bdb7ac;
  background: #ffffff;
  color: #2b2a27;
}
.ff-ac-play-button:disabled {
  cursor: wait;
  border-color: #8f8b83;
  background: #8f8b83;
}
.ff-ac-play {
  display: inline-grid;
  gap: 10px;
}
.ff-ac-play-status {
  min-height: 20px;
  margin: 0;
  color: currentColor;
  font-size: 14px;
}
`;
  ownerDocument.head.append(style);
}
