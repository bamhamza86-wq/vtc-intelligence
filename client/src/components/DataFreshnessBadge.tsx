/**
 * DataFreshnessBadge — Pastille de fraîcheur des données (Levier 5)
 * ─────────────────────────────────────────────────────────────────────────────
 * Affiche « Mis à jour il y a Xs » avec une pastille colorée selon l'âge du
 * timestamp `_ts` fourni par une réponse API. Auto-rafraîchi toutes les secondes.
 *
 * Couleurs :
 *   < 10s   → vert    (données fraîches)
 *   10–60s  → orange  (à surveiller)
 *   > 60s   → rouge   (données périmées)
 *
 * Positionnement via prop `position` :
 *   "bottom-left" → fixe en bas à gauche de l'écran
 *   "inline"      → flux normal (défaut)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { useEffect, useState } from "react";

interface DataFreshnessBadgeProps {
  ts: number | undefined;
  position?: "bottom-left" | "inline";
}

export function DataFreshnessBadge({ ts, position = "inline" }: DataFreshnessBadgeProps) {
  // ─── Tick 1s pour recalculer l'âge affiché ────────────────────────────────
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  if (!ts) return null;

  // ─── Âge en secondes → couleur de pastille ────────────────────────────────
  const ageSec = Math.max(0, Math.round((now - ts) / 1000));
  let dot = "bg-green-500";
  if (ageSec > 60) dot = "bg-red-500";
  else if (ageSec >= 10) dot = "bg-orange-500";

  // ─── Levier 6 (Vague 3) — indice de forme redondant à la couleur ──────────
  // fresh = cercle plein, aging = triangle, stale = carré. Garantit la
  // lisibilité pour les daltoniens (deutéranopie/protanopie) et sous fort
  // ensoleillement, sans reposer uniquement sur la teinte.
  const statusShape: "fresh" | "aging" | "stale" =
    ageSec > 60 ? "stale" : ageSec >= 10 ? "aging" : "fresh";
  const shapeFill = ageSec > 60 ? "#ef4444" : ageSec >= 10 ? "#f97316" : "#22c55e";

  const positionClass =
    position === "bottom-left"
      ? "fixed bottom-3 left-3 z-[1200]"
      : "inline-flex";

  return (
    <div
      data-testid="data-freshness-badge"
      className={`${positionClass} items-center gap-1.5 rounded-full bg-white/90 px-2.5 py-1 text-xs font-medium text-gray-700 shadow-md backdrop-blur`}
    >
      <span className={`h-2 w-2 rounded-full ${dot}`} />
      <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true" className="shrink-0">
        {statusShape === "fresh" && <circle cx="4" cy="4" r="4" fill={shapeFill} />}
        {statusShape === "aging" && <polygon points="4,0 8,8 0,8" fill={shapeFill} />}
        {statusShape === "stale" && <rect x="0" y="0" width="8" height="8" fill={shapeFill} />}
      </svg>
      <span>Mis à jour il y a <span className="tabular-nums">{ageSec}</span>s</span>
    </div>
  );
}
