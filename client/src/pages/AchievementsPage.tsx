/**
 * AchievementsPage.tsx — Couche Wow Factor : succès / easter eggs métier
 * ─────────────────────────────────────────────────────────────────────────────
 * Liste les succès débloqués et à débloquer (silhouette grisée). Aucune
 * récompense monétaire — uniquement de la reconnaissance. Route /#/achievements.
 */
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Trophy, Lock } from "lucide-react";
import { StreakBadge } from "@/components/StreakBadge";
import { QuestsCard } from "@/components/QuestsCard";

interface Achievement {
  key: string;
  label_fr: string;
  description_fr: string;
  icon: string;
  unlocked: boolean;
  unlocked_at: string | null;
}

export default function AchievementsPage() {
  const { data, isLoading } = useQuery<{ achievements: Achievement[] }>({
    queryKey: ["/api/wow/achievements"],
    queryFn: () => apiRequest("GET", "/api/wow/achievements").then((r) => r.json()),
    staleTime: 60_000,
  });

  const achievements = data?.achievements ?? [];
  const unlockedCount = achievements.filter((a) => a.unlocked).length;

  return (
    <div className="p-4 max-w-2xl mx-auto space-y-4 pb-24" data-testid="page-achievements">
      <div>
        <h2 className="font-bold text-lg flex items-center gap-2">
          <Trophy size={18} className="text-amber-400" />
          Vos succès
        </h2>
        <p className="text-sm text-muted-foreground">
          {unlockedCount}/{achievements.length || "…"} succès débloqués — pour le plaisir, sans aucune récompense monétaire.
        </p>
      </div>

      <StreakBadge />
      <QuestsCard />

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        {isLoading &&
          [0, 1, 2, 3, 4, 5].map((i) => <Skeleton key={i} className="h-28 w-full rounded-xl" />)}
        {!isLoading &&
          achievements.map((a) => (
            <Card
              key={a.key}
              className={`text-center ${a.unlocked ? "border-amber-400/30 bg-amber-400/5" : "border-border/50 opacity-60"}`}
              data-testid={`achievement-${a.key}`}
            >
              <CardContent className="p-3 flex flex-col items-center gap-1.5">
                <div
                  className={`text-3xl ${a.unlocked ? "" : "grayscale opacity-40"}`}
                  aria-hidden="true"
                >
                  {a.unlocked ? a.icon : <Lock size={28} className="text-muted-foreground" />}
                </div>
                <p className="text-xs font-semibold leading-tight">{a.label_fr}</p>
                <p className="text-[10px] text-muted-foreground leading-snug">{a.description_fr}</p>
                {a.unlocked && a.unlocked_at && (
                  <p className="text-[9px] text-amber-400/80 mt-1">
                    Débloqué le {new Date(a.unlocked_at).toLocaleDateString("fr-FR")}
                  </p>
                )}
              </CardContent>
            </Card>
          ))}
      </div>
    </div>
  );
}
