/**
 * BottomSheet — Feuille modale glissable avec snap points (couche polish)
 * ─────────────────────────────────────────────────────────────────────────────
 * Composant générique réutilisable : drag-to-dismiss + snap points via
 * Pointer Events natifs (aucune dépendance npm). Utilisé par ShiftStatusDock,
 * CommandPalette (mobile) et disponible pour toute future feuille.
 *
 * Snap points exprimés en fraction de la hauteur de viewport (0..1), ex.
 * [0.3, 0.7, 1] = 30% / 70% / 100%. Le drag suit le doigt en temps réel,
 * puis "snap" vers le point le plus proche au relâchement (ou ferme si le
 * geste dépasse le seuil de fermeture sous le plus petit snap point).
 *
 * Props :
 *   open        — affichage de la feuille
 *   onClose     — callback fermeture (backdrop, swipe down, Échap)
 *   title       — titre affiché dans le header (optionnel)
 *   snapPoints  — fractions de hauteur, ex [0.3, 0.7, 1] (défaut [0.5, 0.9])
 *   initialSnap — index du snap point de départ (défaut dernier = plus grand)
 *   children    — contenu scrollable
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { useEffect, useRef, useState, ReactNode } from "react";
import { X } from "lucide-react";

interface BottomSheetProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  snapPoints?: number[]; // fractions 0..1 de la hauteur viewport
  initialSnap?: number;  // index dans snapPoints
  children: ReactNode;
}

const CLOSE_THRESHOLD_PX = 90; // glisser au-delà du snap le plus bas + ce seuil → fermeture

export function BottomSheet({
  open,
  onClose,
  title,
  snapPoints = [0.5, 0.9],
  initialSnap,
  children,
}: BottomSheetProps) {
  const sortedSnaps = [...snapPoints].sort((a, b) => a - b);
  const [snapIndex, setSnapIndex] = useState(initialSnap ?? sortedSnaps.length - 1);
  const [dragOffsetPx, setDragOffsetPx] = useState(0);
  const [dragging, setDragging] = useState(false);

  const startYRef = useRef<number | null>(null);
  const startHeightPxRef = useRef(0);
  const sheetRef = useRef<HTMLDivElement>(null);

  // Réinitialise le snap au moment de l'ouverture
  useEffect(() => {
    if (open) {
      setSnapIndex(initialSnap ?? sortedSnaps.length - 1);
      setDragOffsetPx(0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Fermeture via Échap (desktop)
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const currentHeightVh = sortedSnaps[snapIndex] * 100;

  function handlePointerDown(e: React.PointerEvent) {
    startYRef.current = e.clientY;
    startHeightPxRef.current = sheetRef.current?.getBoundingClientRect().height ?? 0;
    setDragging(true);
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  }

  function handlePointerMove(e: React.PointerEvent) {
    if (startYRef.current === null) return;
    const dy = e.clientY - startYRef.current;
    // On ne permet que le glissement vers le bas au-delà du snap max, vers le
    // haut on laisse une résistance légère (÷3) pour un effet "élastique".
    setDragOffsetPx(dy > 0 ? dy : dy / 3);
  }

  function handlePointerUp() {
    if (startYRef.current === null) return;
    const vh = window.innerHeight;
    const currentPx = (currentHeightVh / 100) * vh - dragOffsetPx;
    const currentFrac = Math.max(0, currentPx / vh);

    // Fermeture si on tire nettement sous le snap le plus bas
    const lowestSnapPx = sortedSnaps[0] * vh;
    if (dragOffsetPx > CLOSE_THRESHOLD_PX && currentPx < lowestSnapPx - CLOSE_THRESHOLD_PX / 2) {
      startYRef.current = null;
      setDragging(false);
      setDragOffsetPx(0);
      onClose();
      return;
    }

    // Snap vers le point le plus proche
    let closestIdx = 0;
    let closestDist = Infinity;
    sortedSnaps.forEach((frac, i) => {
      const dist = Math.abs(frac - currentFrac);
      if (dist < closestDist) {
        closestDist = dist;
        closestIdx = i;
      }
    });

    setSnapIndex(closestIdx);
    setDragOffsetPx(0);
    setDragging(false);
    startYRef.current = null;
  }

  return (
    <div className="fixed inset-0 z-[70]" role="dialog" aria-modal="true" aria-label={title || "Feuille"} data-testid="bottom-sheet">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-[1px] bottom-sheet-backdrop"
        onClick={onClose}
        data-testid="bottom-sheet-backdrop"
      />

      {/* Feuille */}
      <div
        ref={sheetRef}
        className="absolute inset-x-0 bottom-0 bg-card border-t border-border rounded-t-2xl shadow-2xl flex flex-col bottom-sheet-panel"
        style={{
          height: `${currentHeightVh}vh`,
          maxHeight: "95vh",
          transform: `translateY(${dragOffsetPx}px)`,
          transition: dragging ? "none" : "height 220ms cubic-bezier(.2,.9,.3,1), transform 220ms cubic-bezier(.2,.9,.3,1)",
        }}
      >
        {/* Poignée de drag */}
        <div
          className="w-full flex flex-col items-center pt-2.5 pb-1.5 cursor-grab active:cursor-grabbing shrink-0 touch-none"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          data-testid="bottom-sheet-handle"
        >
          <div className="w-10 h-1.5 rounded-full bg-muted-foreground/30" />
        </div>

        {title && (
          <div className="flex items-center justify-between px-4 pb-2 shrink-0">
            <h2 className="font-bold text-sm">{title}</h2>
            <button
              onClick={onClose}
              className="flex items-center justify-center rounded-full hover:bg-accent transition-colors"
              style={{ minWidth: 36, minHeight: 36 }}
              aria-label="Fermer"
              data-testid="bottom-sheet-close"
            >
              <X size={16} />
            </button>
          </div>
        )}

        <div className="flex-1 overflow-y-auto overscroll-contain">{children}</div>
      </div>

      <style>{`
        @media (prefers-reduced-motion: reduce) {
          .bottom-sheet-panel { transition: none !important; }
        }
      `}</style>
    </div>
  );
}

export default BottomSheet;
