import { afterEach, describe, expect, it, vi } from "vitest";
import { RelayClient } from "../src/relay-client.js";
import { mountPlayOnArtComputerButton } from "../src/ui.js";
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
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

  public removeEventListener(type: string, listener: EventListener): void {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((item) => item !== listener));
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

describe("mountPlayOnArtComputerButton", () => {
  it("reports the blocked secure integration without sending plaintext", async () => {
    vi.stubGlobal("WebSocket", class extends EventTarget {
      binaryType = "";
      close() { /* No network in this test. */ }
      send() { /* Adapter mocked below. */ }
    });
    const request = vi.spyOn(RelayClient.prototype, "requestPrepared");
    vi.spyOn(RelayClient.prototype, "close").mockImplementation(() => undefined);
    const { document } = fakeDocumentWithContainer();
    const success = vi.fn();
    const error = vi.fn();
    const handle = mountPlayOnArtComputerButton({
      container: "#play-button-container", document,
      deviceId: "FF1-TEST", relayerBaseUrl: "https://relay.example",
      playlist: { title: "Browser Playlist", items: [] }, onSuccess: success, onError: error
    });
    handle.element.click();
    await waitFor(() => error.mock.calls.length > 0);
    expect(success).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledOnce();
    expect(request).not.toHaveBeenCalled();
    expect(handle.element.disabled).toBe(false);
    expect(handle.statusElement.textContent).toBe("Protected pairing and casting are not available in this build.");
    handle.destroy();
    vi.unstubAllGlobals();
  });
});
