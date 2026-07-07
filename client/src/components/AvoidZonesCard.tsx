/**
 * AvoidZonesCard — Couche Communautaire : carte "À éviter"
 * ─────────────────────────────────────────────────────────────────────────────
 * Affiche le top 3 des zones à éviter (agrégation signaux safety + dead) via
 * GET /api/community/avoid-zones, avec raison et un timer de fraîcheur.
 * Utilisé sur MapPage et FocusPage.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ShieldAlert, MapPinOff } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";

export interface AvoidZone {
  zone_id: string;
  zone_name: string;
  reason: string;
  signal_count: number;
  freshness: number;
  expires_at: string;
}

function freshnessLabel(freshness: number): string {
  if (freshness >= 0.66) return "Très frais";
  if (freshness >= 0.33) return "Frais";
  return "S'estompe";
}

export interface AvoidZonesCardProps {
  className?: string;
  /** Nombre max de zones affichées (défaut 3). */
  limit?: number;
  onSelectZone?: (zoneId: string) => void;
}

export function AvoidZonesCard({ className = "", limit = 3, onSelectZone }: AvoidZonesCardProps) {
  const { data } = useQuery<{ zones: AvoidZone[] }>({
    queryKey: ["/api/community/avoid-zones", limit],
    queryFn: () => apiRequest("GET", `/api/community/avoid-zones?limit=${limit}`).then((r) => r.json()),
    refetchInterval: 20_000,
  });

  const zones = (data?.zones ?? []).slice(0, limit);
  if (!zones.length) return null;

  return (
    <div
      data-testid="avoid-zones-card"
      className={`rounded-xl border border-red-500/30 bg-red-950/30 backdrop-blur px-3 py-2.5 ${className}`}
    >
      <p className="flex items-center gap-1.5 text-xs font-bold text-red-400 mb-1.5">
        <ShieldAlert size={13} /> À éviter
      </p>
      <ul className="space-y-1.5">
        {zones.map((z) => (
          <li key={z.zone_id}>
            <button
              type="button"
              data-testid={`avoid-zone-${z.zone_id}`}
              onClick={() => onSelectZone?.(z.zone_id)}
              className="w-full text-left flex items-start gap-2 rounded-lg px-2 py-1.5 hover:bg-white/5 transition-colors"
              style={{ minHeight: 44 }}
            >
              <MapPinOff size={13} className="text-red-400 shrink-0 mt-0.5" />
              <span className="flex-1 min-w-0">
                <span className="block text-xs font-semibold text-white truncate">{z.zone_name}</span>
                <span className="block text-[10px] text-red-300/80 truncate">{z.reason}</span>
              </span>
              <span className="flex items-center gap-1 text-[10px] text-muted-foreground shrink-0 whitespace-nowrap">
                <AlertTriangle size={10} />
                {freshnessLabel(z.freshness)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default AvoidZonesCard;
