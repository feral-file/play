import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import qrcode from "qrcode-generator";
import { PlayError } from "../src/errors.js";
import {
  clearStoredEphemeralBrowserSession,
  createPairingDialog,
  defaultPairingDialogCopy,
  hasStoredEphemeralBrowserSession,
  isTouchDevice,
  mountPlayOnArtComputerButton,
  pairingErrorMessage,
  renderQrSvg,
  requestEphemeralSessionWithPairingUi,
  storeEphemeralBrowserSession,
  type PairingDialog,
  type PairingDialogOptions,
  type PairingMaterial
} from "../src/index.js";
import { brokerBaseUrl, captureError, expectNoSecrets, fakeBroker, jsonResponse, memoryStorage, requestUrl } from "./fakeBroker.js";

const testOrigin = "https://nft.example";
let previousLocationDescriptor: PropertyDescriptor | undefined;
let previousHTMLElementDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
  previousLocationDescriptor = Object.getOwnPropertyDescriptor(globalThis, "location");
  previousHTMLElementDescriptor = Object.getOwnPropertyDescriptor(globalThis, "HTMLElement");
  Object.defineProperty(globalThis, "location", {
    configurable: true,
    value: { origin: testOrigin }
  });
  Object.defineProperty(globalThis, "HTMLElement", {
    configurable: true,
    value: FakeElement
  });
});

afterEach(() => {
  if (previousLocationDescriptor === undefined) {
    Reflect.deleteProperty(globalThis, "location");
  } else {
    Object.defineProperty(globalThis, "location", previousLocationDescriptor);
  }
  if (previousHTMLElementDescriptor === undefined) {
    Reflect.deleteProperty(globalThis, "HTMLElement");
  } else {
    Object.defineProperty(globalThis, "HTMLElement", previousHTMLElementDescriptor);
  }
});

class FakeElement {
  public id = "";
  public className = "";
  public textContent = "";
  public type = "";
  public href = "";
  public target = "";
  public disabled = false;
  public hidden = false;
  public focused = false;
  public readonly children: FakeElement[] = [];
  public readonly attributes = new Map<string, string>();
  public readonly tagName: string;
  public readonly namespaceURI: string | undefined;
  private parent: FakeElement | undefined;
  private readonly listeners = new Map<string, ((event: Event) => void)[]>();

  public constructor(tagName = "div", namespaceURI?: string) {
    this.tagName = tagName;
    this.namespaceURI = namespaceURI;
  }

  public append(...elements: FakeElement[]): void {
    for (const element of elements) {
      element.parent = this;
      this.children.push(element);
    }
  }

  public remove(): void {
    if (this.parent === undefined) {
      return;
    }
    const index = this.parent.children.indexOf(this);
    if (index >= 0) {
      this.parent.children.splice(index, 1);
    }
    this.parent = undefined;
  }

  public contains(element: FakeElement): boolean {
    return this === element || this.children.some((child) => child.contains(element));
  }

  public setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  public getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  public addEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: AddEventListenerOptions): void {
    const callback = typeof listener === "function" ? listener : (event: Event) => {
      listener.handleEvent(event);
    };
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(callback);
    this.listeners.set(type, listeners);
    options?.signal?.addEventListener("abort", () => {
      const remaining = (this.listeners.get(type) ?? []).filter((candidate) => candidate !== callback);
      this.listeners.set(type, remaining);
    }, { once: true });
  }

  public focus(): void {
    this.focused = true;
  }

  public querySelector(selector: string): FakeElement | null {
    return this.findTag(selector) ?? null;
  }

  public click(): void {
    for (const listener of this.listeners.get("click") ?? []) {
      listener(new Event("click"));
    }
  }

  /** Depth-first search by class name token. */
  public find(classToken: string): FakeElement | undefined {
    if (this.className.split(" ").includes(classToken)) {
      return this;
    }
    for (const child of this.children) {
      const found = child.find(classToken);
      if (found !== undefined) {
        return found;
      }
    }
    return undefined;
  }

  public findTag(tagName: string): FakeElement | undefined {
    if (this.tagName === tagName) {
      return this;
    }
    for (const child of this.children) {
      const found = child.findTag(tagName);
      if (found !== undefined) {
        return found;
      }
    }
    return undefined;
  }
}

