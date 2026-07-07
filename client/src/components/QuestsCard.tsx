/**
 * QuestsCard — Couche Wow Factor : quêtes hebdomadaires non-monétaires
 * ─────────────────────────────────────────────────────────────────────────────
 * Affiche les 3 quêtes de la semaine avec barre de progression Tailwind.
 * Récompense = badge uniquement (jamais d'argent). Placé dans ProfilePage.
 */
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ListChecks, CheckCircle2 } from "lucide-react";

interface Quest {
  quest_key: string;
  label_fr: string;
  badge_icon: string;
  target_value: number;
  current_value: number;
  progress_pct: number;
  completed: boolean;
  week_iso: string;
}

export function QuestsCard() {
  const { data, isLoading } = useQuery<{ quests: Quest[] }>({
    queryKey: ["/api/wow/quests"],
    queryFn: () => apiRequest("GET", "/api/wow/quests").then((r) => r.json()),
    staleTime: 60_000,
  });

  const quests = data?.quests ?? [];

  return (
    <Card className="border-teal-500/30 bg-teal-500/5" data-testid="card-quests">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <ListChecks size={14} className="text-teal-400" />
          Quêtes de la semaine
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Objectifs facultatifs — récompense en badge, jamais en argent.
        </p>
      </CardHeader>
      <CardContent className="space-y-3 px-4 pb-4">
        {isLoading && [0, 1, 2].map((i) => <Skeleton key={i} className="h-14 w-full rounded-lg" />)}
        {!isLoading && quests.length === 0 && (
          <p className="text-xs text-muted-foreground">Aucune quête disponible cette semaine.</p>
        )}
        {quests.map((q) => (
          <div key={q.quest_key} className="space-y-1.5" data-testid={`quest-${q.quest_key}`}>
            <div className="flex items-center justify-between text-xs">
              <span className="flex items-center gap-1.5">
                <span aria-hidden="true">{q.badge_icon}</span>
                {q.label_fr}
              </span>
              {q.completed ? (
                <span className="flex items-center gap-1 text-emerald-400 font-semibold">
                  <CheckCircle2 size={13} /> Terminée
                </span>
              ) : (
                <span className="text-muted-foreground tabular-nums">
                  {q.current_value}/{q.target_value}
                </span>
              )}
            </div>
            <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-500 ${
                  q.completed ? "bg-emerald-500" : "bg-teal-400"
                }`}
                style={{ width: `${q.progress_pct}%` }}
              />
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

export default QuestsCard;
