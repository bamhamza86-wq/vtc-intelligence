/**
 * TransitDisruptionBadge — Pastille "Grève" dans Layout header et MapPage
 * ─────────────────────────────────────────────────────────────────────────────
 * Rond rouge si une perturbation RATP-SNCF est active. Popup au clic avec le
 * détail (source, ligne/service, sévérité, description, zone impactée).
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { useState } from "react";
import { AlertTriangle, X } from "lucide-react";
import { useTransitDisruptions } from "@/hooks/useIdfEvents";
import { haptic } from "@/lib/haptics";

const SEVERITY_LABEL: Record<string, string> = {
  mineure: "Mineure",
  moderee: "Modérée",
  majeure: "Majeure",
};

export function TransitDisruptionBadge({ compact = false }: { compact?: boolean }) {
  const { disruptions, hasActive } = useTransitDisruptions();
  const [open, setOpen] = useState(false);

  if (!hasActive) return null;

  const handleClick = () => {
    haptic("tap");
    setOpen((v) => !v);
  };

  return (
    <div className="relative">
      <button
        onClick={handleClick}
        className="relative flex items-center justify-center rounded-full bg-red-500/15 text-red-400 hover:bg-red-500/25 transition"
        style={{ width: 44, height: 44 }}
        aria-label="Grève / perturbation active"
        data-testid="transit-disruption-badge"
      >
        <AlertTriangle size={compact ? 16 : 18} />
        <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-red-500 animate-pulse" />
      </button>

      {open && (
        <div
          className="absolute right-0 mt-2 w-72 max-w-[90vw] rounded-2xl border border-red-500/30 bg-slate-900 shadow-xl p-4 z-[70]"
          data-testid="transit-disruption-popup"
        >
          <div className="flex items-center justify-between mb-2">
            <h4 className="text-sm font-bold text-red-300 uppercase tracking-wide">
              Grève / Perturbation
            </h4>
            <button onClick={() => setOpen(false)} aria-label="Fermer" style={{ minWidth: 32, minHeight: 32 }}>
              <X size={16} className="text-white/60" />
            </button>
          </div>
          <div className="space-y-3">
            {disruptions.map((d) => (
              <div key={d.id} className="rounded-lg bg-white/5 p-2.5">
                <div className="flex items-center justify-between text-xs mb-1">
                  <span className="font-semibold text-white">{d.source} — {d.line_or_service}</span>
                  <span className="text-red-300">{SEVERITY_LABEL[d.severity]}</span>
                </div>
                <p className="text-xs text-white/70">{d.impact_desc}</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default TransitDisruptionBadge;