type FakeView = {
  innerWidth: number;
  innerHeight: number;
  matchMedia: (query: string) => { matches: boolean };
  navigator: { maxTouchPoints: number; clipboard?: { writeText: (text: string) => Promise<void> } };
};

function fakeView(input: { width: number; height: number; coarse: boolean; touchPoints: number; clipboard?: { writeText: (text: string) => Promise<void> } }): FakeView {
  return {
    innerWidth: input.width,
    innerHeight: input.height,
    matchMedia: (query) => ({ matches: query === "(pointer: coarse)" && input.coarse }),
    navigator: {
      maxTouchPoints: input.touchPoints,
      ...(input.clipboard === undefined ? {} : { clipboard: input.clipboard })
    }
  };
}

const phoneView = (): FakeView => fakeView({ width: 390, height: 844, coarse: true, touchPoints: 5 });
const desktopView = (): FakeView => fakeView({ width: 1440, height: 900, coarse: false, touchPoints: 0 });

class FakeDocument {
  public readonly head = new FakeElement();
  public readonly body = new FakeElement();
  public title = "Sample";
  public defaultView: FakeView | null;

  public constructor(view: FakeView | null = null) {
    this.defaultView = view;
  }

  public createElement(tagName: string): FakeElement {
    return new FakeElement(tagName);
  }

  public createElementNS(namespaceURI: string, tagName: string): FakeElement {
    return new FakeElement(tagName, namespaceURI);
  }

  public getElementById(id: string): FakeElement | null {
    return this.findById(this.head, id) ?? this.findById(this.body, id) ?? null;
  }

  public querySelector(selector: string): FakeElement | null {
    if (!selector.startsWith("#")) {
      return null;
    }
    return this.getElementById(selector.slice(1));
  }

  private findById(element: FakeElement, id: string): FakeElement | undefined {
    if (element.id === id) {
      return element;
    }
    for (const child of element.children) {
      const found = this.findById(child, id);
      if (found !== undefined) {
        return found;
      }
    }
    return undefined;
  }
}

function fakeDocumentWithContainer(view: FakeView | null = null): { document: Document; fake: FakeDocument; container: HTMLElement } {
  const fakeDocument = new FakeDocument(view);
  const container = fakeDocument.createElement("div");
  container.id = "play-button-container";
  fakeDocument.body.append(container);
  return {
    document: fakeDocument as unknown as Document,
    fake: fakeDocument,
    container: container as unknown as HTMLElement
  };
}

async function nextTick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let tick = 0; tick < 200 && !condition(); tick += 1) {
    await nextTick();
  }
}

const material: PairingMaterial = {
  appLink: "https://link.feralfile.com/pair?channel=ch_1&token=pt_1",
  shortCode: "482913",
  expiresAt: "2030-01-01T00:00:00.000Z"
};

function openDialog(view: FakeView | null, options: Partial<PairingDialogOptions> = {}): { fake: FakeDocument; dialog: PairingDialog; onCancel: ReturnType<typeof vi.fn> } {
  const fake = new FakeDocument(view);
  const onCancel = vi.fn();
  const dialog = createPairingDialog({ document: fake as unknown as Document, onCancel, ...options });
  dialog.show(material);
  return { fake, dialog, onCancel };
}

function required(element: FakeElement | undefined, what: string): FakeElement {
  if (element === undefined) {
    throw new Error(`missing ${what}`);
  }
  return element;
}

describe("pairing dialog copy", () => {
  it("says what the visitor does on a phone and on a desktop", () => {
    expect(defaultPairingDialogCopy.openAppLabel).toBe("Open the Feral File app");
    expect(defaultPairingDialogCopy.codeLabel).toBe("Or enter this code in the app");
    expect(defaultPairingDialogCopy.qrCaption).toBe("Scan with your phone camera or the Feral File app");
    expect(defaultPairingDialogCopy.waitingStatus).toBe("Waiting for your Art Computer…");
    expect(defaultPairingDialogCopy.approveStatus).toBe("Approve in the Feral File app…");
  });

  it("maps pairing and approval failures to bounded user-facing messages", () => {
    expect(pairingErrorMessage(new PlayError("pairing code expired", "pairing_code_expired"))).toContain("expired");
    expect(pairingErrorMessage(new PlayError("pairing canceled", "pairing_canceled"))).toBe("Pairing canceled.");
    expect(pairingErrorMessage(new PlayError("mint request rejected", "mint_rejected"))).toBe("The browser session was not approved in Feral File.");
    expect(pairingErrorMessage(new PlayError("poll timed out", "approval_timeout"))).toContain("Timed out");
    expect(pairingErrorMessage(new PlayError("browser session rejected", "session_rejected"))).toContain("Pair again");
    expect(pairingErrorMessage(new Error("channel create failed: 429"))).toBe("channel create failed: 429");
  });
});

