/**
 * perfMode — Mode de performance dégradé (Vague 2 - Feature 4)
 * ─────────────────────────────────────────────────────────────────────────────
 * Petit registre global (hors React) exposant le mode de performance courant
 * ("normal" | "low") ainsi qu'un mécanisme d'abonnement simple par événements.
 *
 * Le mode "low" est activé quand la batterie est faible (<20%) ou que la
 * connexion réseau signale `saveData` (Data Saver). Voir `useBatteryStatus.ts`
 * pour la détection et la mise à jour de ce registre.
 *
 * Consommateurs :
 *   - `getPerfMode()` pour une lecture ponctuelle (ex: throttle de polling).
 *   - `subscribePerfMode(cb)` pour réagir aux changements.
 *   - classe CSS `.perf-low` posée sur <html> par `useBatteryStatus` pour
 *     désactiver les animations lourdes (voir index.css).
 * ─────────────────────────────────────────────────────────────────────────────
 */

export type PerfMode = "normal" | "low";

const PERF_LOW_CLASS = "perf-low";

let currentMode: PerfMode = "normal";
const listeners = new Set<(mode: PerfMode) => void>();

/** Lecture ponctuelle du mode de performance courant. */
export function getPerfMode(): PerfMode {
  return currentMode;
}

/** Abonnement aux changements de mode. Retourne une fonction de désabonnement. */
export function subscribePerfMode(cb: (mode: PerfMode) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Met à jour le mode global + applique/retire la classe CSS sur <html>. */
export function setPerfMode(mode: PerfMode): void {
  if (mode === currentMode) return;
  currentMode = mode;
  try {
    document.documentElement.classList.toggle(PERF_LOW_CLASS, mode === "low");
  } catch {
    // ignore (SSR / environnement sans document)
  }
  listeners.forEach((cb) => {
    try {
      cb(mode);
    } catch {
      // un abonné défaillant ne doit pas bloquer les autres
    }
  });
}

/**
 * Aide pour les hooks de polling : renvoie l'intervalle adapté au mode
 * courant (ex: 30s en normal → 120s en low), avec valeurs par défaut
 * raisonnables si non précisées.
 */
export function getPollingIntervalMs(normalMs = 30_000, lowMs = 120_000): number {
  return currentMode === "low" ? lowMs : normalMs;
}
