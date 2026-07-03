/**
 * TomTomStatusPill — Pastille d'état du routage temps réel
 * ─────────────────────────────────────────────────────────────────────────────
 * Affichée en permanence (header Layout + rappel en haut des pages ETA) pour
 * indiquer d'un coup d'œil si TomTom (trafic temps réel) est actif ou non.
 *
 * Source effective du backend (/api/routing-status) :
 *   - "tomtom"     : vert  — Trafic temps réel actif (source primaire)
 *   - "osrm"       : ambre — Fallback réseau (sans trafic temps réel)
 *   - "google" /
 *     "calibrated" : gris  — Fallback secondaire / calibré terrain
 *
 * Clic → redirige vers /sources pour connecter/configurer TomTom.
 *
 * Props :
 *   compact : masque le libellé texte (icône seule) — utile sur mobile
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Link } from "wouter";
import { Zap, ZapOff } from "lucide-react";

// ─── Type de la réponse /api/routing-status ────────────────────────────────────
interface RoutingStatus {
  tomtom_connected: boolean;
  effective_source: "tomtom" | "osrm" | "google" | "calibrated";
  tomtom_priority: boolean;
  warning?: string;
}

export function TomTomStatusPill({ compact = false }: { compact?: boolean }) {
  // ─── Requête d'état routage (rafraîchie toutes les 60s) ────────────────────
  const { data } = useQuery<RoutingStatus>({
    queryKey: ["/api/routing-status"],
    queryFn: async () => (await apiRequest("GET", "/api/routing-status")).json(),
    staleTime: 20_000,
    refetchInterval: 60_000,
  });

  // ─── Dérivation source effective + apparence ──────────────────────────────
  const src = data?.effective_source ?? "calibrated";
  const isTomTom = src === "tomtom";
  const label = isTomTom ? "TomTom" : src.toUpperCase();
  const color = isTomTom ? "bg-green-100 text-green-800 border-green-400"
              : src === "osrm" ? "bg-amber-100 text-amber-800 border-amber-400"
              : "bg-gray-100 text-gray-700 border-gray-400";

  return (
    <Link href="/sources">
      <div
        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[10px] font-semibold cursor-pointer hover:opacity-80 ${color}`}
        data-testid="tomtom-status-pill"
        title={isTomTom ? "TomTom temps réel actif" : `ETA sans trafic temps réel (source: ${src}). Connecter TomTom dans Sources.`}
      >
        {isTomTom ? <Zap size={10} /> : <ZapOff size={10} />}
        {!compact && <span>{label}</span>}
      </div>
    </Link>
  );
}