describe("layout detection", () => {
  it.each([
    { name: "a phone", view: phoneView(), touch: true },
    { name: "a phone in landscape", view: fakeView({ width: 844, height: 390, coarse: true, touchPoints: 5 }), touch: true },
    { name: "a touch-only phone without a coarse-pointer query", view: fakeView({ width: 390, height: 844, coarse: false, touchPoints: 5 }), touch: true },
    { name: "a tablet", view: fakeView({ width: 1024, height: 1366, coarse: true, touchPoints: 5 }), touch: true },
    { name: "a large touch screen", view: fakeView({ width: 1920, height: 1080, coarse: false, touchPoints: 10 }), touch: true },
    { name: "a desktop", view: desktopView(), touch: false },
    { name: "a narrow desktop window", view: fakeView({ width: 400, height: 900, coarse: false, touchPoints: 0 }), touch: false }
  ])("treats $name as touch=$touch", ({ view, touch }) => {
    expect(isTouchDevice(view as unknown as Window)).toBe(touch);
  });

  it("falls back to the QR layout without a window", () => {
    expect(isTouchDevice(null)).toBe(false);
  });
});

describe("createPairingDialog", () => {
  it("on a phone offers the app link as a button and the code below it, with no QR", () => {
    const { fake } = openDialog(phoneView());
    const panel = required(fake.body.find("ff-ac-pairing-panel"), "panel");
    expect(panel.getAttribute("data-layout")).toBe("mobile");
    const appLink = required(panel.find("ff-ac-pairing-app-link"), "app link");
    expect(appLink.tagName).toBe("a");
    expect(appLink.href).toBe(material.appLink);
    expect(appLink.target).toBe("_self");
    expect(appLink.textContent).toBe("Open the Feral File app");
    expect(required(panel.find("ff-ac-pairing-code-label"), "code label").textContent).toBe("Or enter this code in the app");
    expect(required(panel.find("ff-ac-pairing-code"), "code").textContent).toBe("482913");
    expect(panel.findTag("svg")).toBeUndefined();
    expect(required(panel.find("ff-ac-pairing-status"), "status").textContent).toBe("Waiting for your Art Computer…");
    expect(appLink.focused).toBe(true);
  });

  it("on a desktop renders the app link as a local QR code with a caption and the code, with no link button", () => {
    const { fake } = openDialog(desktopView());
    const panel = required(fake.body.find("ff-ac-pairing-panel"), "panel");
    expect(panel.getAttribute("data-layout")).toBe("desktop");
    expect(panel.find("ff-ac-pairing-app-link")).toBeUndefined();
    const svg = required(panel.findTag("svg"), "QR svg");
    expect(svg.namespaceURI).toBe("http://www.w3.org/2000/svg");
    expect(svg.getAttribute("aria-label")).toBe(defaultPairingDialogCopy.qrLabel);
    expect(required(panel.find("ff-ac-pairing-caption"), "caption").textContent).toBe("Scan with your phone camera or the Feral File app");
    expect(required(panel.find("ff-ac-pairing-code"), "code").textContent).toBe("482913");
    expect(required(panel.find("ff-ac-pairing-code"), "code").focused).toBe(true);
  });

  it("on a tablet offers the app link as a button, not a QR", () => {
    const { fake } = openDialog(fakeView({ width: 1024, height: 1366, coarse: true, touchPoints: 5 }));
    expect(fake.body.find("ff-ac-pairing-app-link")).toBeDefined();
    expect(fake.body.findTag("svg")).toBeUndefined();
  });

  it("honours an explicit layout", () => {
    const { fake } = openDialog(desktopView(), { layout: "mobile" });
    expect(fake.body.find("ff-ac-pairing-app-link")).toBeDefined();
  });

  it("copies the code on tap and confirms it", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    const { fake } = openDialog(fakeView({ width: 390, height: 844, coarse: true, touchPoints: 5, clipboard: { writeText } }));
    const code = required(fake.body.find("ff-ac-pairing-code"), "code");
    const hint = required(fake.body.find("ff-ac-pairing-copy-hint"), "hint");
    expect(code.tagName).toBe("button");
    expect(hint.textContent).toBe("Tap to copy");

    code.click();
    await nextTick();

    expect(writeText).toHaveBeenCalledWith("482913");
    expect(hint.textContent).toBe("Copied");
  });

  it("keeps the code on screen when the clipboard refuses", async () => {
    const writeText = vi.fn(() => Promise.reject(new Error("denied")));
    const { fake } = openDialog(fakeView({ width: 390, height: 844, coarse: true, touchPoints: 5, clipboard: { writeText } }));
    required(fake.body.find("ff-ac-pairing-code"), "code").click();
    await nextTick();
    expect(required(fake.body.find("ff-ac-pairing-copy-hint"), "hint").textContent).toBe("Tap to copy");
    expect(required(fake.body.find("ff-ac-pairing-code"), "code").textContent).toBe("482913");
  });

  it("re-renders fresh material in place when a channel is replaced", () => {
    const { fake, dialog } = openDialog(phoneView());
    dialog.show({ appLink: "https://link.feralfile.com/pair?channel=ch_2&token=pt_2", shortCode: "771204", expiresAt: material.expiresAt });
    const panels = fake.body.children.filter((child) => child.find("ff-ac-pairing-panel") !== undefined);
    expect(panels).toHaveLength(1);
    const appLinks = required(fake.body.find("ff-ac-pairing-primary-area"), "primary").children;
    expect(appLinks).toHaveLength(1);
    expect(appLinks[0]?.href).toBe("https://link.feralfile.com/pair?channel=ch_2&token=pt_2");
    expect(required(fake.body.find("ff-ac-pairing-code"), "code").textContent).toBe("771204");
  });

  it("applies copy and class-name overrides", () => {
    const { fake } = openDialog(phoneView(), {
      copy: { openAppLabel: "Open the app", codeLabel: "Code" },
      classNames: { appLink: "site-button", code: "site-code" }
    });
    const appLink = required(fake.body.find("site-button"), "app link");
    expect(appLink.textContent).toBe("Open the app");
    expect(required(fake.body.find("site-code"), "code").textContent).toBe("482913");
    expect(required(fake.body.find("ff-ac-pairing-code-label"), "label").textContent).toBe("Code");
  });

  it("cancels: calls onCancel and removes the dialog", () => {
    const { fake, onCancel } = openDialog(desktopView());
    const cancel = required(fake.body.find("ff-ac-pairing-secondary"), "cancel");
    cancel.click();
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(fake.body.find("ff-ac-pairing-panel")).toBeUndefined();
  });

  it("does not attach the dialog before there is material to show", () => {
    const fake = new FakeDocument(desktopView());
    createPairingDialog({ document: fake as unknown as Document, onCancel: vi.fn() });
    expect(fake.body.find("ff-ac-pairing-panel")).toBeUndefined();
  });
});

