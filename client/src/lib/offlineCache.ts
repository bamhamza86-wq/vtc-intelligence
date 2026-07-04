// ──────────────────────────────────────────────────────────────────────────────
// offlineCache.ts — Mini-couche de persistance hors-ligne (IndexedDB vanilla)
// ──────────────────────────────────────────────────────────────────────────────
// Le projet n'a pas `idb-keyval` en dépendance (vérifié dans package.json) —
// on utilise donc l'API IndexedDB native directement, sans nouvelle dépendance.
//
// Usage typique (voir aussi exemple complet en bas de fichier / dans le rapport
// lot_a_report.md) :
//
//   import { saveOffline, getOffline } from "@/lib/offlineCache";
//
//   // Après un fetch réussi :
//   await saveOffline("zones-summary", data, 10 * 60 * 1000); // TTL 10 min
//
//   // Pour lire (ex: fallback quand offline ou requête TanStack Query en échec) :
//   const cached = await getOffline<ZonesSummary>("zones-summary");
//   if (cached) {
//     console.log(cached.data, cached.staleness); // staleness en ms
//   }
// ──────────────────────────────────────────────────────────────────────────────

const DB_NAME = "vtc-offline-cache";
const DB_VERSION = 1;
const STORE_NAME = "kv";

interface StoredRecord<T = unknown> {
  key: string;
  data: T;
  savedAt: number;
  ttlMs: number;
}

export interface OfflineResult<T> {
  data: T;
  /** Ancienneté de la donnée en millisecondes au moment de la lecture. */
  staleness: number;
  /** true si la donnée a dépassé son TTL (mais reste retournée quand même). */
  isStale: boolean;
}

// ──────────────────────────────────────────────────────────────────────────────
// Ouverture de la base (lazy, réutilisée entre appels)
// ──────────────────────────────────────────────────────────────────────────────
let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("IndexedDB indisponible dans cet environnement"));
  }

  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: "key" });
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  return dbPromise;
}

// ──────────────────────────────────────────────────────────────────────────────
// saveOffline — persiste une valeur avec un TTL indicatif (utilisé pour calculer
// la "staleness" à la lecture ; la donnée reste lisible même expirée).
// ──────────────────────────────────────────────────────────────────────────────
export async function saveOffline<T>(key: string, data: T, ttlMs: number): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      const store = tx.objectStore(STORE_NAME);
      const record: StoredRecord<T> = { key, data, savedAt: Date.now(), ttlMs };
      store.put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    // On ne bloque jamais l'app pour un échec de cache offline (ex: mode privé).
    // eslint-disable-next-line no-console
    console.warn("[offlineCache] échec saveOffline", key, err);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// getOffline — récupère la dernière valeur connue pour une clé, avec sa
// staleness (ms depuis la sauvegarde). Retourne null si rien n'est stocké.
// ──────────────────────────────────────────────────────────────────────────────
export async function getOffline<T>(key: string): Promise<OfflineResult<T> | null> {
  try {
    const db = await openDb();
    const record = await new Promise<StoredRecord<T> | undefined>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result as StoredRecord<T> | undefined);
      req.onerror = () => reject(req.error);
    });

    if (!record) return null;

    const staleness = Date.now() - record.savedAt;
    return {
      data: record.data,
      staleness,
      isStale: staleness > record.ttlMs,
    };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[offlineCache] échec getOffline", key, err);
    return null;
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// removeOffline / clearOffline — utilitaires de nettoyage (ex: logout).
// ──────────────────────────────────────────────────────────────────────────────
export async function removeOffline(key: string): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[offlineCache] échec removeOffline", key, err);
  }
}

export async function clearOffline(): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[offlineCache] échec clearOffline", err);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Exemple d'intégration avec TanStack Query (documenté ici, non branché
// automatiquement pour ne pas modifier queryClient.ts qui appartient au socle
// commun — libre à un agent d'intégrer ce wrapper dans une query existante) :
//
//   import { useQuery } from "@tanstack/react-query";
//   import { saveOffline, getOffline } from "@/lib/offlineCache";
//
//   function useZonesSummaryOffline() {
//     return useQuery({
//       queryKey: ["/api/zones/summary"],
//       queryFn: async () => {
//         try {
//           const res = await fetch("/api/zones/summary");
//           if (!res.ok) throw new Error(String(res.status));
//           const data = await res.json();
//           await saveOffline("zones-summary", data, 10 * 60 * 1000);
//           return data;
//         } catch (err) {
//           // Hors-ligne ou erreur réseau : on retombe sur la dernière donnée connue.
//           const cached = await getOffline("zones-summary");
//           if (cached) return cached.data;
//           throw err;
//         }
//       },
//     });
//   }
// ──────────────────────────────────────────────────────────────────────────────
