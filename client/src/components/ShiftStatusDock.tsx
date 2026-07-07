/**
 * ShiftStatusDock — Widget de statut permanent (couche Wow-factor polish)
 * ─────────────────────────────────────────────────────────────────────────────
 * Petit dock fin ancré juste au-dessus de la bottom nav, visible sur toutes
 * les pages authentifiées. Affiche en un coup d'œil :
 *   - minutes actives cumulées du shift en cours
 *   - gain net estimé du jour (€)
 *   - le prochain conseil actionnable (fin de shift, focus, etc.)
 *
 * Données : GET /api/focus/rhythm (déjà existant, refetch 30s).
 * Tap → ouvre un résumé de jour condensé en BottomSheet (résumé, pas de
 * nouvelle page). Repliable (chevron) et mémorise l'état replié en session.
 *
 * Zéro dépendance nouvelle. 44px de zone tactile mini pour le tap principal.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Clock, Euro, Sparkles, ChevronUp, ChevronDown } from "lucide-react";
import { BottomSheet } from "@/components/BottomSheet";
import { useLocation } from "wouter";

interface RhythmResponse {
  elapsedMin: number;
  activeMin: number;
  earningsEur: number;
  targetEur: number;
  targetPct: number;
  rideCount: number;
  hourlyRate: number;
  endShiftSuggestionMin: number | null;
}

const COLLAPSE_KEY = "vtc.shiftdock_collapsed";

function fmtMinutes(min: number): string {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m > 0 ? `${h}h${String(m).padStart(2, "0")}` : `${h}h`;
}

function nextTip(r: RhythmResponse): string {
  if (r.endShiftSuggestionMin != null) {
    return `Objectif atteint à ${r.targetPct.toFixed(0)}% — envisagez de finir dans ${fmtMinutes(r.endShiftSuggestionMin)}`;
  }
  if (r.rideCount === 0) {
    return "Aucune course enregistrée aujourd'hui — direction Focus pour démarrer";
  }
  if (r.targetPct < 50) {
    return `${r.targetPct.toFixed(0)}% de l'objectif du jour — Focus vous guide vers la meilleure zone`;
  }
  return `${r.targetPct.toFixed(0)}% de l'objectif — bon rythme, continuez ainsi`;
}

// Pages où le dock ne doit pas s'afficher (mode conduite glancable = priorité absolue à la route)
const HIDDEN_ON = ["/drive"];

export function ShiftStatusDock() {
  const [location, navigate] = useLocation();
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.sessionStorage.getItem(COLLAPSE_KEY) === "1";
  });
  const [sheetOpen, setSheetOpen] = useState(false);

  const { data } = useQuery<RhythmResponse>({
    queryKey: ["/api/focus/rhythm"],
    queryFn: () => apiRequest("GET", "/api/focus/rhythm").then((r) => r.json()),
    refetchInterval: 30_000,
    staleTime: 20_000,
  });

  const tip = useMemo(() => (data ? nextTip(data) : ""), [data]);

  if (HIDDEN_ON.includes(location)) return null;
  if (!data) return null;

  function toggleCollapsed() {
    setCollapsed((prev) => {
      const next = !prev;
      try { window.sessionStorage.setItem(COLLAPSE_KEY, next ? "1" : "0"); } catch { /* ignore */ }
      return next;
    });
  }

  return (
    <>
      <div
        className="fixed inset-x-0 z-[55] flex justify-center px-2 pointer-events-none"
        style={{ bottom: "calc(56px + env(safe-area-inset-bottom, 0px) + 4px)" }}
        data-testid="shift-status-dock"
      >
        <div className="w-full max-w-md pointer-events-auto">
          {collapsed ? (
            <button
              onClick={toggleCollapsed}
              className="mx-auto flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-card/95 backdrop-blur border border-border shadow-lg text-[10px] text-muted-foreground hover:text-foreground transition-colors"
              style={{ minHeight: 32 }}
              aria-label="Déplier le résumé du shift"
              data-testid="shift-dock-expand"
            >
              <Clock size={11} />
              {fmtMinutes(data.activeMin)}
              <span className="text-emerald-500 font-semibold">{data.earningsEur.toFixed(0)}€</span>
              <ChevronUp size={11} />
            </button>
          ) : (
            <div className="rounded-2xl bg-card/95 backdrop-blur border border-border shadow-lg overflow-hidden animate-slide-up-dock">
              <button
                onClick={() => setSheetOpen(true)}
                className="w-full flex items-center gap-3 px-3.5 py-2.5 text-left hover:bg-accent/50 transition-colors"
                style={{ minHeight: 44 }}
                data-testid="shift-dock-open-summary"
              >
                <div className="flex items-center gap-1.5 shrink-0">
                  <Clock size={14} className="text-primary" />
                  <span className="text-xs font-bold tabular-nums">{fmtMinutes(data.activeMin)}</span>
                </div>
                <div className="w-px h-4 bg-border shrink-0" />
                <div className="flex items-center gap-1.5 shrink-0">
                  <Euro size={14} className="text-emerald-500" />
                  <span className="text-xs font-bold tabular-nums text-emerald-500">{data.earningsEur.toFixed(0)}€</span>
                </div>
                <div className="w-px h-4 bg-border shrink-0" />
                <div className="flex items-center gap-1.5 min-w-0 flex-1">
                  <Sparkles size={13} className="text-amber-400 shrink-0" />
                  <span className="text-[11px] text-muted-foreground truncate">{tip}</span>
                </div>
                <button
                  onClick={(e) => { e.stopPropagation(); toggleCollapsed(); }}
                  className="shrink-0 p-1.5 rounded-lg hover:bg-accent text-muted-foreground"
                  style={{ minWidth: 28, minHeight: 28 }}
                  aria-label="Replier le résumé du shift"
                  data-testid="shift-dock-collapse"
                >
                  <ChevronDown size={13} />
                </button>
              </button>
            </div>
          )}
        </div>
      </div>

      <BottomSheet open={sheetOpen} onClose={() => setSheetOpen(false)} title="Résumé du jour" snapPoints={[0.3, 0.6]} initialSnap={0}>
        <div className="px-4 pb-6 pt-2 space-y-4">
          <div className="grid grid-cols-3 gap-2">
            <div className="rounded-xl bg-muted/50 p-3 text-center">
              <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1">Actif</p>
              <p className="text-base font-black tabular-nums">{fmtMinutes(data.activeMin)}</p>
            </div>
            <div className="rounded-xl bg-emerald-500/10 p-3 text-center">
              <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1">Gain net</p>
              <p className="text-base font-black tabular-nums text-emerald-500">{data.earningsEur.toFixed(0)}€</p>
            </div>
            <div className="rounded-xl bg-muted/50 p-3 text-center">
              <p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1">€/h</p>
              <p className="text-base font-black tabular-nums">{data.hourlyRate.toFixed(0)}€</p>
            </div>
          </div>
          <div>
            <div className="flex items-center justify-between text-[11px] text-muted-foreground mb-1">
              <span>Objectif du jour</span>
              <span className="font-semibold">{data.targetPct.toFixed(0)}%</span>
            </div>
            <div className="h-2 rounded-full bg-muted overflow-hidden">
              <div
                className="h-full rounded-full bg-primary transition-all"
                style={{ width: `${Math.min(100, data.targetPct)}%` }}
              />
            </div>
            <p className="text-[10px] text-muted-foreground mt-1">{data.earningsEur.toFixed(0)}€ / {data.targetEur}€ objectif</p>
          </div>
          <div className="rounded-xl bg-amber-400/10 border border-amber-400/20 p-3 flex items-start gap-2">
            <Sparkles size={14} className="text-amber-400 mt-0.5 shrink-0" />
            <p className="text-xs leading-relaxed">{tip}</p>
          </div>
          <button
            onClick={() => { setSheetOpen(false); navigate("/focus"); }}
            className="w-full py-3 rounded-xl bg-primary text-primary-foreground font-semibold text-sm hover:opacity-90 transition-opacity"
            style={{ minHeight: 44 }}
            data-testid="shift-dock-go-focus"
          >
            Aller au Focus
          </button>
        </div>
      </BottomSheet>

      <style>{`
        @keyframes slide-up-dock {
          from { opacity: 0; transform: translateY(10px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        .animate-slide-up-dock { animation: slide-up-dock 220ms cubic-bezier(.2,.9,.3,1); }
        @media (prefers-reduced-motion: reduce) {
          .animate-slide-up-dock { animation: none; }
        }
      `}</style>
    </>
  );
}

export default ShiftStatusDock;
