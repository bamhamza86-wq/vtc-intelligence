/**
 * PeerBenchmarkCard — Mode compétition amicale anonymisée (rapport.md §15 wow#13)
 * ─────────────────────────────────────────────────────────────────────────────
 * "Les chauffeurs comme vous dans votre secteur gagnent en moyenne X€..."
 * Design bienveillant, jamais culpabilisant : phrasé toujours positif ou neutre,
 * jamais de ton accusateur même quand le chauffeur est sous la moyenne.
 *
 * RGPD strict :
 *   - Toggle "Masquer ce comparatif" persisté en localStorage (jamais renvoyé
 *     au serveur, 100% côté client).
 *   - N'affiche jamais de comparatif si k_anonymity < 5 (le serveur renvoie
 *     peers_avg: null dans ce cas) — pas de nombre peu fiable exposé.
 *   - Disclaimer explicite "agrégat statistique anonymisé" toujours visible.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Users, EyeOff, Eye, ShieldCheck, TrendingUp, TrendingDown } from "lucide-react";

interface PeerBenchmark {
  my_stats: { hourly: number; rides_per_day: number; net_per_km: number };
  peers_avg: { hourly: number; rides_per_day: number; net_per_km: number; k_anonymity: number } | null;
  delta_pct: number | null;
  best_hour_peers: number | null;
  most_profitable_zone_peers: string | null;
  disclaimer: string;
}

const HIDE_KEY = "vtc.peer_benchmark_hidden";

export function PeerBenchmarkCard() {
  const [hidden, setHidden] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(HIDE_KEY) === "1";
  });

  const { data, isLoading } = useQuery<PeerBenchmark>({
    queryKey: ["/api/ux/peer-benchmark"],
    queryFn: () => apiRequest("GET", "/api/ux/peer-benchmark").then((r) => r.json()),
    staleTime: 60_000,
    enabled: !hidden,
  });

  function toggleHidden() {
    const next = !hidden;
    setHidden(next);
    try {
      window.localStorage.setItem(HIDE_KEY, next ? "1" : "0");
    } catch { /* localStorage indisponible — ignore */ }
  }

  if (hidden) {
    return (
      <div
        className="rounded-xl border border-border bg-card/50 px-4 py-3 flex items-center justify-between"
        data-testid="card-peer-benchmark-hidden"
      >
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <EyeOff size={16} />
          Comparatif entre chauffeurs masqué
        </div>
        <button
          type="button"
          onClick={toggleHidden}
          className="flex items-center gap-1.5 text-xs font-medium text-primary hover:underline"
          style={{ minHeight: 44 }}
          data-testid="button-peer-benchmark-show"
        >
          <Eye size={14} />
          Afficher
        </button>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="rounded-xl border border-border bg-card p-4 animate-pulse">
        <div className="h-4 w-40 bg-muted rounded mb-2" />
        <div className="h-6 w-56 bg-muted rounded" />
      </div>
    );
  }

  if (!data) return null;

  const hasPeers = data.peers_avg !== null;

  return (
    <div className="rounded-xl border border-border bg-card p-4" data-testid="card-peer-benchmark">
      <div className="flex items-start justify-between mb-2">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <Users size={16} className="text-primary" />
          Chauffeurs comme vous
        </div>
        <button
          type="button"
          onClick={toggleHidden}
          className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
          style={{ minHeight: 44, minWidth: 44 }}
          aria-label="Masquer ce comparatif"
          data-testid="button-peer-benchmark-hide"
        >
          <EyeOff size={13} />
          Masquer ce comparatif
        </button>
      </div>

      {!hasPeers ? (
        <p className="text-sm text-muted-foreground leading-relaxed" data-testid="text-peer-benchmark-insufficient">
          Pas encore assez de données pour un comparatif fiable et anonyme. Continuez à rouler —
          ce comparatif apparaîtra dès que suffisamment de périodes seront disponibles (minimum
          statistique de confidentialité).
        </p>
      ) : (
        <>
          <p className="text-sm leading-relaxed mb-3" data-testid="text-peer-benchmark-summary">
            Les chauffeurs comme vous gagnent en moyenne{" "}
            <strong className="tabular-nums">{data.peers_avg!.hourly.toFixed(0)}€/h</strong> — vous êtes à{" "}
            <strong className="tabular-nums">{data.my_stats.hourly.toFixed(0)}€/h</strong>
            {data.delta_pct !== null && (
              <span
                className={`inline-flex items-center gap-1 ml-1.5 font-semibold ${
                  data.delta_pct >= 0 ? "text-emerald-500" : "text-muted-foreground"
                }`}
              >
                {data.delta_pct >= 0 ? <TrendingUp size={14} /> : <TrendingDown size={14} />}
                {data.delta_pct >= 0 ? "+" : ""}
                {data.delta_pct}%
              </span>
            )}
            .
          </p>

          <div className="grid grid-cols-2 gap-2 mb-3">
            <div className="rounded-lg bg-muted/50 px-3 py-2">
              <div className="text-[11px] text-muted-foreground">Courses / jour</div>
              <div className="text-sm font-semibold tabular-nums">
                {data.my_stats.rides_per_day} <span className="text-muted-foreground font-normal">vs {data.peers_avg!.rides_per_day}</span>
              </div>
            </div>
            <div className="rounded-lg bg-muted/50 px-3 py-2">
              <div className="text-[11px] text-muted-foreground">Net / km</div>
              <div className="text-sm font-semibold tabular-nums">
                {data.my_stats.net_per_km.toFixed(2)}€ <span className="text-muted-foreground font-normal">vs {data.peers_avg!.net_per_km.toFixed(2)}€</span>
              </div>
            </div>
          </div>

          {(data.best_hour_peers !== null || data.most_profitable_zone_peers) && (
            <p className="text-xs text-muted-foreground mb-2">
              {data.best_hour_peers !== null && (
                <>Meilleure heure constatée : <strong>{String(data.best_hour_peers).padStart(2, "0")}h</strong>. </>
              )}
              {data.most_profitable_zone_peers && (
                <>Zone la plus rentable : <strong>{data.most_profitable_zone_peers}</strong>.</>
              )}
            </p>
          )}
        </>
      )}

      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground/80 pt-2 mt-1 border-t border-border/60">
        <ShieldCheck size={12} />
        {data.disclaimer}
      </div>
    </div>
  );
}

export default PeerBenchmarkCard;
