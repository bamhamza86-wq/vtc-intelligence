/**
 * MLInsightsAdvanced.tsx — Panneaux RL (bandit Thompson) + Federated Learning-lite
 * ─────────────────────────────────────────────────────────────────────────────
 * Ajout additif à la page /ml-insights existante (ne modifie aucun panneau
 * existant). Trois cartes :
 *   1. Politique bandit Thompson — barre exploration/exploitation + bras (zones)
 *   2. Modèle personnel vs modèle communautaire (MAE)
 *   3. Dernière round de Federated Learning + toggle opt-in anonyme
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import {
  Dices, Users, ShieldCheck, TrendingUp, TrendingDown,
  Target, Sparkles, Info,
} from "lucide-react";

interface BanditArmOut {
  arm_key: string;
  zone_name: string;
  count: number;
  mean_reward: number;
  std_reward: number;
  alpha: number;
  beta: number;
  thompson_estimate: number;
  is_exploring: boolean;
}

interface RlPolicyState {
  total_pulls: number;
  arm_count: number;
  exploration_ratio: number;
  exploitation_ratio: number;
  arms: BanditArmOut[];
  thompson_recommended_arm: { arm_key: string; sampled_score: number } | null;
}

interface PersonalVsGlobal {
  personal_model: { mae: number; sample_count: number };
  global_model: { mae: number; sample_count: number; version: number };
  better_model: "personal" | "global" | "insufficient_data";
  recommendation: string;
}

interface LastFlRound {
  has_round: boolean;
  round_id?: number;
  started_at?: string;
  ended_at?: string;
  contributor_count?: number;
  model_version?: number | null;
  dp_noise_scale?: number;
}

interface FlParticipationState {
  opted_in: boolean;
  last_sync_ts: string | null;
  personal_mae: number | null;
  global_mae: number | null;
}

function pct(x: number): number {
  return Math.round(x * 100);
}

function formatDate(iso?: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  } catch {
    return iso;
  }
}

export function MLInsightsAdvanced() {
  const qc = useQueryClient();
  const [contribuMsg, setContribuMsg] = useState<string | null>(null);

  const { data: rlState, isLoading: loadingRl } = useQuery<RlPolicyState>({
    queryKey: ["/api/ml/rl-policy-state"],
    queryFn: () => apiRequest("GET", "/api/ml/rl-policy-state").then((r) => r.json()),
    staleTime: 30_000,
  });

  const { data: pvg, isLoading: loadingPvg } = useQuery<PersonalVsGlobal>({
    queryKey: ["/api/ml/personal-vs-global"],
    queryFn: () => apiRequest("GET", "/api/ml/personal-vs-global").then((r) => r.json()),
    staleTime: 60_000,
  });

  const { data: lastRound, isLoading: loadingRound } = useQuery<LastFlRound>({
    queryKey: ["/api/ml/last-fl-round"],
    queryFn: () => apiRequest("GET", "/api/ml/last-fl-round").then((r) => r.json()),
    staleTime: 60_000,
  });

  const { data: participation, isLoading: loadingPart } = useQuery<FlParticipationState>({
    queryKey: ["/api/ml/fl-participation-state"],
    queryFn: () => apiRequest("GET", "/api/ml/fl-participation-state").then((r) => r.json()),
    staleTime: 30_000,
  });

  const toggleOptIn = useMutation({
    mutationFn: (opted_in: boolean) =>
      apiRequest("POST", "/api/ml/rejoin-global", { opted_in }).then((r) => r.json()),
    onSuccess: (data) => {
      setContribuMsg(data?.message ?? null);
      qc.invalidateQueries({ queryKey: ["/api/ml/fl-participation-state"] });
    },
  });

  const sendGradient = useMutation({
    mutationFn: () => apiRequest("POST", "/api/ml/local-gradient", {}).then((r) => r.json()),
    onSuccess: (data) => {
      if (data?.error) {
        setContribuMsg(
          data.error === "insufficient_local_data"
            ? "Pas assez de courses enregistrées pour contribuer (minimum 5)."
            : data.message ?? "Erreur lors de l'envoi.",
        );
      } else {
        setContribuMsg("Gradients anonymisés envoyés au pool commun. Merci pour votre contribution !");
        qc.invalidateQueries({ queryKey: ["/api/ml/last-fl-round"] });
      }
    },
  });

  const arms = rlState?.arms ?? [];
  const explorationPct = pct(rlState?.exploration_ratio ?? 0);
  const exploitationPct = 100 - explorationPct;

  return (
    <div className="space-y-5">
      {/* ─── Carte 1 : Politique bandit Thompson (RL sur feedback chauffeur) ─── */}
      <section>
        <h2 className="text-sm font-semibold mb-2 flex items-center gap-1.5">
          <Dices size={15} className="text-fuchsia-400" />
          Politique d'apprentissage par renforcement
        </h2>
        {loadingRl ? (
          <Skeleton className="h-32 w-full rounded-lg" />
        ) : arms.length === 0 ? (
          <Card className="border-fuchsia-500/20" data-testid="rl-empty-card">
            <CardContent className="p-4">
              <p className="text-xs text-muted-foreground">
                Aucun feedback explicite encore enregistré. Acceptez ou refusez des suggestions de zone
                pour entraîner votre politique personnelle (bandit Thompson sampling).
              </p>
            </CardContent>
          </Card>
        ) : (
          <Card className="border-fuchsia-500/20" data-testid="rl-policy-card">
            <CardContent className="p-4 space-y-3">
              <div>
                <div className="flex items-center justify-between text-[11px] text-muted-foreground mb-1">
                  <span>Exploration {explorationPct}%</span>
                  <span>Exploitation {exploitationPct}%</span>
                </div>
                <div className="h-2.5 w-full rounded-full bg-muted overflow-hidden flex" data-testid="rl-exploration-bar">
                  <div className="h-full bg-purple-500" style={{ width: `${explorationPct}%` }} />
                  <div className="h-full bg-cyan-500" style={{ width: `${exploitationPct}%` }} />
                </div>
                <p className="text-[11px] text-muted-foreground mt-1">
                  {rlState?.total_pulls ?? 0} feedback(s) reçus sur {arms.length} zone(s) testée(s).
                </p>
              </div>

              <div className="space-y-1.5" data-testid="rl-arms-list">
                {arms.slice(0, 6).map((a) => (
                  <div key={a.arm_key} className="flex items-center justify-between gap-2 text-xs">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span className="truncate font-medium">{a.zone_name}</span>
                      {a.is_exploring && (
                        <Badge variant="outline" className="text-[9px] px-1 py-0 shrink-0">explo</Badge>
                      )}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="text-muted-foreground">{a.count}×</span>
                      <span className={a.mean_reward >= 0.5 ? "text-emerald-400" : "text-amber-400"}>
                        {pct(a.mean_reward)}%
                      </span>
                    </div>
                  </div>
                ))}
              </div>

              {rlState?.thompson_recommended_arm && (
                <p className="text-[11px] text-fuchsia-400 border-t border-border pt-2 flex items-center gap-1">
                  <Target size={11} />
                  Recommandation actuelle : <b>{rlState.thompson_recommended_arm.arm_key}</b>
                </p>
              )}
            </CardContent>
          </Card>
        )}
      </section>

      {/* ─── Carte 2 : Modèle personnel vs modèle communautaire (MAE) ─── */}
      <section>
        <h2 className="text-sm font-semibold mb-2 flex items-center gap-1.5">
          <Users size={15} className="text-cyan-400" />
          Modèle personnel vs communautaire
        </h2>
        {loadingPvg ? (
          <Skeleton className="h-24 w-full rounded-lg" />
        ) : pvg ? (
          <Card className="border-cyan-500/20" data-testid="pvg-card">
            <CardContent className="p-4 space-y-2.5">
              <div className="flex items-center gap-4">
                <div className="flex-1 text-center">
                  <p className="text-[11px] text-muted-foreground">Personnel</p>
                  <p className="text-lg font-bold">{pvg.personal_model.mae.toFixed(2)}€</p>
                  <p className="text-[10px] text-muted-foreground">{pvg.personal_model.sample_count} courses</p>
                </div>
                <div className="text-muted-foreground text-xs">vs</div>
                <div className="flex-1 text-center">
                  <p className="text-[11px] text-muted-foreground">Communautaire v{pvg.global_model.version}</p>
                  <p className="text-lg font-bold">{pvg.global_model.mae.toFixed(2)}€</p>
                  <p className="text-[10px] text-muted-foreground">{pvg.global_model.sample_count} courses</p>
                </div>
              </div>
              <div className="flex items-center gap-1.5 border-t border-border pt-2">
                {pvg.better_model === "personal" ? (
                  <TrendingUp size={13} className="text-emerald-400 shrink-0" />
                ) : pvg.better_model === "global" ? (
                  <TrendingDown size={13} className="text-amber-400 shrink-0" />
                ) : (
                  <Info size={13} className="text-muted-foreground shrink-0" />
                )}
                <p className="text-[11px] text-muted-foreground">{pvg.recommendation}</p>
              </div>
              <p className="text-[10px] text-muted-foreground italic">
                MAE = erreur moyenne absolue entre gain prédit et gain réel (plus bas = mieux).
              </p>
            </CardContent>
          </Card>
        ) : null}
      </section>

      {/* ─── Carte 3 : Federated Learning-lite — dernière round + opt-in ─── */}
      <section>
        <h2 className="text-sm font-semibold mb-2 flex items-center gap-1.5">
          <ShieldCheck size={15} className="text-emerald-400" />
          Apprentissage fédéré (anonyme)
        </h2>
        <Card className="border-emerald-500/20" data-testid="fl-card">
          <CardContent className="p-4 space-y-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-xs font-medium">Contribuer à améliorer le modèle communautaire (anonyme)</p>
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  Seuls des gradients mathématiques bruités sont envoyés — jamais vos courses, jamais votre identité.
                </p>
              </div>
              {loadingPart ? (
                <Skeleton className="h-6 w-11 rounded-full shrink-0" />
              ) : (
                <Switch
                  checked={!!participation?.opted_in}
                  onCheckedChange={(checked) => toggleOptIn.mutate(checked)}
                  data-testid="switch-fl-optin"
                  aria-label="Contribuer à améliorer le modèle communautaire (anonyme)"
                />
              )}
            </div>

            {participation?.opted_in && (
              <Button
                size="sm"
                variant="outline"
                className="w-full h-9 text-xs"
                onClick={() => sendGradient.mutate()}
                disabled={sendGradient.isPending}
                data-testid="btn-send-gradient"
              >
                <Sparkles size={13} className="mr-1.5" />
                {sendGradient.isPending ? "Envoi en cours…" : "Contribuer maintenant (envoyer mes gradients anonymisés)"}
              </Button>
            )}

            {contribuMsg && (
              <p className="text-[11px] text-emerald-400 border-t border-border pt-2">{contribuMsg}</p>
            )}

            <div className="border-t border-border pt-2.5 space-y-1">
              <p className="text-[11px] font-medium text-muted-foreground">Dernière agrégation communautaire</p>
              {loadingRound ? (
                <Skeleton className="h-10 w-full rounded" />
              ) : lastRound?.has_round ? (
                <div className="flex items-center justify-between text-[11px]">
                  <span className="text-muted-foreground">
                    {lastRound.contributor_count} contributeur(s) anonyme(s) · modèle v{lastRound.model_version}
                  </span>
                  <span className="text-muted-foreground">{formatDate(lastRound.ended_at)}</span>
                </div>
              ) : (
                <p className="text-[11px] text-muted-foreground">Aucune agrégation communautaire pour le moment.</p>
              )}
              <p className="text-[10px] text-muted-foreground italic">
                Bruit de confidentialité différentielle (Laplace, échelle {lastRound?.dp_noise_scale ?? 1.0}) appliqué à chaque gradient avant agrégation.
              </p>
            </div>
          </CardContent>
        </Card>
      </section>
    </div>
  );
}

export default MLInsightsAdvanced;
