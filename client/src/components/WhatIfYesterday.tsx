/**
 * WhatIfYesterday — Couche Wow Factor : simulation rétrospective
 * ─────────────────────────────────────────────────────────────────────────────
 * "Et si vous aviez suivi l'IA hier ?" — compare le net réel au net projeté
 * si toutes les recommandations avaient été suivies. Placé dans EconomicsDashboard.
 */
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Sparkles, TrendingUp } from "lucide-react";

interface WhatIf {
  real_net: number;
  ai_projected_net: number;
  delta: number;
  top_missed_reco: { verb: string; zone_name: string | null; expected_gain_euros: number | null } | null;
  has_data: boolean;
}

export function WhatIfYesterday() {
  const { data, isLoading } = useQuery<WhatIf>({
    queryKey: ["/api/wow/what-if-yesterday"],
    queryFn: () => apiRequest("GET", "/api/wow/what-if-yesterday").then((r) => r.json()),
    staleTime: 5 * 60_000,
  });

  return (
    <Card className="border-violet-500/20" data-testid="card-what-if-yesterday">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <Sparkles size={15} className="text-violet-400" />
          Et si vous aviez suivi l'IA hier ?
        </CardTitle>
      </CardHeader>
      <CardContent className="px-4 pb-4 space-y-3">
        {isLoading && <Skeleton className="h-20 w-full rounded-lg" />}
        {!isLoading && !data?.has_data && (
          <p className="text-xs text-muted-foreground">Pas assez de données hier pour comparer.</p>
        )}
        {!isLoading && data?.has_data && (
          <>
            <div className="grid grid-cols-2 gap-3 text-center">
              <div>
                <p className="text-lg font-bold">{data.real_net.toFixed(0)}€</p>
                <p className="text-[10px] text-muted-foreground">Net réel</p>
              </div>
              <div>
                <p className="text-lg font-bold text-violet-400">{data.ai_projected_net.toFixed(0)}€</p>
                <p className="text-[10px] text-muted-foreground">Net projeté avec IA</p>
              </div>
            </div>
            {data.delta > 0 && (
              <div className="flex items-center gap-1.5 text-emerald-400 text-sm font-semibold justify-center">
                <TrendingUp size={14} />
                +{data.delta.toFixed(0)}€ potentiel non saisi
              </div>
            )}
            {data.top_missed_reco && (
              <p className="text-[11px] text-muted-foreground text-center">
                Recommandation la plus manquée : {data.top_missed_reco.verb} {data.top_missed_reco.zone_name ?? ""}
                {data.top_missed_reco.expected_gain_euros ? ` (+${data.top_missed_reco.expected_gain_euros}€ estimé)` : ""}
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

export default WhatIfYesterday;
