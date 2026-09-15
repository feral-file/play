import {
  displayDp1Playlist,
  readStoredEphemeralBrowserSession,
  requestEphemeralSession,
  validateRequestedExpiresInSeconds,
  type BrowserInfo,
  type DisplayDp1PlaylistOptions,
  type Dp1Playlist,
  type EphemeralBrowserSession,
  type PairingInput,
  type RequestEphemeralSessionOptions,
  type TokenStorage,
  type TokenStorageOptions
} from "./client.js";
import { PlayError } from "./errors.js";

export type PairingCodeDialogCopy = {
  title: string;
  intro: string;
  instructions: readonly string[];
  codeLabel: string;
  codePlaceholder: string;
  submitLabel: string;
  cancelLabel: string;
  approvalTitle: string;
  approvalBody: string;
  cliNotice?: string;
  errorTitle: string;
};

export type PairingCodeDialogClassNames = {
  overlay?: string;
  panel?: string;
  title?: string;
  intro?: string;
  instructions?: string;
  label?: string;
  input?: string;
  actions?: string;
  primaryButton?: string;
  secondaryButton?: string;
  message?: string;
};

export type PairingCodeDialogOptions = {
  brokerBaseUrl: string;
  copy?: Partial<PairingCodeDialogCopy>;
  classNames?: PairingCodeDialogClassNames;
  document?: Document;
};

export type PairingCodeDialog = {
  prompt: () => Promise<PairingInput>;
  showApprovalPending: () => void;
  showError: (message: string) => void;
  close: () => void;
};

export type RequestEphemeralSessionWithPairingUiOptions = Omit<RequestEphemeralSessionOptions, "pairing"> & {
  brokerBaseUrl: string;
  createDialog?: (options: PairingCodeDialogOptions) => PairingCodeDialog;
  dialog?: Omit<PairingCodeDialogOptions, "brokerBaseUrl">;
};

export type ValueProvider<T> = T | (() => T | Promise<T>);

