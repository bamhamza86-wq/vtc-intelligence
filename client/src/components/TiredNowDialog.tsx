/**
 * TiredNowDialog — Dialog "Je me sens fatigué" 1-tap (feat/safety)
 * ─────────────────────────────────────────────────────────────────────────────
 * Déclenché depuis QuickActionBar. Appelle POST /api/safety/tired-now puis
 * affiche : 3 zones de repos à proximité (aire de repos / WC / café),
 * un timer visuel de 20 minutes, et l'impact estimé sur le gain (honnête,
 * pas culpabilisant : présenté comme "pause = sécurité").
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { useEffect, useRef, useState } from "react";
import { Coffee, MapPin, X, Bed } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { haptics } from "@/lib/haptics";

const BREAK_DURATION_SEC = 20 * 60;

interface RestZone {
  type: "aire_repos" | "wc" | "cafe" | string;
  label: string;
  distance_km?: number;
}

interface TiredNowResponse {
  rest_zones?: RestZone[];
  estimated_break_revenue_impact_eur?: number;
  message_fr?: string;
}

const ICONS: Record<string, typeof Coffee> = {
  aire_repos: Bed,
  wc: MapPin,
  cafe: Coffee,
};

const FALLBACK_ZONES: RestZone[] = [
  { type: "aire_repos", label: "Aire de repos la plus proche" },
  { type: "wc", label: "Toilettes publiques" },
  { type: "cafe", label: "Café / boulangerie" },
];

export function TiredNowDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [data, setData] = useState<TiredNowResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(BREAK_DURATION_SEC);
  const [timerRunning, setTimerRunning] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setData(null);
    setSecondsLeft(BREAK_DURATION_SEC);
    setTimerRunning(false);
    haptics.fatigue();
    apiRequest("POST", "/api/safety/tired-now")
      .then((r) => r.json())
      .then((res) => setData(res))
      .catch(() => setData({ rest_zones: FALLBACK_ZONES }))
      .finally(() => setLoading(false));
  }, [open]);

  useEffect(() => {
    if (!timerRunning) return;
    intervalRef.current = setInterval(() => {
      setSecondsLeft((s) => {
        if (s <= 1) {
          if (intervalRef.current) clearInterval(intervalRef.current);
          haptics.arrival();
          setTimerRunning(false);
          return 0;
        }
        return s - 1;
      });
    }, 1000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [timerRunning]);

  if (!open) return null;

  const zones = data?.rest_zones && data.rest_zones.length > 0 ? data.rest_zones : FALLBACK_ZONES;
  const pct = ((BREAK_DURATION_SEC - secondsLeft) / BREAK_DURATION_SEC) * 100;
  const mm = String(Math.floor(secondsLeft / 60)).padStart(2, "0");
  const ss = String(secondsLeft % 60).padStart(2, "0");

  return (
    <div className="fixed inset-0 z-[80] bg-black/75 flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <div className="bg-zinc-900 border-2 border-amber-500/60 rounded-2xl p-5 max-w-sm w-full text-white max-h-[85vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2 text-amber-400">
            <Coffee size={24} />
            <h2 className="text-lg font-black">Je me sens fatigué</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-lg hover:bg-white/10"
            style={{ minWidth: 44, minHeight: 44 }}
            aria-label="Fermer"
            data-testid="button-tired-now-close"
          >
            <X size={18} />
          </button>
        </div>

        <p className="text-xs text-white/70 mb-4">
          Une pause de 20 minutes réduit significativement le risque au volant. Voici les
          options les plus proches.
        </p>

        {loading ? (
          <div className="text-sm text-white/50 py-6 text-center">Recherche des zones de repos…</div>
        ) : (
          <div className="space-y-2 mb-4">
            {zones.slice(0, 3).map((z, i) => {
              const Icon = ICONS[z.type] ?? MapPin;
              return (
                <div
                  key={i}
                  className="flex items-center gap-3 rounded-xl bg-white/10 px-4 py-3"
                  data-testid={`tired-now-zone-${z.type}`}
                >
                  <Icon size={22} className="text-amber-300 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold truncate">{z.label}</div>
                    {z.distance_km != null && (
                      <div className="text-xs text-white/60">{z.distance_km.toFixed(1)} km</div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Timer visuel 20 min */}
        <div className="rounded-xl bg-black/40 border border-white/10 p-4 mb-4 text-center">
          <div className="text-[11px] uppercase tracking-widest text-amber-300/80 font-bold mb-2">
            Minuteur de pause
          </div>
          <div className="text-4xl font-black tabular-nums mb-3" data-testid="tired-now-timer-value">
            {mm}:{ss}
          </div>
          <div className="h-2 rounded-full bg-white/10 overflow-hidden mb-3">
            <div
              className="h-full rounded-full bg-amber-400 transition-all duration-1000"
              style={{ width: `${pct}%` }}
            />
          </div>
          {!timerRunning && secondsLeft > 0 && (
            <button
              type="button"
              onClick={() => {
                haptics.confirm();
                setTimerRunning(true);
              }}
              className="w-full rounded-xl bg-amber-500 hover:bg-amber-400 text-black font-bold py-3"
              style={{ minHeight: 48 }}
              data-testid="button-tired-now-start-timer"
            >
              Démarrer la pause de 20 min
            </button>
          )}
          {timerRunning && (
            <button
              type="button"
              onClick={() => setTimerRunning(false)}
              className="w-full rounded-xl bg-white/10 hover:bg-white/20 font-semibold py-3"
              style={{ minHeight: 48 }}
              data-testid="button-tired-now-pause-timer"
            >
              Mettre en pause le minuteur
            </button>
          )}
          {secondsLeft === 0 && (
            <div className="text-emerald-300 font-bold text-sm">Pause terminée — bonne reprise !</div>
          )}
        </div>

        {data?.estimated_break_revenue_impact_eur != null && (
          <p className="text-[11px] text-white/50 text-center">
            Impact estimé sur le gain de cette pause : ~{Math.round(data.estimated_break_revenue_impact_eur)} €
            — un accident coûte toujours plus cher.
          </p>
        )}
      </div>
    </div>
  );
}

export default TiredNowDialog;
