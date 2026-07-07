/**
 * queueOffline — File d'attente hors-ligne pour requêtes POST (Vague 2 - Feature 5)
 * ─────────────────────────────────────────────────────────────────────────────
 * Quand le réseau est indisponible (ou qu'une requête échoue), on met la requête
 * en file dans localStorage (`vtc.offlineQueue`) au lieu de la perdre. Dès que le
 * navigateur redevient en ligne (événement `online`), la file est rejouée dans
 * l'ordre d'origine.
 *
 * Usage opt-in : `apiPost(url, body)` retourne une Promise<Response | null>.
 * En cas de succès réseau immédiat → Response normale.
 * En cas d'échec ou de mode hors-ligne → mise en file + résolution avec `null`
 * (l'appelant peut informer l'utilisateur que l'action sera rejouée plus tard).
 *
 * Ceci N'EST PAS un remplacement automatique des appels fetch existants —
 * c'est un utilitaire disponible pour les nouveaux appels qui le souhaitent.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const QUEUE_KEY = "vtc.offlineQueue";
const MAX_QUEUE_ITEMS = 200;

export interface QueuedRequest {
  url: string;
  method: string;
  body?: unknown;
  ts: number;
}

// ──────────────────────────────────────────────────────────────────────────────
// Persistance de la file
// ──────────────────────────────────────────────────────────────────────────────
export function readQueue(): QueuedRequest[] {
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeQueue(queue: QueuedRequest[]): void {
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(queue.slice(-MAX_QUEUE_ITEMS)));
  } catch {
    // localStorage indisponible ou plein — on ignore silencieusement
  }
}

export function enqueueRequest(req: QueuedRequest): void {
  const queue = readQueue();
  queue.push(req);
  writeQueue(queue);
}

export function queueLength(): number {
  return readQueue().length;
}

// ──────────────────────────────────────────────────────────────────────────────
// Rejeu de la file quand le réseau revient
// ──────────────────────────────────────────────────────────────────────────────
let _replaying = false;

export async function replayQueue(): Promise<void> {
  if (_replaying) return; // évite les rejeux concurrents
  if (typeof navigator !== "undefined" && !navigator.onLine) return;

  _replaying = true;
  try {
    let queue = readQueue();
    while (queue.length > 0) {
      const req = queue[0];
      try {
        const res = await fetch(req.url, {
          method: req.method,
          headers: req.body !== undefined ? { "Content-Type": "application/json" } : undefined,
          body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
        });
        if (!res.ok && res.status >= 500) {
          // Erreur serveur temporaire : on arrête le rejeu, on réessaiera plus tard
          break;
        }
      } catch {
        // Toujours hors-ligne ou erreur réseau : on arrête le rejeu ici
        break;
      }
      // Requête traitée (succès ou erreur définitive côté client) → on la retire
      queue = queue.slice(1);
      writeQueue(queue);
    }
  } finally {
    _replaying = false;
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("online", () => {
    replayQueue();
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// apiPost — helper opt-in : POST direct si en ligne, sinon mise en file
// ──────────────────────────────────────────────────────────────────────────────
export async function apiPost(url: string, body?: unknown): Promise<Response | null> {
  if (typeof navigator !== "undefined" && !navigator.onLine) {
    enqueueRequest({ url, method: "POST", body, ts: Date.now() });
    return null;
  }

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return res;
  } catch {
    enqueueRequest({ url, method: "POST", body, ts: Date.now() });
    return null;
  }
}