export type PlayOnArtComputerButtonOptions = {
  container: HTMLElement | string;
  playlist: ValueProvider<Dp1Playlist>;
  brokerBaseUrl: ValueProvider<string>;
  relayerBaseUrl?: ValueProvider<string | undefined>;
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
  dialog?: Omit<PairingCodeDialogOptions, "brokerBaseUrl">;
  createDialog?: (options: PairingCodeDialogOptions) => PairingCodeDialog;
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

export const defaultPairingCodeDialogCopy: PairingCodeDialogCopy = {
  title: "Pair with Art Computer",
  intro: "Enter the Browser Pairing code from your FF1 to approve this browser for playback.",
  instructions: [
    "Make sure the FF1 is open and connected.",
    "Open the Feral File mobile app.",
    "Go to Settings -> Art Computers.",
    "Select the FF1 you want to use.",
    "In Browser Pairing, toggle pairing mode on, then enter the code shown for that FF1."
  ],
  codeLabel: "Pairing code",
  codePlaceholder: "123456",
  submitLabel: "Continue",
  cancelLabel: "Cancel",
  approvalTitle: "Approve in Feral File",
  approvalBody: "Open the Feral File mobile app to approve this browser session.",
  errorTitle: "Pairing failed"
};

export function pairingErrorMessage(error: unknown): string {
  if (error instanceof PlayError && error.code !== undefined) {
    switch (error.code) {
      // The broker drops a code from its index the moment its channel expires
      // or closes, so an expired code answers 404, not 410. To the person
      // typing it, "not found" is the same event as "expired": say that.
      case "pairing_code_not_found":
        return "This pairing code is no longer valid. Codes expire after a few minutes, so turn Browser Pairing on again and enter the new code.";
      case "pairing_code_expired":
        return "Pairing code expired. Turn Browser Pairing on again and enter the new code.";
      case "pairing_code_used":
        return "Pairing code was already used. Turn Browser Pairing on again and enter the new code.";
      case "mint_rejected":
        return "The browser session was not approved in Feral File.";
      case "approval_timeout":
        return "Timed out waiting for approval in Feral File.";
      case "session_rejected":
        return "The stored browser session was rejected. Pair again.";
      default:
        break;
    }
  }
  const raw = error instanceof Error ? error.message : "request failed";
  if (raw === "short-code resolution failed: 404") {
    return "This pairing code is no longer valid. Codes expire after a few minutes, so turn Browser Pairing on again and enter the new code.";
  }
  if (raw === "short-code resolution failed: 410") {
    return "Pairing code expired. Turn Browser Pairing on again and enter the new code.";
  }
  if (raw === "channel join failed: 401") {
    return "Pairing code was already used. Turn Browser Pairing on again and enter the new code.";
  }
  if (raw === "mint request rejected") {
    return "The browser session was not approved in Feral File.";
  }
  if (raw === "poll timed out") {
    return "Timed out waiting for approval in Feral File.";
  }
  return raw;
}

export function clearStoredEphemeralBrowserSession(storage: TokenStorage, origin: string): void {
  storage.removeItem(`ff:ephemeral-browser-session:${origin}`);
}

export function hasStoredEphemeralBrowserSession(storage: TokenStorage, origin: string): boolean {
  return readStoredEphemeralBrowserSession(storage, origin) !== undefined;
}

export function createPairingCodeDialog(options: PairingCodeDialogOptions): PairingCodeDialog {
  const ownerDocument = options.document ?? requiredDocument();
  ensureDefaultStyles(ownerDocument);
  const copy = { ...defaultPairingCodeDialogCopy, ...options.copy };
  const overlay = ownerDocument.createElement("div");
  overlay.className = className("ff-ac-pairing-overlay", options.classNames?.overlay);
  overlay.setAttribute("role", "presentation");

  const panel = ownerDocument.createElement("section");
  panel.className = className("ff-ac-pairing-panel", options.classNames?.panel);
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.setAttribute("aria-labelledby", "ff-ac-pairing-title");
  overlay.append(panel);

  const title = ownerDocument.createElement("h2");
  title.id = "ff-ac-pairing-title";
  title.className = className("ff-ac-pairing-title", options.classNames?.title);
  title.textContent = copy.title;

  const intro = ownerDocument.createElement("p");
  intro.className = className("ff-ac-pairing-intro", options.classNames?.intro);
  intro.textContent = copy.intro;

  const instructionList = ownerDocument.createElement("ol");
  instructionList.className = className("ff-ac-pairing-steps", options.classNames?.instructions);
  for (const instruction of copy.instructions) {
    const item = ownerDocument.createElement("li");
    item.textContent = instruction;
    instructionList.append(item);
  }

  const form = ownerDocument.createElement("form");
  form.className = "ff-ac-pairing-form";

  const label = ownerDocument.createElement("label");
  label.className = className("ff-ac-pairing-label", options.classNames?.label);
  label.textContent = copy.codeLabel;

  const input = ownerDocument.createElement("input");
  input.className = className("ff-ac-pairing-input", options.classNames?.input);
  input.type = "text";
  input.inputMode = "numeric";
  input.autocomplete = "one-time-code";
  input.placeholder = copy.codePlaceholder;
  label.append(input);

  const message = ownerDocument.createElement("p");
  message.className = className("ff-ac-pairing-message", options.classNames?.message);
  message.setAttribute("aria-live", "polite");

  const actions = ownerDocument.createElement("div");
  actions.className = className("ff-ac-pairing-actions", options.classNames?.actions);

  const submit = ownerDocument.createElement("button");
  submit.className = className("ff-ac-pairing-primary", options.classNames?.primaryButton);
  submit.type = "submit";
  submit.textContent = copy.submitLabel;

  const cancel = ownerDocument.createElement("button");
  cancel.className = className("ff-ac-pairing-secondary", options.classNames?.secondaryButton);
  cancel.type = "button";
  cancel.textContent = copy.cancelLabel;
  actions.append(cancel, submit);
  form.append(label, message, actions);

  const approval = ownerDocument.createElement("div");
  approval.className = "ff-ac-pairing-approval";
  approval.hidden = true;

  const approvalTitle = ownerDocument.createElement("h3");
  approvalTitle.className = "ff-ac-pairing-approval-title";
  approvalTitle.textContent = copy.approvalTitle;

  const approvalBody = ownerDocument.createElement("p");
  approvalBody.className = "ff-ac-pairing-approval-body";
  approvalBody.textContent = copy.approvalBody;

  approval.append(approvalTitle, approvalBody);
  if (copy.cliNotice !== undefined && copy.cliNotice.length > 0) {
    const cliNotice = ownerDocument.createElement("p");
    cliNotice.className = "ff-ac-pairing-cli";
    cliNotice.textContent = copy.cliNotice;
    approval.append(cliNotice);
  }
  panel.append(title, intro, instructionList, form, approval);

  let settled = false;
  let promptPromise: Promise<PairingInput> | undefined;
  let resolvePrompt: ((pairing: PairingInput) => void) | undefined;
  let rejectPrompt: ((error: Error) => void) | undefined;

  function appendDialog(): void {
    if (!ownerDocument.body.contains(overlay)) {
      ownerDocument.body.append(overlay);
    }
    input.focus();
  }

  function close(): void {
    overlay.remove();
  }

  function showApprovalPending(): void {
    form.hidden = true;
    approval.hidden = false;
    message.textContent = "";
  }

  function showError(value: string): void {
    form.hidden = false;
    approval.hidden = true;
    message.textContent = `${copy.errorTitle}: ${value}`;
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const shortCode = input.value.trim();
    if (shortCode.length === 0) {
      showError("Pairing code is required.");
      return;
    }
    if (settled) {
      return;
    }
    settled = true;
    showApprovalPending();
    resolvePrompt?.({ brokerBaseUrl: options.brokerBaseUrl, shortCode });
  });

  cancel.addEventListener("click", () => {
    if (!settled) {
      settled = true;
      rejectPrompt?.(new PlayError("pairing canceled", "pairing_canceled"));
    }
    close();
  });

  return {
    prompt: () => {
      appendDialog();
      promptPromise ??= new Promise<PairingInput>((resolve, reject) => {
        resolvePrompt = resolve;
        rejectPrompt = reject;
      });
      return promptPromise;
    },
    showApprovalPending,
    showError,
    close
  };
}

