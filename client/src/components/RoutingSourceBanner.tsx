/**
 * RoutingSourceBanner.tsx
 * ─────────────────────────────────────────────────────────────────────────────
 * Bandeau discret affiché en haut de MapPage quand TomTom n'est pas connecté.
 * Informe le chauffeur que l'ETA est calculé sans trafic temps réel (OSRM) et
 * propose un lien vers /sources pour connecter TomTom.
 *
 * Logique :
 *  - useQuery sur /api/routing-status (TTL 30s, non bloquant)
 *  - Si tomtom_connected === false → bandeau amber visible
 *  - Si tomtom_connected === true  → rien (invisible)
 *  - data-testid="routing-source-banner" pour les tests e2e
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { useSmartQueryRefresh } from "@/hooks/useSmartQueryRefresh";
import { Link } from "wouter";
import { apiRequest } from "@/lib/queryClient";
import { AlertTriangle, ExternalLink } from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────

interface RoutingStatus {
  tomtom_connected:    boolean;
  tomtom_priority:     boolean;
  warning:             string | null;
  effective_source:    string;
  routing_priority:    string;
}

// ── Composant ─────────────────────────────────────────────────────────────────

export function RoutingSourceBanner() {
  // ── Migration vers useSmartQueryRefresh : pulse 30s tab active + auto-pause en arrière-plan
  const { data } = useSmartQueryRefresh<RoutingStatus>(
    ["/api/routing-status"],
    () => apiRequest("GET", "/api/routing-status").then(r => r.json()),
    { staleTime: 20_000 },
  );

  // ── Si TomTom connecté ou données pas encore chargées → pas de bandeau ──────
  if (!data || data.tomtom_connected) return null;

  return (
    // ─────────────────────────────────────────────────────────────────────────
    // Bandeau amber discret — fond doux, texte lisible, pas intrusif
    // ─────────────────────────────────────────────────────────────────────────
    <div
      data-testid="routing-source-banner"
      className="flex items-center justify-between gap-2 px-3 py-1.5 bg-amber-100 border-b border-amber-400 text-amber-900 text-xs"
    >
      {/* Icône + message */}
      <span className="flex items-center gap-1.5 min-w-0">
        <AlertTriangle size={13} className="shrink-0 text-amber-600" />
        <span className="truncate">
          ETA sans trafic temps réel.{" "}
          <span className="font-medium">
            Source&nbsp;: {data.effective_source?.toUpperCase() ?? "OSRM"}
          </span>
        </span>
      </span>

      {/* CTA : lien vers /sources */}
      <Link
        href="/sources"
        className="flex items-center gap-1 shrink-0 font-semibold text-amber-800 hover:text-amber-950 underline underline-offset-2 transition-colors"
        data-testid="routing-source-banner-cta"
      >
        Connecter TomTom
        <ExternalLink size={11} />
      </Link>
    </div>
  );
}