describe("renderQrSvg", () => {
  it("draws exactly the dark modules of the QR for the app link, inside a quiet zone", () => {
    const fake = new FakeDocument();
    const svg = renderQrSvg(fake as unknown as Document, material.appLink, "QR") as unknown as FakeElement;
    const expected = qrcode(0, "M");
    expected.addData(material.appLink, "Byte");
    expected.make();
    const modules = expected.getModuleCount();
    expect(svg.getAttribute("viewBox")).toBe(`0 0 ${String(modules + 8)} ${String(modules + 8)}`);
    const path = required(svg.findTag("path"), "path").getAttribute("d") ?? "";
    let dark = 0;
    for (let row = 0; row < modules; row += 1) {
      for (let col = 0; col < modules; col += 1) {
        if (expected.isDark(row, col)) {
          dark += 1;
          expect(path).toContain(`M${String(col + 4)} ${String(row + 4)}h1v1h-1z`);
        }
      }
    }
    expect(path.split("M").length - 1).toBe(dark);
  });
});

describe("requestEphemeralSessionWithPairingUi", () => {
  function recordingDialog(): { createDialog: (options: PairingDialogOptions) => PairingDialog; events: string[]; materials: PairingMaterial[]; options: PairingDialogOptions[] } {
    const events: string[] = [];
    const materials: PairingMaterial[] = [];
    const options: PairingDialogOptions[] = [];
    return {
      events,
      materials,
      options,
      createDialog: (dialogOptions) => {
        options.push(dialogOptions);
        return {
          show: (shown) => {
            materials.push(shown);
            events.push(`show ${shown.shortCode}`);
          },
          setStatus: (text) => events.push(`status ${text}`),
          close: () => events.push("close")
        };
      }
    };
  }

  it("shows the material, walks the statuses, closes, and returns the session", async () => {
    const broker = await fakeBroker();
    const dialog = recordingDialog();
    const session = await requestEphemeralSessionWithPairingUi({
      brokerBaseUrl,
      storage: false,
      pollIntervalMs: 1,
      fetchImpl: broker.fetchImpl,
      createDialog: dialog.createDialog
    });
    expect(session.sessionId).toBe("sess_123");
    expect(dialog.materials[0]?.appLink).toBe("https://link.feralfile.com/pair?channel=ch_1&token=pt_secret_1");
    expect(dialog.events).toEqual([
      "show 123451",
      "status Waiting for your Art Computer…",
      "status Approve in the Feral File app…",
      "status Approved. Starting playback…",
      "close"
    ]);
  });

  it("regenerates an expired channel and shows the new code", async () => {
    const broker = await fakeBroker({ expiredChannels: 1 });
    const dialog = recordingDialog();
    await requestEphemeralSessionWithPairingUi({
      brokerBaseUrl,
      storage: false,
      pollIntervalMs: 1,
      fetchImpl: broker.fetchImpl,
      createDialog: dialog.createDialog
    });
    expect(dialog.materials.map((shown) => shown.shortCode)).toEqual(["123451", "123452"]);
  });

  it("gives up with approval_timeout after two replacement channels expire", async () => {
    const broker = await fakeBroker({ expiredChannels: 3 });
    const dialog = recordingDialog();
    const error = await captureError(requestEphemeralSessionWithPairingUi({
      brokerBaseUrl,
      storage: false,
      pollIntervalMs: 1,
      fetchImpl: broker.fetchImpl,
      createDialog: dialog.createDialog
    }));
    expect((error as PlayError).code).toBe("approval_timeout");
    expectNoSecrets(error);
    expect(dialog.materials).toHaveLength(3);
    expect(dialog.events.at(-1)).toBe("close");
  });

  it("rejects with pairing_canceled when the visitor cancels", async () => {
    const broker = await fakeBroker({ waitingPolls: Number.MAX_SAFE_INTEGER });
    const dialog = recordingDialog();
    const pending = requestEphemeralSessionWithPairingUi({
      brokerBaseUrl,
      storage: false,
      pollIntervalMs: 5,
      fetchImpl: broker.fetchImpl,
      createDialog: dialog.createDialog
    });
    while (dialog.materials.length === 0) {
      await nextTick();
    }
    dialog.options[0]?.onCancel();
    const error = await captureError(pending);
    expect((error as PlayError).code).toBe("pairing_canceled");
    expect(broker.closed).toEqual(["ch_1"]);
  });

  it("rejects a bad appLinkBaseUrl before creating a dialog", async () => {
    const createDialog = vi.fn();
    await expect(requestEphemeralSessionWithPairingUi({
      brokerBaseUrl,
      appLinkBaseUrl: "javascript:alert(1)",
      storage: false,
      createDialog
    })).rejects.toThrow(/appLinkBaseUrl/);
    expect(createDialog).not.toHaveBeenCalled();
  });
});

