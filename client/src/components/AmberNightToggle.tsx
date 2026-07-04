/**
 * AmberNightToggle — Sélecteur 3 positions du mode nuit ambre
 * ─────────────────────────────────────────────────────────────────────────────
 * Off / Auto (21h–6h) / On, avec icônes lucide Sun / SunMoon / Moon.
 * Pilote le hook useAmberNight (localStorage `vtc.amberNight`).
 *
 * Intégré dans MobileSettings (voir section "Mode nuit ambre").
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { Sun, SunMoon, Moon } from "lucide-react";
import { useAmberNight, type AmberNightMode } from "@/hooks/useAmberNight";

// ─── Config des options ───────────────────────────────────────────────────────

interface ModeOption {
  value: AmberNightMode;
  label: string;
  icon: typeof Sun;
  activeCls: string;
}

const MODE_OPTIONS: ModeOption[] = [
  {
    value: "off",
    label: "Off",
    icon: Sun,
    activeCls: "bg-zinc-500/20 border-zinc-500/60 text-zinc-200 font-semibold",
  },
  {
    value: "auto",
    label: "Auto",
    icon: SunMoon,
    activeCls: "bg-orange-500/20 border-orange-500/60 text-orange-300 font-semibold",
  },
  {
    value: "on",
    label: "On",
    icon: Moon,
    activeCls: "bg-orange-600/25 border-orange-600/70 text-orange-400 font-semibold",
  },
];

// ─── Composant ────────────────────────────────────────────────────────────────

export function AmberNightToggle() {
  const { mode, setMode } = useAmberNight();

  return (
    <div
      data-testid="amber-night-toggle"
      className="flex items-center gap-0.5 rounded-md border border-border bg-card/50 p-0.5"
      role="group"
      aria-label="Mode nuit ambre"
    >
      {MODE_OPTIONS.map((opt) => {
        const isActive = mode === opt.value;
        const Icon = opt.icon;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => setMode(opt.value)}
            data-testid={`amber-night-btn-${opt.value}`}
            aria-pressed={isActive}
            title={`Mode nuit ambre : ${opt.label}`}
            className={`
              flex items-center gap-1 px-2 py-1.5 rounded text-[11px] leading-none
              border transition-colors min-h-[36px]
              ${isActive ? opt.activeCls : "bg-transparent border-transparent text-muted-foreground hover:text-foreground hover:bg-accent/50"}
            `}
          >
            <Icon size={14} />
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

export default AmberNightToggle;
