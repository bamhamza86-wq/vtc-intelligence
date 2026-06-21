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

import { useState, useEffect } from "react";

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

  // Pas encore de position réelle → fallback Bd Ney
  if (isFallback || !lastUpdatedAt) {
    return (
      <div className={`flex items-center gap-1.5 text-[10px] font-medium ${className}`}>
        <span className="w-1.5 h-1.5 rounded-full bg-slate-400" />
        <span className="text-slate-400">Position par défaut (Bd Ney)</span>
      </div>
    );
  }

  const ageMs  = Date.now() - lastUpdatedAt.getTime();
  const ageSec = Math.max(0, Math.round(ageMs / 1000));

  let color  = "bg-emerald-400";
  let text   = "text-emerald-400";
  let label  = `Position fraîche · ${ageSec}s`;

  if (ageSec >= 30) {
    color = "bg-red-500";
    text  = "text-red-400";
    label = `Position ancienne · ${ageSec}s`;
  } else if (ageSec >= 10) {
    color = "bg-amber-400";
    text  = "text-amber-400";
    label = `Position · ${ageSec}s`;
  }

  return (
    <div className={`flex items-center gap-1.5 text-[10px] font-medium ${className}`} title={`Dernière position GPS il y a ${ageSec}s`}>
      <span className={`w-1.5 h-1.5 rounded-full ${color} ${ageSec < 10 ? "animate-pulse" : ""}`} />
      <span className={text}>{label}</span>
    </div>
  );
}
