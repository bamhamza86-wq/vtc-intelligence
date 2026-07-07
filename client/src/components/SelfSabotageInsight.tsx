/**
 * SelfSabotageInsight — Couche Wow Factor : détection auto-sabotage économique
 * ─────────────────────────────────────────────────────────────────────────────
 * Consomme GET /api/wow/self-sabotage. Confrontation bienveillante et factuelle,
 * jamais punitive — l'information reste au service de la décision du chauffeur.
 * Placé dans MLInsightsPage.
 */
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { HeartHandshake } from "lucide-react";

interface SelfSabotage {
  detected: boolean;
  message_fr: string | null;
  estimated_monthly_loss_eur: number;
}

export function SelfSabotageInsight() {
  const { data, isLoading } = useQuery<SelfSabotage>({
    queryKey: ["/api/wow/self-sabotage"],
    queryFn: () => apiRequest("GET", "/api/wow/self-sabotage").then((r) => r.json()),
    staleTime: 5 * 60_000,
  });

  if (isLoading) {
    return <Skeleton className="h-24 w-full rounded-lg" data-testid="skeleton-self-sabotage" />;
  }

  if (!data?.detected) return null;

  return (
    <Card className="border-rose-500/20" data-testid="card-self-sabotage">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <HeartHandshake size={15} className="text-rose-400" />
          Un pattern à connaître
        </CardTitle>
      </CardHeader>
      <CardContent className="px-4 pb-4 space-y-2">
        <p className="text-xs leading-snug text-muted-foreground">{data.message_fr}</p>
        <p className="text-[11px] text-rose-300/90">
          Information factuelle, pas un reproche — la décision de continuer ou de vous arrêter vous appartient toujours.
        </p>
      </CardContent>
    </Card>
  );
}

export default SelfSabotageInsight;
