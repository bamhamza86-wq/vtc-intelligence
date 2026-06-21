/**
 * RouteSourceBadge — Indicateur de la source des données distance/ETA
 * ─────────────────────────────────────────────────────────────────────────────
 * Affiche un petit badge indiquant d'où proviennent les calculs ETA/distance :
 *   - "tomtom"     : Trafic temps réel (TomTom Routing API — source primaire)
 *   - "osrm"       : OSRM (fallback réseau, sans trafic temps réel)
 *   - "google"     : Google Maps (fallback optionnel)
 *   - "calibrated" : Calibré (fallback mesures terrain)
 *
 * Props :
 *   source    : "tomtom" | "osrm" | "google" | "calibrated" | string | undefined
 *   size      : "sm" | "xs"   (taille de la pastille)
 *   className : classes additionnelles (rétro-compat)
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { Badge } from "@/components/ui/badge";

interface Props {
  source?: string | null;
  size?: "sm" | "xs";
  className?: string;
}

export function RouteSourceBadge({ source, size = "sm", className = "" }: Props) {
  const cls = size === "xs" ? "text-[10px] px-1.5 py-0" : "text-xs px-2 py-0.5";
  if (source === "tomtom") return (
    <Badge className={`${cls} bg-green-500/20 text-green-400 border-green-500/30 border ${className}`}>
      Trafic temps réel
    </Badge>
  );
  if (source === "osrm") return (
    <Badge className={`${cls} bg-blue-500/20 text-blue-400 border-blue-500/30 border ${className}`}>
      OSRM
    </Badge>
  );
  if (source === "google") return (
    <Badge className={`${cls} bg-purple-500/20 text-purple-400 border-purple-500/30 border ${className}`}>
      Google Maps
    </Badge>
  );
  return (
    <Badge className={`${cls} bg-gray-500/20 text-gray-400 border-gray-500/30 border ${className}`}>
      Calibré
    </Badge>
  );
}
