import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlayError } from "../src/errors.js";
import {
  clearStoredEphemeralBrowserSession,
  defaultPairingCodeDialogCopy,
  hasStoredEphemeralBrowserSession,
  mountPlayOnArtComputerButton,
  pairingErrorMessage,
  requestEphemeralSessionWithPairingUi,
  storeEphemeralBrowserSession,
  type PairingCodeDialogOptions,
  type TokenStorage
} from "../src/index.js";

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

function memoryStorage(): TokenStorage & { entries: Map<string, string> } {
  const entries = new Map<string, string>();
  return {
    entries,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => {
      entries.set(key, value);
    },
    removeItem: (key) => {
      entries.delete(key);
    }
  };
}

class FakeElement {
  public id = "";
  public className = "";
  public textContent = "";
  public type = "";
  public disabled = false;
  public hidden = false;
  public inputMode = "";
  public autocomplete = "";
  public placeholder = "";
  public value = "";
  public readonly children: FakeElement[] = [];
  public readonly attributes = new Map<string, string>();
  public focused = false;
  public readonly tagName: string;
  private parent: FakeElement | undefined;
  private readonly listeners = new Map<string, ((event: Event) => void)[]>();

  public constructor(tagName = "div") {
    this.tagName = tagName;
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

  public click(): void {
    for (const listener of this.listeners.get("click") ?? []) {
      listener(new Event("click"));
    }
  }
}

class FakeDocument {
  public readonly head = new FakeElement();
  public readonly body = new FakeElement();
  public title = "Sample";

  public createElement(tagName: string): FakeElement {
    return new FakeElement(tagName);
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

function fakeDocumentWithContainer(): { document: Document; container: HTMLElement } {
  const fakeDocument = new FakeDocument();
  const container = fakeDocument.createElement("div");
  container.id = "play-button-container";
  fakeDocument.body.append(container);
  return {
    document: fakeDocument as unknown as Document,
    container: container as unknown as HTMLElement
  };
}

async function nextTick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
}

describe("pairing UI copy", () => {
  it("documents the FF1 mobile-app path and approval handoff", () => {
    expect(defaultPairingCodeDialogCopy.instructions).toEqual([
      "Make sure the FF1 is open and connected.",
      "Open the Feral File mobile app.",
      "Go to Settings -> Art Computers.",
      "Select the FF1 you want to use.",
      "In Browser Pairing, toggle pairing mode on, then enter the code shown for that FF1."
    ]);
    expect(defaultPairingCodeDialogCopy.approvalBody).toBe("Open the Feral File mobile app to approve this browser session.");
    expect(defaultPairingCodeDialogCopy.cliNotice).toBeUndefined();
  });

  it("maps broker and approval failures to bounded user-facing messages", () => {
    // An expired code reads 404 from the broker, which drops it from its
    // index on expiry; the person typing it must be told to get a new one.
    expect(pairingErrorMessage(new Error("short-code resolution failed: 404"))).toContain("no longer valid");
    expect(pairingErrorMessage(new Error("short-code resolution failed: 404"))).toContain("enter the new code");
    expect(pairingErrorMessage(new PlayError("short-code resolution failed: 404", "pairing_code_not_found"))).toContain(
      "no longer valid"
    );
    expect(pairingErrorMessage(new Error("short-code resolution failed: 410"))).toContain("Pairing code expired");
    expect(pairingErrorMessage(new Error("channel join failed: 401"))).toContain("already used");
    expect(pairingErrorMessage(new Error("mint request rejected"))).toBe("The browser session was not approved in Feral File.");
    expect(pairingErrorMessage(new Error("poll timed out"))).toBe("Timed out waiting for approval in Feral File.");
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

  it("opens the pairing dialog with the mounted document when no local session exists", async () => {
    const storage = memoryStorage();
    const { document } = fakeDocumentWithContainer();
    const createDialog = vi.fn((options: PairingCodeDialogOptions) => {
      expect(options.document).toBe(document);
      return {
        prompt: () => Promise.reject(new Error("pairing canceled")),
        showApprovalPending: vi.fn(),
        showError: vi.fn(),
        close: vi.fn()
      };
    });
    let rejected = false;
    const handle = mountPlayOnArtComputerButton({
      container: "#play-button-container",
      playlist: { dpVersion: "1.1.0", title: "Needs Pairing Playlist", items: [] },
      brokerBaseUrl: "https://pairing.example",
      storage: { storage },
      document,
      createDialog,
      onError: () => {
        rejected = true;
      }
    });

    handle.element.click();
    await nextTick();

    expect(rejected).toBe(true);
    expect(createDialog).toHaveBeenCalledWith(expect.objectContaining({
      brokerBaseUrl: "https://pairing.example",
      document
    }));
  });
});
