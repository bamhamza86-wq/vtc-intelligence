/**
 * PullToRefresh — Wrapper pull-to-refresh tactile
 * ─────────────────────────────────────────────────────────────────────────────
 * Détecte un pull (glissement vers le bas) de plus de 80px depuis le haut
 * de la page et déclenche le callback `onRefresh()`.
 *
 * Affiche une icône RefreshCw (lucide-react) animée pendant le refresh.
 *
 * Usage :
 *   <PullToRefresh onRefresh={handleRefresh}>
 *     <PageContent />
 *   </PullToRefresh>
 *
 * Le composant est conçu pour wrapper le contenu principal des pages.
 * Il ne s'active que lorsque la page est scrollée tout en haut (scrollY ≈ 0).
 *
 * data-testid="pull-to-refresh" — sur le conteneur racine.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { useState, useRef, useCallback, ReactNode } from "react";
import { RefreshCw } from "lucide-react";

// ── Constantes ────────────────────────────────────────────────────────────────
/** Distance en px à tirer pour déclencher le refresh */
const PULL_THRESHOLD_PX = 80;
/** Hauteur maximale de l'indicateur visible (px) */
const MAX_PULL_PX = 120;

// ── Types ─────────────────────────────────────────────────────────────────────
interface PullToRefreshProps {
  /** Callback appelé quand le pull dépasse le seuil — doit retourner une Promise */
  onRefresh: () => Promise<void> | void;
  children: ReactNode;
  className?: string;
}

// ── Composant ─────────────────────────────────────────────────────────────────
export function PullToRefresh({ onRefresh, children, className = "" }: PullToRefreshProps) {
  const [pullDistance, setPullDistance]   = useState(0);
  const [isRefreshing, setIsRefreshing]   = useState(false);
  const [triggered,    setTriggered]      = useState(false);

  const startYRef     = useRef<number | null>(null);
  const containerRef  = useRef<HTMLDivElement>(null);

  // ── Gestion touch ──────────────────────────────────────────────────────────
  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    // N'activer que si on est en haut de la page
    if (window.scrollY > 5) return;
    startYRef.current = e.touches[0].clientY;
  }, []);

  const handleTouchMove = useCallback(
    (e: React.TouchEvent) => {
      if (startYRef.current === null || isRefreshing) return;
      const dy = e.touches[0].clientY - startYRef.current;
      if (dy < 0) {
        // Pull vers le haut → ignorer
        setPullDistance(0);
        return;
      }
      // Limiter la distance affichée
      const clamped = Math.min(dy, MAX_PULL_PX);
      setPullDistance(clamped);
      setTriggered(clamped >= PULL_THRESHOLD_PX);
    },
    [isRefreshing]
  );

  const handleTouchEnd = useCallback(async () => {
    if (startYRef.current === null) return;
    startYRef.current = null;

    if (pullDistance >= PULL_THRESHOLD_PX && !isRefreshing) {
      setIsRefreshing(true);
      setPullDistance(PULL_THRESHOLD_PX); // Maintenir l'indicateur pendant le refresh
      try {
        await onRefresh();
      } finally {
        setIsRefreshing(false);
        setPullDistance(0);
        setTriggered(false);
      }
    } else {
      setPullDistance(0);
      setTriggered(false);
    }
  }, [pullDistance, isRefreshing, onRefresh]);

  // ── Progression de l'indicateur (0..1) ───────────────────────────────────
  const progress = Math.min(pullDistance / PULL_THRESHOLD_PX, 1);
  const showIndicator = pullDistance > 0 || isRefreshing;

  return (
    <div
      ref={containerRef}
      data-testid="pull-to-refresh"
      className={`relative ${className}`}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
      {/* ── Indicateur de pull ─────────────────────────────────────────────── */}
      {showIndicator && (
        <div
          className="absolute top-0 left-0 right-0 z-50 flex items-center justify-center overflow-hidden transition-all duration-150"
          style={{ height: `${pullDistance}px` }}
          aria-hidden="true"
        >
          <div
            className={`flex flex-col items-center gap-1 ${
              triggered || isRefreshing ? "text-primary" : "text-muted-foreground"
            }`}
          >
            <RefreshCw
              size={24}
              className={isRefreshing ? "animate-spin" : ""}
              style={
                !isRefreshing
                  ? { transform: `rotate(${progress * 360}deg)`, transition: "transform 0.05s linear" }
                  : undefined
              }
            />
            <span className="text-[10px] uppercase tracking-wider">
              {isRefreshing ? "Actualisation…" : triggered ? "Relâcher" : "Tirer pour actualiser"}
            </span>
          </div>
        </div>
      )}

      {/* ── Contenu de la page ────────────────────────────────────────────── */}
      <div
        style={
          showIndicator
            ? { transform: `translateY(${pullDistance}px)`, transition: isRefreshing ? "transform 0.2s ease" : undefined }
            : undefined
        }
      >
        {children}
      </div>
    </div>
  );
}
