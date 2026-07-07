/**
 * useSwipeAcceptRefuse — Geste d'accept/refus par drag horizontal (feat/safety)
 * ─────────────────────────────────────────────────────────────────────────────
 * Utilise les Pointer Events natifs (pas touch events) pour détecter un
 * swipe horizontal sur une carte de recommandation :
 *   • Swipe droite (dx > threshold)  → onAccept()
 *   • Swipe gauche (dx < -threshold) → onRefuse()
 *
 * Retourne les props à attacher à l'élément (onPointerDown/Move/Up/Cancel)
 * ainsi que `dragX` et `dragging` pour piloter une transformation CSS
 * (translation + rotation légère + fondu d'un badge ✓/✗) pendant le drag.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { useRef, useState, useCallback } from "react";

export interface SwipeAcceptRefuseOptions {
  onAccept: () => void;
  onRefuse: () => void;
  threshold?: number; // px, défaut 80
}

export function useSwipeAcceptRefuse({ onAccept, onRefuse, threshold = 80 }: SwipeAcceptRefuseOptions) {
  const [dragX, setDragX] = useState(0);
  const [dragging, setDragging] = useState(false);
  const startXRef = useRef(0);
  const startYRef = useRef(0);
  const activeRef = useRef(false);
  const pointerIdRef = useRef<number | null>(null);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    // Ignorer les interactions multi-touch / clics droits
    if (e.button !== undefined && e.button !== 0) return;
    activeRef.current = true;
    pointerIdRef.current = e.pointerId;
    startXRef.current = e.clientX;
    startYRef.current = e.clientY;
    setDragging(true);
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!activeRef.current || pointerIdRef.current !== e.pointerId) return;
    const dx = e.clientX - startXRef.current;
    const dy = e.clientY - startYRef.current;
    // Si le mouvement est surtout vertical, on annule (laisse le scroll/swipe vertical natif agir)
    if (Math.abs(dy) > Math.abs(dx) * 1.5 && Math.abs(dy) > 20) {
      activeRef.current = false;
      setDragging(false);
      setDragX(0);
      return;
    }
    setDragX(dx);
  }, []);

  const endDrag = useCallback(
    (e: React.PointerEvent) => {
      if (!activeRef.current || pointerIdRef.current !== e.pointerId) return;
      activeRef.current = false;
      pointerIdRef.current = null;
      setDragging(false);
      const dx = e.clientX - startXRef.current;
      if (dx > threshold) {
        onAccept();
      } else if (dx < -threshold) {
        onRefuse();
      }
      setDragX(0);
    },
    [onAccept, onRefuse, threshold],
  );

  return {
    dragX,
    dragging,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: endDrag,
      onPointerCancel: endDrag,
    },
  };
}

export default useSwipeAcceptRefuse;
