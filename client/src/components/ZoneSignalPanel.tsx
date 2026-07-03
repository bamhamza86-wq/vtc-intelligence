/**
 * ZoneSignalPanel — Levier 9 : bloc "signalement communautaire" pour panneau zone
 * ─────────────────────────────────────────────────────────────────────────────
 * Bloc prêt à intégrer dans le panneau de détail d'une zone (popup carte).
 *
 * ⚠️ Contexte d'intégration :
 * Le panneau de détail zone est actuellement rendu EN LIGNE dans MapPage.tsx
 * (bloc `{selectedZone && (...)}`, ~ligne 837), qui est HORS PÉRIMÈTRE de ce lot
 * (fichier interdit à la modification). Il n'existe pas de composant panneau
 * enfant séparé à modifier.
 *
 * Ce composant est donc livré prêt à l'emploi. Intégration future (1 ligne) :
 *
 *   // dans le <CardContent> du popup zone de MapPage.tsx :
 *   import { ZoneSignalPanel } from "@/components/ZoneSignalPanel";
 *   ...
 *   <ZoneSignalPanel zoneId={selectedZone.zone.id} />
 *
 * Il englobe CommunitySignalButtons avec un libellé FR et le boost communautaire
 * courant (±8%) issu de useCommunityImpact.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { Users } from "lucide-react";
import { CommunitySignalButtons } from "@/components/CommunitySignalButtons";
import { useCommunityImpact } from "@/hooks/useCommunityImpact";

// ── Types ─────────────────────────────────────────────────────────────────────
export interface ZoneSignalPanelProps {
  /** Identifiant de la zone affichée dans le panneau. */
  zoneId: string;
  /** Mode compact transmis aux boutons (masque le compteur). */
  compact?: boolean;
}

export function ZoneSignalPanel({ zoneId, compact = false }: ZoneSignalPanelProps) {
  const { impact } = useCommunityImpact(zoneId);
  const boost = impact?.boost_pct ?? 0;

  return (
    <div
      data-testid="zone-signal-panel"
      className="mt-2 rounded-lg border border-primary/20 bg-muted/40 px-2 py-2"
    >
      <div className="mb-1.5 flex items-center justify-between">
        <p className="flex items-center gap-1 text-[10px] font-bold text-muted-foreground">
          <Users size={10} /> Signalement terrain
        </p>
        {/* Boost communautaire courant appliqué au score (±8%) */}
        {boost !== 0 && (
          <span
            data-testid="community-boost-badge"
            className={`text-[10px] font-bold tabular-nums ${boost > 0 ? "text-green-500" : "text-red-500"}`}
          >
            {boost > 0 ? "+" : ""}
            {boost}% score
          </span>
        )}
      </div>
      <CommunitySignalButtons zoneId={zoneId} compact={compact} />
    </div>
  );
}

export default ZoneSignalPanel;
