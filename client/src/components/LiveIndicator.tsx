/**
 * LiveIndicator — Indicateur de fraîcheur GPS temps réel
 * ─────────────────────────────────────────────────────────────────────────────
 * Affiche un point coloré pulsant + label LIVE / STALE selon l'âge
 * de la dernière mise à jour GPS.
 *
 * Seuils de fraîcheur :
 *   < 10s  → vert   — LIVE  (animate-pulse)
 *   10-60s → orange — LIVE  (légère dégradation)
 *   > 60s  → rouge  — STALE
 *
 * Utilise useGpsPosition().lastUpdatedAt pour calculer l'âge.
 * Compatible avec le Lot 1 : si `freshnessSec` est présent on l'utilise,
 * sinon on calcule depuis `lastUpdatedAt`.
 *
 * Intégration : placer dans le header à côté du logo. Le Layout actuel
 * n'expose pas de slot dédiée — laisser l'intégration au Lot 2 / agent principal.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { useGpsPosition } from "@/hooks/useGpsPosition";

// ── Types ─────────────────────────────────────────────────────────────────────
type LiveStatus = "live-green" | "live-orange" | "stale";

// ── Calcul du statut depuis l'âge en secondes ─────────────────────────────────
function getStatusFromAge(ageSec: number | null): LiveStatus {
  if (ageSec === null) return "stale";
  if (ageSec < 10) return "live-green";
  if (ageSec <= 60) return "live-orange";
  return "stale";
}

// ── Couleurs Tailwind selon statut ────────────────────────────────────────────
const STATUS_STYLES: Record<LiveStatus, { dot: string; text: string; label: string }> = {
  "live-green":  { dot: "bg-emerald-400 animate-pulse", text: "text-emerald-400", label: "LIVE"  },
  "live-orange": { dot: "bg-amber-400 animate-pulse",   text: "text-amber-400",   label: "LIVE"  },
  "stale":       { dot: "bg-red-500",                   text: "text-red-400",     label: "STALE" },
};

// ── Composant ─────────────────────────────────────────────────────────────────
export function LiveIndicator() {
  // Récupère la position GPS — compatible Lot 1
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const gps = useGpsPosition() as any;

  // Calcul de l'âge en secondes
  let ageSec: number | null = null;

  if (typeof gps.freshnessSec === "number") {
    // Lot 1 expose directement freshnessSec
    ageSec = gps.freshnessSec;
  } else if (gps.lastUpdatedAt instanceof Date) {
    ageSec = (Date.now() - gps.lastUpdatedAt.getTime()) / 1000;
  }

  const status = getStatusFromAge(ageSec);
  const styles = STATUS_STYLES[status];

  return (
    <div
      className="flex items-center gap-1.5"
      data-testid="live-indicator"
      aria-live="polite"
      aria-label={`Statut GPS : ${styles.label}`}
    >
      {/* Point coloré pulsant */}
      <span
        className={`w-2 h-2 rounded-full shrink-0 ${styles.dot}`}
        aria-hidden="true"
      />
      {/* Label LIVE / STALE */}
      <span className={`text-[10px] font-bold tracking-widest uppercase ${styles.text}`}>
        {styles.label}
      </span>
    </div>
  );
}