describe("session UI helpers", () => {
  it("checks and clears origin-scoped stored sessions", () => {
    const storage = memoryStorage();
    expect(hasStoredEphemeralBrowserSession(storage, testOrigin)).toBe(false);
    storeEphemeralBrowserSession(storage, testOrigin, {
      token: "browser-session-token",
      sessionId: "sess_123",
      expiresAt: "2030-01-01T00:00:00.000Z"
    });
    expect(hasStoredEphemeralBrowserSession(storage, testOrigin)).toBe(true);
    clearStoredEphemeralBrowserSession(storage, testOrigin);
    expect(hasStoredEphemeralBrowserSession(storage, testOrigin)).toBe(false);
  });

  it("does not show the pairing dialog when a valid local session exists", async () => {
    const storage = memoryStorage();
    storeEphemeralBrowserSession(storage, testOrigin, {
      token: "browser-session-token",
      sessionId: "sess_123",
      expiresAt: "2030-01-01T00:00:00.000Z"
    });
    const createDialog = vi.fn(() => {
      throw new Error("dialog should not be created");
    });

    await expect(requestEphemeralSessionWithPairingUi({
      brokerBaseUrl: "https://pairing.example",
      storage: { storage },
      createDialog
    })).resolves.toEqual({
      token: "browser-session-token",
      sessionId: "sess_123",
      expiresAt: "2030-01-01T00:00:00.000Z"
    });
    expect(createDialog).not.toHaveBeenCalled();
  });

  it("rejects an invalid requested lifetime even when a session is cached", async () => {
    const storage = memoryStorage();
    storeEphemeralBrowserSession(storage, testOrigin, {
      token: "browser-session-token",
      sessionId: "sess_123",
      expiresAt: "2030-01-01T00:00:00.000Z"
    });

    await expect(requestEphemeralSessionWithPairingUi({
      brokerBaseUrl: "https://pairing.example",
      storage: { storage },
      requestedExpiresInSeconds: 1e21
    })).rejects.toThrow("requestedExpiresInSeconds must be a whole number of seconds from 1 to 31536000");
  });

  it("reuses a cached session with a valid requested lifetime", async () => {
    const storage = memoryStorage();
    storeEphemeralBrowserSession(storage, testOrigin, {
      token: "browser-session-token",
      sessionId: "sess_123",
      expiresAt: "2030-01-01T00:00:00.000Z"
    });

    await expect(requestEphemeralSessionWithPairingUi({
      brokerBaseUrl: "https://pairing.example",
      storage: { storage },
      requestedExpiresInSeconds: 3600
    })).resolves.toEqual({
      token: "browser-session-token",
      sessionId: "sess_123",
      expiresAt: "2030-01-01T00:00:00.000Z"
    });
  });
});

