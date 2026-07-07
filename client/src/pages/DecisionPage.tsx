/**
 * DecisionPage.tsx — Couche Décision Avancée (/#/decision)
 * ─────────────────────────────────────────────────────────────────────────────
 * 3 sections :
 *  1. « Enchaîner ma prochaine séquence » — trip-chains horizontales
 *  2. « Simulateur — que dois-je faire maintenant ? » — What-If comparatif
 *  3. « Coach VTC » — chatbot minimaliste + FAQ + tips proactifs
 *
 * Backend : server/decisionEngine.ts (GET /api/decision/trip-chain,
 * POST /api/decision/what-if, POST /api/coach/ask, GET /api/coach/proactive-tips).
 * Aucune nouvelle dépendance npm.
 */
import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, API_BASE, getAuthToken } from "@/lib/queryClient";
import { useGpsPosition } from "@/hooks/useGpsPosition";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import {
  Sparkles, ArrowRight, Euro, Timer, Zap, Plane, Home as HomeIcon,
  Hourglass, BarChart3, TrendingUp, TrendingDown, Minus,
} from "lucide-react";
import { CoachSidebar } from "@/components/CoachSidebar";
import { ProactiveTipsCard } from "@/components/ProactiveTipsCard";
import { TripChainWidget } from "@/components/TripChainWidget";

// ─── Types (alignés sur decisionEngine.ts) ─────────────────────────────────────

interface WhatIfResult {
  label: string;
  expected_net_eur: number;
  expected_duration_min: number;
  delta_vs_current: number;
  factors_fr: string[];
  confidence: number;
}

// ─── Boutons rapides du simulateur What-If ─────────────────────────────────────

const QUICK_SCENARIOS: { label: string; action: Record<string, unknown> }[] = [
  { label: "Aller à CDG", action: { type: "goto_zone", zone_name: "Aéroport CDG" } },
  { label: "Aller à La Défense", action: { type: "goto_zone", zone_name: "La Défense" } },
  { label: "Attendre 10 min ici", action: { type: "wait", wait_min: 10 } },
  { label: "Rentrer", action: { type: "goto_zone", zone_name: "Domicile" } },
];

const QUICK_ICON: Record<string, React.ComponentType<{ size?: number; className?: string }>> = {
  "Aller à CDG": Plane,
  "Aller à La Défense": ArrowRight,
  "Attendre 10 min ici": Hourglass,
  "Rentrer": HomeIcon,
};

function DeltaIcon({ delta }: { delta: number }) {
  if (delta > 0.5) return <TrendingUp size={13} className="text-emerald-400" />;
  if (delta < -0.5) return <TrendingDown size={13} className="text-red-400" />;
  return <Minus size={13} className="text-slate-400" />;
}

// ─── Simulateur What-If ─────────────────────────────────────────────────────────