export async function requestEphemeralSessionWithPairingUi(
  options: RequestEphemeralSessionWithPairingUiOptions
): Promise<EphemeralBrowserSession> {
  validateRequestedExpiresInSeconds(options.requestedExpiresInSeconds);
  const storage = resolveUiStorage(options.storage);
  const origin = currentOriginForUi();
  const existingSession = storage === undefined ? undefined : readStoredEphemeralBrowserSession(storage, origin);
  if (existingSession !== undefined) {
    return existingSession;
  }

  const createDialog = options.createDialog ?? createPairingCodeDialog;
  const dialog = createDialog({
    brokerBaseUrl: options.brokerBaseUrl,
    ...options.dialog
  });
  try {
    const pairing = await dialog.prompt();
    dialog.showApprovalPending();
    const session = await requestEphemeralSession({
      pairing,
      ...(options.browserInfo === undefined ? {} : { browserInfo: options.browserInfo }),
      ...(options.storage === undefined ? {} : { storage: options.storage }),
      ...(options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs }),
      ...(options.maxWaitMs === undefined ? {} : { maxWaitMs: options.maxWaitMs }),
      ...(options.requestedExpiresInSeconds === undefined ? {} : { requestedExpiresInSeconds: options.requestedExpiresInSeconds }),
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl })
    });
    dialog.close();
    return session;
  } catch (error) {
    dialog.close();
    throw error;
  }
}

export function mountPlayOnArtComputerButton(options: PlayOnArtComputerButtonOptions): PlayOnArtComputerButtonHandle {
  validateRequestedExpiresInSeconds(options.requestedExpiresInSeconds);
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
      setStatus(options, status, "Enter the Browser Pairing code shown for your FF1.");
    }
    const session = await requestEphemeralSessionWithPairingUi({
      brokerBaseUrl,
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
  padding: 24px;
  background: rgba(18, 18, 18, 0.72);
}
.ff-ac-pairing-panel {
  box-sizing: border-box;
  width: min(520px, 100%);
  max-height: min(760px, calc(100vh - 48px));
  overflow: auto;
  border: 1px solid #d7d2c8;
  border-radius: 8px;
  background: #fbfaf7;
  color: #1d1d1b;
  padding: 24px;
  box-shadow: 0 24px 80px rgba(0, 0, 0, 0.28);
  font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
.ff-ac-pairing-title {
  margin: 0;
  font-size: 22px;
  line-height: 1.25;
}
.ff-ac-pairing-intro,
.ff-ac-pairing-approval-body,
.ff-ac-pairing-cli,
.ff-ac-play-status {
  line-height: 1.5;
}
.ff-ac-pairing-intro {
  margin: 10px 0 0;
  color: #56534d;
}
.ff-ac-pairing-steps {
  margin: 18px 0;
  padding-left: 24px;
  color: #2b2a27;
}
.ff-ac-pairing-steps li {
  margin-top: 8px;
}
.ff-ac-pairing-label {
  display: grid;
  gap: 8px;
  font-weight: 700;
}
.ff-ac-pairing-input {
  box-sizing: border-box;
  width: 100%;
  height: 48px;
  border: 1px solid #bdb7ac;
  border-radius: 6px;
  padding: 0 14px;
  background: #ffffff;
  color: #171614;
  font: 700 20px/1 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
}
.ff-ac-pairing-input:focus {
  border-color: #df3f2d;
  outline: 3px solid rgba(223, 63, 45, 0.2);
}
.ff-ac-pairing-message {
  min-height: 22px;
  margin: 10px 0 0;
  color: #b42318;
  font-weight: 700;
}
.ff-ac-pairing-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 18px;
}
.ff-ac-pairing-primary,
.ff-ac-pairing-secondary,
.ff-ac-play-button {
  min-height: 42px;
  border-radius: 6px;
  padding: 0 16px;
  font-weight: 800;
  cursor: pointer;
}
.ff-ac-pairing-primary,
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
.ff-ac-pairing-approval-title {
  margin: 0;
  font-size: 18px;
}
.ff-ac-pairing-approval-body {
  margin: 10px 0 0;
}
.ff-ac-pairing-cli {
  margin: 12px 0 0;
  color: #6c675f;
  font-size: 14px;
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