describe("mountPlayOnArtComputerButton", () => {
  it("casts with a stored local session without creating the pairing dialog", async () => {
    const storage = memoryStorage();
    storeEphemeralBrowserSession(storage, testOrigin, {
      token: "browser-session-token",
      sessionId: "sess_123",
      expiresAt: "2030-01-01T00:00:00.000Z",
      relayerBaseUrl: "https://relayer.example"
    });
    const { document } = fakeDocumentWithContainer();
    const createDialog = vi.fn(() => {
      throw new Error("dialog should not be created");
    });
    const fetchImpl = vi.fn<typeof fetch>((input) => {
      expect(requestUrl(input)).toBe("https://relayer.example/api/cast");
      return Promise.resolve(jsonResponse({ message: { ok: true } }));
    });
    let resolved = false;
    const handle = mountPlayOnArtComputerButton({
      container: "#play-button-container",
      playlist: { dpVersion: "1.1.0", title: "Stored Session Playlist", items: [] },
      brokerBaseUrl: "https://pairing.example",
      storage: { storage },
      fetchImpl,
      document,
      createDialog,
      onSuccess: () => {
        resolved = true;
      }
    });

    handle.element.click();
    await nextTick();

    expect(resolved).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(createDialog).not.toHaveBeenCalled();
  });

  it("refuses to mount with an invalid requested lifetime even when a session is cached", () => {
    const storage = memoryStorage();
    storeEphemeralBrowserSession(storage, testOrigin, {
      token: "browser-session-token",
      sessionId: "sess_123",
      expiresAt: "2030-01-01T00:00:00.000Z",
      relayerBaseUrl: "https://relayer.example"
    });
    const { document } = fakeDocumentWithContainer();
    const fetchImpl = vi.fn<typeof fetch>(() => {
      throw new Error("cast should not be attempted");
    });

    expect(() => mountPlayOnArtComputerButton({
      container: "#play-button-container",
      playlist: { dpVersion: "1.1.0", title: "Stored Session Playlist", items: [] },
      brokerBaseUrl: "https://pairing.example",
      storage: { storage },
      requestedExpiresInSeconds: 1e21,
      fetchImpl,
      document
    })).toThrow("requestedExpiresInSeconds must be a whole number of seconds from 1 to 31536000");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("casts with a cached session and a valid requested lifetime", async () => {
    const storage = memoryStorage();
    storeEphemeralBrowserSession(storage, testOrigin, {
      token: "browser-session-token",
      sessionId: "sess_123",
      expiresAt: "2030-01-01T00:00:00.000Z",
      relayerBaseUrl: "https://relayer.example"
    });
    const { document } = fakeDocumentWithContainer();
    const fetchImpl = vi.fn<typeof fetch>((input) => {
      expect(requestUrl(input)).toBe("https://relayer.example/api/cast");
      return Promise.resolve(jsonResponse({ message: { ok: true } }));
    });
    let resolved = false;
    const handle = mountPlayOnArtComputerButton({
      container: "#play-button-container",
      playlist: { dpVersion: "1.1.0", title: "Stored Session Playlist", items: [] },
      brokerBaseUrl: "https://pairing.example",
      storage: { storage },
      requestedExpiresInSeconds: 3600,
      fetchImpl,
      document,
      onSuccess: () => {
        resolved = true;
      }
    });

    handle.element.click();
    await nextTick();

    expect(resolved).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });


  it("refuses to mount with an invalid appLinkBaseUrl", () => {
    const { document } = fakeDocumentWithContainer();
    expect(() => mountPlayOnArtComputerButton({
      container: "#play-button-container",
      playlist: { dpVersion: "1.1.0", title: "Playlist", items: [] },
      brokerBaseUrl,
      appLinkBaseUrl: "javascript:alert(1)",
      document
    })).toThrow(/appLinkBaseUrl/);
  });

  it("pairs through the dialog on the mounted document, then casts with the new session", async () => {
    const storage = memoryStorage();
    const { document, fake } = fakeDocumentWithContainer(phoneView());
    const broker = await fakeBroker();
    const fetchImpl = vi.fn<typeof fetch>((input, init) => {
      if (requestUrl(input) === "https://relayer.example/api/cast") {
        return Promise.resolve(jsonResponse({ message: { ok: true } }));
      }
      return broker.fetchImpl(input, init);
    });
    let shownLink: string | undefined;
    const statuses: string[] = [];
    let resolved = false;
    const handle = mountPlayOnArtComputerButton({
      container: "#play-button-container",
      playlist: { dpVersion: "1.1.0", title: "Needs Pairing Playlist", items: [] },
      brokerBaseUrl,
      appLinkBaseUrl: "https://link.example/pair",
      storage: { storage },
      pollIntervalMs: 1,
      fetchImpl,
      document,
      createDialog: (options) => {
        expect(options.document).toBe(document);
        const dialog = createPairingDialog(options);
        return {
          ...dialog,
          show: (shown) => {
            dialog.show(shown);
            shownLink = fake.body.find("ff-ac-pairing-app-link")?.href;
          }
        };
      },
      onStatusChange: (message) => statuses.push(message),
      onSuccess: () => {
        resolved = true;
      }
    });

    handle.element.click();
    await waitFor(() => resolved);

    expect(resolved).toBe(true);
    expect(shownLink).toBe("https://link.example/pair?channel=ch_1&token=pt_secret_1");
    expect(fake.body.find("ff-ac-pairing-panel")).toBeUndefined();
    expect(hasStoredEphemeralBrowserSession(storage, testOrigin)).toBe(true);
    expect(statuses).toContain("Waiting for your Art Computer.");
    expect(statuses.at(-1)).toBe("Playlist sent to Art Computer.");
  });

  it("reports a canceled pairing without leaking tokens", async () => {
    const storage = memoryStorage();
    const { document } = fakeDocumentWithContainer(desktopView());
    const broker = await fakeBroker({ waitingPolls: Number.MAX_SAFE_INTEGER });
    let cancel: (() => void) | undefined;
    let failure: unknown;
    const statuses: string[] = [];
    const handle = mountPlayOnArtComputerButton({
      container: "#play-button-container",
      playlist: { dpVersion: "1.1.0", title: "Canceled Playlist", items: [] },
      brokerBaseUrl,
      storage: { storage },
      pollIntervalMs: 5,
      fetchImpl: broker.fetchImpl,
      document,
      createDialog: (options) => {
        cancel = options.onCancel;
        return createPairingDialog(options);
      },
      onStatusChange: (message) => statuses.push(message),
      onError: (error) => {
        failure = error;
      }
    });

    handle.element.click();
    while (broker.channels.length === 0) {
      await nextTick();
    }
    cancel?.();
    await waitFor(() => failure !== undefined);

    expect((failure as PlayError).code).toBe("pairing_canceled");
    expectNoSecrets(failure);
    expect(statuses.at(-1)).toBe("Pairing canceled.");
    expect(handle.element.disabled).toBe(false);
  });
});