function WhatIfSimulator() {
  const { position } = useGpsPosition();
  const [selected, setSelected] = useState<string[]>(["Aller à CDG", "Aller à La Défense", "Attendre 10 min ici"]);

  const mutation = useMutation({
    mutationFn: async () => {
      const scenarios = QUICK_SCENARIOS.filter((s) => selected.includes(s.label)).map((s) => ({
        label: s.label,
        action: { ...s.action, origin_lat: position.lat, origin_lng: position.lng },
      }));
      const res = await apiRequest("POST", "/api/decision/what-if", { scenarios });
      return (await res.json()) as WhatIfResult[];
    },
  });

  const toggle = (label: string) => {
    setSelected((s) => (s.includes(label) ? s.filter((x) => x !== label) : [...s, label]));
  };

  const maxNet = mutation.data ? Math.max(1, ...mutation.data.map((r) => r.expected_net_eur)) : 1;

  return (
    <section className="rounded-2xl border border-white/10 bg-slate-900/60 p-4 space-y-4" data-testid="section-what-if">
      <p className="text-sm font-semibold text-white flex items-center gap-2">
        <BarChart3 size={15} className="text-indigo-400" />
        Simulateur — que dois-je faire maintenant ?
      </p>

      <div className="flex flex-wrap gap-2">
        {QUICK_SCENARIOS.map((s) => {
          const Icon = QUICK_ICON[s.label] ?? Zap;
          const active = selected.includes(s.label);
          return (
            <button
              key={s.label}
              onClick={() => toggle(s.label)}
              className={`tap-target flex items-center gap-1.5 px-3 py-2 rounded-xl border text-xs font-medium transition-colors active:scale-95 ${
                active
                  ? "border-indigo-400/50 bg-indigo-500/15 text-indigo-200"
                  : "border-white/10 bg-slate-800/50 text-slate-400"
              }`}
              style={{ minHeight: 44 }}
              data-testid={`button-scenario-${s.label}`}
            >
              <Icon size={14} /> {s.label}
            </button>
          );
        })}
      </div>

      <Button
        className="w-full h-11"
        disabled={selected.length < 2 || mutation.isPending}
        onClick={() => mutation.mutate()}
        data-testid="button-run-what-if"
      >
        {mutation.isPending ? "Simulation en cours…" : `Comparer ${selected.length} scénarios`}
      </Button>

      {selected.length < 2 && (
        <p className="text-[11px] text-slate-500 italic">Sélectionnez au moins 2 scénarios à comparer.</p>
      )}

      {mutation.data && (
        <div className="space-y-2.5" data-testid="what-if-results">
          {mutation.data.map((r, i) => (
            <div key={i} className="space-y-1" data-testid={`what-if-result-${i}`}>
              <div className="flex items-center justify-between text-xs">
                <span className="font-medium text-slate-200 flex items-center gap-1">
                  <DeltaIcon delta={r.delta_vs_current} /> {r.label}
                </span>
                <span className="tabular-nums text-emerald-300 font-semibold">
                  {r.expected_net_eur.toFixed(2)} € · {r.expected_duration_min} min
                </span>
              </div>
              <div className="h-2 rounded-full bg-slate-800 overflow-hidden">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-indigo-500 to-emerald-500"
                  style={{ width: `${Math.max(4, (r.expected_net_eur / maxNet) * 100)}%` }}
                />
              </div>
              {r.factors_fr.length > 0 && (
                <p className="text-[10px] text-slate-500 leading-snug">{r.factors_fr.join(" · ")}</p>
              )}
            </div>
          ))}
        </div>
      )}

      {mutation.isError && (
        <p className="text-xs text-red-400">Impossible de simuler ces scénarios pour le moment.</p>
      )}
    </section>
  );
}

// ─── Page principale ─────────────────────────────────────────────────────────

export default function DecisionPage() {
  return (
    <div className="p-4 space-y-4 pb-24" data-testid="page-decision">
      <div>
        <h1 className="text-lg font-bold text-white flex items-center gap-2">
          <Sparkles size={18} className="text-indigo-400" />
          Décision Avancée
        </h1>
        <p className="text-xs text-slate-400 mt-0.5">
          Enchaînez vos courses, simulez vos choix, posez vos questions au coach VTC.
        </p>
      </div>

      <ProactiveTipsCard />

      {/* ── Section 1 : trip-chaining ─────────────────────────────────────── */}
      <section data-testid="section-trip-chain">
        <p className="text-sm font-semibold text-white flex items-center gap-2 mb-2">
          <ArrowRight size={15} className="text-emerald-400" />
          Enchaîner ma prochaine séquence
        </p>
        <TripChainWidget />
      </section>

      {/* ── Section 2 : What-If ───────────────────────────────────────────── */}
      <WhatIfSimulator />

      {/* ── Section 3 : Coach VTC ─────────────────────────────────────────── */}
      <CoachSidebar title="Coach VTC — questions fiscales & statut" />
    </div>
  );
}
