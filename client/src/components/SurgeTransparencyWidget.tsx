import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Flame, Info, TrendingUp } from "lucide-react";

interface SurgeZone {
  zone_id: string;
  zone_name: string;
  surge_multiplier: number;
  surge_level: string;
  explanation: string;
  demand_score: number;
  supply_score: number;
  ratio: number;
  estimated_fare_boost_pct: number;
  valid_until: string;
}

function surgeBadgeColor(mult: number): string {
  if (mult >= 1.8) return "bg-red-700 text-white";
  if (mult >= 1.5) return "bg-red-500 text-white";
  return "bg-orange-500 text-white";
}

export default function SurgeTransparencyWidget() {
  const { data, isLoading } = useQuery<{ zones: SurgeZone[] }>({
    queryKey: ["/api/surge-transparency"],
    queryFn: () => apiRequest("GET", "/api/surge-transparency").then(r => r.json()),
    refetchInterval: 3_000,
    staleTime: 0,
    retry: 3,
    retryDelay: (n) => n * 1000,
  });

  if (isLoading) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Flame size={16} className="text-red-400" />Pourquoi ce surge ?
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 px-4 pb-4">
          {[0, 1].map(i => <Skeleton key={i} className="h-16 w-full rounded-lg" />)}
        </CardContent>
      </Card>
    );
  }

  const zones = data?.zones ?? [];
  if (zones.length === 0) {
    return (
      <Card className="border-border/50">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Flame size={16} className="text-muted-foreground" />
            Pourquoi ce surge ?
          </CardTitle>
        </CardHeader>
        <CardContent className="px-4 pb-4">
          <p className="text-[12px] text-muted-foreground flex items-center gap-1.5">
            <Info size={12} className="shrink-0" />
            Aucun surge actif en ce moment.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border-red-500/20">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <Flame size={16} className="text-red-400" />
          Pourquoi ce surge ?
          <Badge variant="outline" className="text-[10px] ml-auto">{zones.length} zones</Badge>
        </CardTitle>
        <p className="text-[11px] text-muted-foreground">Tarification dynamique transparente — facteurs explicatifs</p>
      </CardHeader>
      <CardContent className="space-y-2.5 px-3 pb-4">
        {zones.map(z => (
          <div key={z.zone_id} className="rounded-lg border border-border/50 bg-card p-3 space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-semibold truncate">{z.zone_name}</span>
              <Badge className={`text-xs font-bold ${surgeBadgeColor(z.surge_multiplier)}`}>
                ×{z.surge_multiplier.toFixed(1)}
              </Badge>
            </div>
            <p className="text-[11px] text-muted-foreground flex items-start gap-1.5">
              <Info size={12} className="mt-0.5 shrink-0" />
              {z.explanation}
            </p>
            <div className="flex items-center gap-3 text-[10px] text-muted-foreground pt-0.5">
              <span>Demande {z.demand_score}</span>
              <span>Offre {z.supply_score}</span>
              <span>D/O {z.ratio.toFixed(1)}×</span>
              <span className="text-emerald-400 flex items-center gap-0.5 ml-auto">
                <TrendingUp size={11} />+{z.estimated_fare_boost_pct}%
              </span>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
