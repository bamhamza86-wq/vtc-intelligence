/**
 * storage.ts — Wrapper localStorage iframe-safe (sessionStorage fallback + memory)
 * Utilisé partout dans le code pour éviter les crashs dans iframes tiers.
 */

type StorageBackend = Storage | null;

let memoryStore: Record<string, string> = {};

function safeSessionStorage(): StorageBackend {
  try {
    if (typeof window !== "undefined" && window.sessionStorage) {
      // Test d'écriture rapide
      window.sessionStorage.setItem("__probe__", "1");
      window.sessionStorage.removeItem("__probe__");
      return window.sessionStorage;
    }
  } catch {
    // iframe restrictions
  }
  return null;
}

const backend = safeSessionStorage();

export const ls = {
  get(key: string): string | null {
    try {
      if (backend) return backend.getItem(key);
    } catch {}
    return key in memoryStore ? memoryStore[key] : null;
  },
  set(key: string, value: string): void {
    try {
      if (backend) {
        backend.setItem(key, value);
        return;
      }
    } catch {}
    memoryStore[key] = value;
  },
  remove(key: string): void {
    try {
      if (backend) backend.removeItem(key);
    } catch {}
    delete memoryStore[key];
  },
  clear(): void {
    try {
      if (backend) backend.clear();
    } catch {}
    memoryStore = {};
  },
};

export default ls;
