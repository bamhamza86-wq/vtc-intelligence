/**
 * useWakeLock — Wake Lock API pour maintenir l'écran allumé
 * ─────────────────────────────────────────────────────────────────────────────
 * Appelle `navigator.wakeLock.request("screen")` pour empêcher l'écran
 * de s'éteindre pendant la conduite (mode /drive actif).
 *
 * Comportement :
 *   - Acquiert le wake lock au montage du composant
 *   - Le relâche automatiquement au démontage (cleanup useEffect)
 *   - Réacquiert le lock si la page redevient visible (visibilitychange)
 *     car le système relâche automatiquement le lock quand l'onglet passe
 *     en arrière-plan
 *   - Fallback silencieux si Wake Lock API non supportée
 *
 * Retourne :
 *   { isActive: boolean, error: string | null }
 *
 * Intégration : utiliser dans DrivePage.tsx au début du composant.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { useState, useEffect, useRef } from "react";

// ── Types ─────────────────────────────────────────────────────────────────────
export interface UseWakeLockResult {
  /** true si le wake lock est actuellement actif */
  isActive: boolean;
  /** Message d'erreur si le lock a échoué, null sinon */
  error: string | null;
}

// ── Hook ─────────────────────────────────────────────────────────────────────
export function useWakeLock(): UseWakeLockResult {
  const [isActive, setIsActive] = useState(false);
  const [error,    setError]    = useState<string | null>(null);

  // Référence vers le sentinel actif pour pouvoir le relâcher
  const sentinelRef = useRef<WakeLockSentinel | null>(null);

  // ── Fonction d'acquisition du wake lock ──────────────────────────────────
  const acquireLock = async () => {
    // Vérifier la disponibilité de l'API
    if (typeof navigator === "undefined") return;
    if (!("wakeLock" in navigator)) {
      setError("Wake Lock API non supportée sur ce navigateur");
      return;
    }
    // Ne pas réacquérir si déjà actif
    if (sentinelRef.current !== null) return;

    try {
      const sentinel = await navigator.wakeLock.request("screen");
      sentinelRef.current = sentinel;
      setIsActive(true);
      setError(null);

      // Le système peut relâcher le lock automatiquement (ex : batterie faible)
      sentinel.addEventListener("release", () => {
        sentinelRef.current = null;
        setIsActive(false);
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Erreur inconnue Wake Lock";
      setError(msg);
      setIsActive(false);
    }
  };

  // ── Cycle de vie : acquisition + re-acquisition sur visibilitychange ──────
  useEffect(() => {
    acquireLock();

    // Réacquérir si la page redevient visible (le lock est perdu en background)
    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        acquireLock();
      }
    };

    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibility);

      // Relâcher le wake lock au démontage du composant
      if (sentinelRef.current) {
        sentinelRef.current.release().catch(() => {
          // Ignorer les erreurs de release (composant déjà détruit)
        });
        sentinelRef.current = null;
        setIsActive(false);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { isActive, error };
}
