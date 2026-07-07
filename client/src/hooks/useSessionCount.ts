/**
 * useSessionCount — Compteur de sessions applicatives (localStorage, 100% client)
 * ─────────────────────────────────────────────────────────────────────────────
 * Incrémente un compteur persistant à chaque montage de l'application (une
 * "session" = un chargement de l'app / une visite). Sert de garde-fou pour
 * n'afficher certains prompts (ex : NotifPermissionPrompt) qu'après un nombre
 * minimum de sessions, jamais dès la première ouverture — évite l'effet
 * "popup intrusif au premier chargement" (rapport.md §10.9).
 *
 * Incrémentation dédupliquée par onglet (sessionStorage) : plusieurs re-renders
 * du même onglet dans la même session ne comptent qu'une fois.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { useEffect, useState } from "react";

const SESSION_COUNT_KEY = "vtc.session_count";
const SESSION_TAB_FLAG_KEY = "vtc.session_counted_this_tab";

function readCount(): number {
  if (typeof window === "undefined") return 0;
  const raw = window.localStorage.getItem(SESSION_COUNT_KEY);
  const n = raw ? parseInt(raw, 10) : 0;
  return Number.isFinite(n) ? n : 0;
}

/** Incrémente le compteur une seule fois par onglet/session (sessionStorage-based). */
function bumpSessionCountOnce(): number {
  if (typeof window === "undefined") return 0;
  try {
    const alreadyCounted = window.sessionStorage.getItem(SESSION_TAB_FLAG_KEY);
    if (alreadyCounted) return readCount();

    const next = readCount() + 1;
    window.localStorage.setItem(SESSION_COUNT_KEY, String(next));
    window.sessionStorage.setItem(SESSION_TAB_FLAG_KEY, "1");
    return next;
  } catch {
    return readCount();
  }
}

/**
 * Hook exposant le nombre de sessions applicatives observées et un booléen
 * `hasReachedThreshold(min)` pratique pour les composants consommateurs.
 */
export function useSessionCount(): { sessionCount: number; isFirstSession: boolean } {
  const [sessionCount, setSessionCount] = useState<number>(() => readCount());

  useEffect(() => {
    setSessionCount(bumpSessionCountOnce());
  }, []);

  return { sessionCount, isFirstSession: sessionCount <= 1 };
}

export default useSessionCount;
