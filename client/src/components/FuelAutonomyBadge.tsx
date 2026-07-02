// ──────────────────────────────────────────────────────────────────────────────
// FuelAutonomyBadge — Badge compact d'autonomie carburant
// ──────────────────────────────────────────────────────────────────────────────
// Affiche "180km · 6h" avec l'icône Fuel de lucide-react.
// Un clic ouvre un prompt natif pour remettre à zéro le compteur km après plein.
// ──────────────────────────────────────────────────────────────────────────────
import { Fuel } from "lucide-react";
import { useFuelAutonomy } from "@/hooks/useFuelAutonomy";

// ──────────────────────────────────────────────────────────────────────────────
// Composant principal
// ──────────────────────────────────────────────────────────────────────────────
export function FuelAutonomyBadge() {
  const { kmProfitableLeft, hoursLeft, resetTank } = useFuelAutonomy();

  function handleClick() {
    const raw = prompt(
      `Autonomie restante actuelle : ${Math.round(kmProfitableLeft)} km\n\nEntrez le nombre de km après le plein (ex: 600) :`,
      String(Math.round(kmProfitableLeft)),
    );
    if (raw === null) return; // annulé
    const km = parseFloat(raw);
    if (!isNaN(km) && km >= 0) {
      resetTank(km);
    }
  }

  const fmtH = (h: number) => {
    if (h < 1) return `${Math.round(h * 60)}min`;
    const hFloor = Math.floor(h);
    const m = Math.round((h - hFloor) * 60);
    return m > 0 ? `${hFloor}h${m.toString().padStart(2, "0")}` : `${hFloor}h`;
  };

  return (
    // ─── Compact mobile : badge pill condensé ─────────────────────────────────
    <button
      onClick={handleClick}
      type="button"
      className="flex items-center gap-1 rounded-full border border-white/20 bg-white/5 hover:bg-white/15 active:bg-white/25 px-2 sm:px-3 py-1 sm:py-1.5 text-[10px] sm:text-[11px] text-white/70 font-medium transition-colors select-none"
      data-testid="fuel-autonomy-badge"
      title="Cliquez pour mettre à jour l'autonomie après un plein"
    >
      <Fuel size={12} className="shrink-0 text-amber-400" />
      <span className="tabular-nums">
        {Math.round(kmProfitableLeft)}km
        <span className="hidden sm:inline"> · {fmtH(hoursLeft)}</span>
      </span>
    </button>
  );
}
