/**
 * AirportWaitCard — Carte Mode Attente aéroport (Vague 1 - Levier 6)
 * ─────────────────────────────────────────────────────────────────────────────
 * S'affiche automatiquement quand le chauffeur entre dans le parking VTC
 * d'un aéroport reconnu. Timer FIFO local + moyenne perso 7 derniers cycles.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { useAirportWait } from "@/hooks/useAirportWait";
import { Plane, Clock, TrendingUp } from "lucide-react";

function fmt(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return `${m} min`;
  return `${h}h${String(m).padStart(2, "0")}`;
}

export default function AirportWaitCard() {
  const { currentZone, elapsedMin, avgWaitMin } = useAirportWait();
  if (!currentZone) return null;

  // Estimation du reste : moyenne - écoulé (peut être négatif si dépassement)
  const remainingMin = avgWaitMin != null ? avgWaitMin - elapsedMin : null;
  const overdue = remainingMin != null && remainingMin < 0;

  return (
    <div
      className="rounded-2xl border-2 shadow-lg p-4"
      style={{
        background: "linear-gradient(135deg, rgba(56,189,248,0.18) 0%, rgba(14,165,233,0.15) 100%)",
        borderColor: "rgba(56,189,248,0.4)",
      }}
      role="status"
      data-testid="airport-wait-card"
    >
      <div className="flex items-center gap-2 mb-3">
        <div className="p-2 rounded-lg bg-sky-500/20 text-sky-200">
          <Plane size={20} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-xs uppercase tracking-widest text-sky-300/80 font-bold">
            Mode attente
          </div>
          <div className="text-white font-semibold text-sm">{currentZone.name}</div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-lg bg-black/25 p-3">
          <div className="flex items-center gap-1 text-[10px] uppercase tracking-widest text-white/60 font-bold">
            <Clock size={11} />
            <span>Écoulé</span>
          </div>
          <div className="text-2xl font-bold text-white tabular-nums mt-1">
            {fmt(elapsedMin)}
          </div>
        </div>
        <div className="rounded-lg bg-black/25 p-3">
          <div className="flex items-center gap-1 text-[10px] uppercase tracking-widest text-white/60 font-bold">
            <TrendingUp size={11} />
            <span>Moy. perso</span>
          </div>
          <div className="text-2xl font-bold text-white tabular-nums mt-1">
            {avgWaitMin != null ? fmt(avgWaitMin) : "—"}
          </div>
        </div>
      </div>

      {remainingMin != null && (
        <div
          className={`mt-3 text-center text-sm font-semibold ${
            overdue ? "text-amber-300" : "text-sky-200"
          }`}
        >
          {overdue
            ? `Vous dépassez de ${fmt(Math.abs(remainingMin))} votre moyenne`
            : `~${fmt(remainingMin)} restants d'après votre historique`}
        </div>
      )}
    </div>
  );
}
