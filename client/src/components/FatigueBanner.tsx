// ──────────────────────────────────────────────────────────────────────────────
// FatigueBanner — Bandeau de fatigue conducteur (refonte feat/safety)
// ──────────────────────────────────────────────────────────────────────────────
// Affiche un bandeau coloré selon le score fatigue circadien calculé côté
// serveur (GET /api/safety/fatigue-score) : bandes vert/jaune/rouge.
// Les facteurs contribuant au score sont cliquables pour explicabilité
// (accordéon détaillant le poids de chaque facteur).
//
// Fallback : si l'appel réseau échoue, retombe sur le hook local
// useDrivingSession (comportement historique) pour ne jamais rien casser.
// ──────────────────────────────────────────────────────────────────────────────
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ChevronDown, Info } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { useDrivingSession } from "@/hooks/useDrivingSession";

interface FatigueFactor {
  name: string;
  weight: number;
}

interface FatigueScoreResponse {
  score: number;
  band: "green" | "yellow" | "red";
  factors: FatigueFactor[];
  recommendation_fr: string;
}

const BAND_CONFIG: Record<
  FatigueScoreResponse["band"],
  { container: string; barColor: string; label: string }
> = {
  green: {
    container: "bg-emerald-100 border border-emerald-400 text-emerald-900",
    barColor: "bg-emerald-500",
    label: "Fatigue faible",
  },
  yellow: {
    container: "bg-yellow-100 border border-yellow-400 text-yellow-900",
    barColor: "bg-yellow-500",
    label: "Fatigue modérée",
  },
  red: {
    container: "bg-red-200 border border-red-600 text-red-900 animate-pulse",
    barColor: "bg-red-600",
    label: "Fatigue élevée",
  },
};

// ──────────────────────────────────────────────────────────────────────────────
// Composant principal
// ──────────────────────────────────────────────────────────────────────────────
export function FatigueBanner() {
  const [expanded, setExpanded] = useState(false);
  const { fatigueLevel, resetSession } = useDrivingSession();

  const { data, isError } = useQuery<FatigueScoreResponse>({
    queryKey: ["/api/safety/fatigue-score"],
    queryFn: () => apiRequest("GET", "/api/safety/fatigue-score").then((r) => r.json()),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  // ── Fallback local si le serveur est injoignable (ne casse jamais l'UI) ──
  if (isError || !data) {
    if (fatigueLevel === "fresh") return null;
    const fallbackMessage: Record<string, string> = {
      warm: "4h de conduite — pense à une pause courte",
      tired: "6h de conduite — pause légale recommandée maintenant",
      exhausted: "8h+ — ARRÊT recommandé, danger fatigue",
    };
    return (
      <div
        className="flex items-center gap-2 rounded-xl px-3 py-2 sm:px-4 sm:py-3 bg-orange-200 border border-orange-500 text-orange-900"
        data-testid="fatigue-banner"
      >
        <AlertTriangle size={18} className="shrink-0" aria-hidden />
        <span className="flex-1 text-xs sm:text-sm font-medium truncate">
          {fallbackMessage[fatigueLevel] ?? "Fatigue détectée"}
        </span>
        <button
          onClick={resetSession}
          className="shrink-0 rounded-lg border border-current/40 bg-white/30 px-2.5 py-1 text-xs font-semibold hover:bg-white/50 active:bg-white/60 transition-colors whitespace-nowrap"
          type="button"
          data-testid="fatigue-banner-reset"
        >
          Pause ✓
        </button>
      </div>
    );
  }

  // Score vert et aucun facteur : rien à afficher (comportement "fresh" préservé)
  if (data.band === "green" && data.factors.length === 0) return null;

  const cfg = BAND_CONFIG[data.band];

  return (
    <div
      className={`rounded-xl px-3 py-2 sm:px-4 sm:py-3 ${cfg.container}`}
      data-testid="fatigue-banner"
      data-band={data.band}
    >
      <div className="flex items-center gap-2">
        <AlertTriangle size={18} className="shrink-0" aria-hidden />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-xs sm:text-sm font-bold">{cfg.label}</span>
            <span className="text-[11px] font-mono tabular-nums opacity-80">{data.score}/100</span>
          </div>
          {/* Barre de score */}
          <div className="mt-1 h-1.5 w-full max-w-[160px] rounded-full bg-black/10 overflow-hidden">
            <div className={`h-full ${cfg.barColor}`} style={{ width: `${data.score}%` }} />
          </div>
        </div>
        {data.factors.length > 0 && (
          <button
            type="button"
            onClick={() => setExpanded((e) => !e)}
            className="shrink-0 rounded-lg border border-current/30 bg-white/30 px-2 py-1.5 hover:bg-white/50 active:bg-white/60 transition-colors flex items-center gap-1"
            style={{ minHeight: 32 }}
            aria-expanded={expanded}
            aria-label="Voir les facteurs de fatigue"
            data-testid="fatigue-banner-expand"
          >
            <Info size={13} />
            <ChevronDown size={13} className={`transition-transform ${expanded ? "rotate-180" : ""}`} />
          </button>
        )}
      </div>

      {/* Facteurs cliquables (explicabilité) */}
      {expanded && (
        <div className="mt-2 pt-2 border-t border-current/20 space-y-1.5" data-testid="fatigue-banner-factors">
          {data.factors.map((f, i) => (
            <div key={i} className="flex items-center justify-between text-[11px] gap-2">
              <span className="truncate">{f.name}</span>
              <span className="font-mono font-bold tabular-nums shrink-0">+{f.weight}</span>
            </div>
          ))}
          <p className="text-[10px] opacity-80 pt-1 italic">{data.recommendation_fr}</p>
          <p className="text-[9px] opacity-60 pt-0.5">
            Estimation statistique — pas un diagnostic médical.
          </p>
        </div>
      )}
    </div>
  );
}

export default FatigueBanner;
