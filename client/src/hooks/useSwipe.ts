/**
 * useSwipe — Détection de swipe gestures tactiles
 * ─────────────────────────────────────────────────────────────────────────────
 * Attache des listeners touchstart / touchmove / touchend sur un élément
 * DOM référencé et déclenche les callbacks correspondants au geste détecté.
 *
 * Directions supportées : up / down / left / right
 *
 * Signature :
 *   useSwipe(ref, { onSwipeUp, onSwipeDown, onSwipeLeft, onSwipeRight, threshold=50 })
 *
 * Paramètres :
 *   ref       — React.RefObject pointant vers l'élément HTML cible
 *   threshold — Distance minimale en px pour valider le swipe (défaut : 50)
 *
 * Notes :
 *   - Utilise passive listeners pour ne pas bloquer le scroll natif
 *   - Compatible iOS Safari et Android Chrome
 *   - Aucune dépendance externe
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { RefObject, useEffect, useRef } from "react";

// ── Types ─────────────────────────────────────────────────────────────────────
export interface SwipeHandlers {
  onSwipeUp?:    () => void;
  onSwipeDown?:  () => void;
  onSwipeLeft?:  () => void;
  onSwipeRight?: () => void;
  /** Distance minimale en pixels pour valider le geste (défaut : 50) */
  threshold?: number;
}

// ── Hook ─────────────────────────────────────────────────────────────────────
export function useSwipe<T extends HTMLElement>(
  ref: RefObject<T>,
  handlers: SwipeHandlers
): void {
  // Stocker les handlers dans une ref pour éviter les re-subscriptions
  const handlersRef = useRef<SwipeHandlers>(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    // Coordonnées du point de départ du touch
    let startX = 0;
    let startY = 0;

    const onTouchStart = (e: TouchEvent) => {
      const touch = e.touches[0];
      startX = touch.clientX;
      startY = touch.clientY;
    };

    const onTouchEnd = (e: TouchEvent) => {
      const touch = e.changedTouches[0];
      const dx = touch.clientX - startX;
      const dy = touch.clientY - startY;
      const threshold = handlersRef.current.threshold ?? 50;

      const absDx = Math.abs(dx);
      const absDy = Math.abs(dy);

      // Distance insuffisante → pas un swipe
      if (absDx < threshold && absDy < threshold) return;

      const { onSwipeUp, onSwipeDown, onSwipeLeft, onSwipeRight } = handlersRef.current;

      if (absDx > absDy) {
        // Swipe horizontal
        if (dx > 0) {
          onSwipeRight?.();
        } else {
          onSwipeLeft?.();
        }
      } else {
        // Swipe vertical
        if (dy > 0) {
          onSwipeDown?.();
        } else {
          onSwipeUp?.();
        }
      }
    };

    // Utiliser passive:true pour ne pas bloquer le scroll natif
    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchend",   onTouchEnd,   { passive: true });

    return () => {
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchend",   onTouchEnd);
    };
  }, [ref]);
}
