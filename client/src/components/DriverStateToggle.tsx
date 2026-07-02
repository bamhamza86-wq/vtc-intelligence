/**
 * DriverStateToggle — Sélecteur d'état chauffeur (Disponible / En course / Pause)
 * ─────────────────────────────────────────────────────────────────────────────
 * 3 boutons segmentés compacts :
 *   • available  → vert
 *   • on_ride    → bleu
 *   • pause      → gris
 *
 * L'état actif est surligné. Persiste via useDriverState (localStorage).
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { useDriverState, type DriverState } from "@/hooks/useDriverState";

// ─── Config des états ─────────────────────────────────────────────────────────

interface StateOption {
  value: DriverState;
  label: string;
  /** Classes Tailwind pour l'état actif */
  activeCls: string;
  /** Classes Tailwind pour l'état inactif */
  inactiveCls: string;
}

const STATE_OPTIONS: StateOption[] = [
  {
    value:      "available",
    label:      "Dispo",
    activeCls:  "bg-emerald-500/20 border-emerald-500/60 text-emerald-300 font-semibold",
    inactiveCls: "bg-transparent border-transparent text-muted-foreground hover:text-foreground hover:bg-accent/50",
  },
  {
    value:      "on_ride",
    label:      "En course",
    activeCls:  "bg-blue-500/20 border-blue-500/60 text-blue-300 font-semibold",
    inactiveCls: "bg-transparent border-transparent text-muted-foreground hover:text-foreground hover:bg-accent/50",
  },
  {
    value:      "pause",
    label:      "Pause",
    activeCls:  "bg-zinc-500/20 border-zinc-500/60 text-zinc-300 font-semibold",
    inactiveCls: "bg-transparent border-transparent text-muted-foreground hover:text-foreground hover:bg-accent/50",
  },
];

// ─── Composant ────────────────────────────────────────────────────────────────

export function DriverStateToggle() {
  const { state, setState, sinceMinutes } = useDriverState();

  return (
    <div
      data-testid="driver-state-toggle"
      className="flex items-center gap-0.5 rounded-md border border-border bg-card/50 p-0.5"
      role="group"
      aria-label="État chauffeur"
    >
      {STATE_OPTIONS.map((opt) => {
        const isActive = state === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => setState(opt.value)}
            data-testid={`driver-state-btn-${opt.value}`}
            aria-pressed={isActive}
            title={
              isActive
                ? `${opt.label} depuis ${sinceMinutes} min`
                : `Passer en état "${opt.label}"`
            }
            className={`
              px-2 py-1 rounded text-[11px] leading-none
              border transition-colors
              ${isActive ? opt.activeCls : opt.inactiveCls}
            `}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

export default DriverStateToggle;
