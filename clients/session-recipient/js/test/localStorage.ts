/**
 * Installs a Map-backed `localStorage` on `globalThis` for one test and
 * returns its entries; `uninstallLocalStorage` removes it again. Node has no
 * `localStorage`, so a test without this sees the browser case where none is
 * available.
 */
export function installLocalStorage(initial: Iterable<[string, string]> = []): Map<string, string> {
  const entries = new Map<string, string>(initial);
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => {
        entries.set(key, value);
      },
      removeItem: (key: string) => {
        entries.delete(key);
      }
    }
  });
  return entries;
}

export function uninstallLocalStorage(): void {
  Reflect.deleteProperty(globalThis, "localStorage");
}
