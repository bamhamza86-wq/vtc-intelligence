/**
 * aiToggle — Couche ML Personnel : mode « pas d'IA aujourd'hui »
 * ─────────────────────────────────────────────────────────────────────────────
 * Flag persisté en localStorage : `ai_disabled_today` (date ISO du jour où le
 * mode a été activé, ex. "2026-07-07"). Le mode se désactive automatiquement
 * au changement de journée (minuit) : si la date stockée ne correspond plus
 * à aujourd'hui, il est considéré comme inactif.
 *
 * Quand actif : les pages Focus / Reco masquent les suggestions basées sur le
 * ML personnel (patterns, prochaine meilleure zone, simulateur) et affichent
 * une bannière sobre à la place. Le résultat net de la journée peut ensuite
 * être comparé a posteriori via POST /api/ml/ai-disabled-log.
 *
 * API :
 *   isAiDisabledToday()   → bool
 *   enableAiDisabledToday() → active pour la journée en cours
 *   disableAiDisabledToday() → réactive l'IA immédiatement
 */

const LS_KEY = "ai_disabled_today";

function todayStr(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function isAiDisabledToday(): boolean {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return false;
    return raw === todayStr();
  } catch {
    return false;
  }
}

export function enableAiDisabledToday(): void {
  try {
    localStorage.setItem(LS_KEY, todayStr());
    window.dispatchEvent(new StorageEvent("storage", { key: LS_KEY }));
  } catch {
    // localStorage indisponible — ignoré silencieusement
  }
}

export function disableAiDisabledToday(): void {
  try {
    localStorage.removeItem(LS_KEY);
    window.dispatchEvent(new StorageEvent("storage", { key: LS_KEY }));
  } catch {
    // ignoré
  }
}

export function getAiDisabledDate(): string | null {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    if (raw !== todayStr()) return null;
    return raw;
  } catch {
    return null;
  }
}
