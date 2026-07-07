/**
 * GpsFreshness — Indicateur de fraîcheur de la position GPS
 * ─────────────────────────────────────────────────────────────────────────────
 * Affiche un petit badge coloré indiquant l'âge de la dernière position GPS :
 *   - < 10s  : vert   (position fraîche)
 *   - 10-30s : orange (position un peu ancienne)
 *   - > 30s  : rouge  + mention "Position ancienne"
 *
 * Se rafraîchit automatiquement toutes les secondes pour rester exact même
 * sans nouvelle position GPS.
 *
 * Props :
 *   lastUpdatedAt : Date | null — fourni par useGpsPosition()
 *   isFallback    : boolean     — true si on utilise le fallback Bd Ney
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { useState, useEffect, useRef } from "react";
import { haptic } from "@/lib/haptics";

interface GpsFreshnessProps {
  lastUpdatedAt: Date | null;
  isFallback?:   boolean;
  className?:    string;
}

export function GpsFreshness({ lastUpdatedAt, isFallback = false, className = "" }: GpsFreshnessProps) {
  // Tick toutes les secondes pour recalculer l'âge sans dépendre d'un nouveau fix GPS
  const [, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // ─── Levier 7 (Vague 3) — ping haptique unique au franchissement du seuil ───
  // On mémorise le "bracket" précédent (<30s vs >=30s) ; le haptic "warning"
  // ne se déclenche que sur la transition montante, jamais à chaque rendu.
  const wasStaleRef = useRef(false);

  const ageMs  = lastUpdatedAt ? Date.now() - lastUpdatedAt.getTime() : 0;
  const ageSec = Math.max(0, Math.round(ageMs / 1000));
  const isStaleBracket = !isFallback && !!lastUpdatedAt && ageSec >= 30;

  useEffect(() => {
    if (isStaleBracket && !wasStaleRef.current) {
      haptic("warning");
    }
    wasStaleRef.current = isStaleBracket;
  }, [isStaleBracket]);

  // Pas encore de position réelle → fallback Bd Ney
  if (isFallback || !lastUpdatedAt) {
    return (
      <div className={`flex items-center gap-1.5 text-[10px] font-medium ${className}`}>
        <span className="w-1.5 h-1.5 rounded-full bg-slate-400" />
        <span className="text-slate-400">Position par défaut (Bd Ney)</span>
      </div>
    );
  }

  let color  = "bg-emerald-400";
  let text   = "text-emerald-400";
  let prefix = "Position fraîche";

  if (ageSec >= 30) {
    color = "bg-red-500";
    text  = "text-red-400";
    prefix = "Position ancienne";
  } else if (ageSec >= 10) {
    color = "bg-amber-400";
    text  = "text-amber-400";
    prefix = "Position";
  }

  // ─── Levier 6 (Vague 3) — indice de forme redondant à la couleur ──────────
  // fresh = cercle plein, aging = triangle, stale = carré.
  const statusShape: "fresh" | "aging" | "stale" =
    ageSec >= 30 ? "stale" : ageSec >= 10 ? "aging" : "fresh";
  const shapeFill = ageSec >= 30 ? "#ef4444" : ageSec >= 10 ? "#fbbf24" : "#34d399";

  return (
    <div className={`flex items-center gap-1.5 text-[10px] font-medium ${className}`} title={`Dernière position GPS il y a ${ageSec}s`}>
      <span className={`w-1.5 h-1.5 rounded-full ${color} ${ageSec < 10 ? "animate-pulse" : ""}`} />
      <svg width="7" height="7" viewBox="0 0 8 8" aria-hidden="true" className="shrink-0">
        {statusShape === "fresh" && <circle cx="4" cy="4" r="4" fill={shapeFill} />}
        {statusShape === "aging" && <polygon points="4,0 8,8 0,8" fill={shapeFill} />}
        {statusShape === "stale" && <rect x="0" y="0" width="8" height="8" fill={shapeFill} />}
      </svg>
      <span className={text}>{prefix} · <span className="tabular-nums">{ageSec}</span>s</span>
    </div>
  );
}
