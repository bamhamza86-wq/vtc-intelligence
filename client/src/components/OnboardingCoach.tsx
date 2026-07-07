/**
 * OnboardingCoach — Parcours d'onboarding progressif (rapport.md §11.3)
 * ─────────────────────────────────────────────────────────────────────────────
 * "Découverte des fonctionnalités étalée" plutôt que de noyer le chauffeur
 * avec toutes les features ML/communautaires dès J1. Overlay step-by-step
 * (5 étapes visibles), skippable et dismissable à tout moment, avec tooltip
 * pointant sur les zones clés de l'UI : Focus, Éco, carte, quêtes, notifications.
 *
 * Persisté via POST /api/onboarding/step-done — l'overlay ne réapparaît plus
 * une fois les étapes marquées terminées (ou skip global).
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { useEffect, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useLocation } from "wouter";
import { X, Target, BarChart2, Map, Trophy, Bell, ArrowRight, SkipForward, type LucideIcon } from "lucide-react";

interface OnboardingProgressResponse {
  steps: string[];
  completed: Record<string, string>;
  next_step: string | null;
  is_complete: boolean;
}

// 5 étapes visibles à l'utilisateur (sous-ensemble parlant des 8 steps backend —
// "welcome" et "first_streak" servent de bornes silencieuses de progression).
const COACH_STEPS: Array<{
  key: string;
  title: string;
  body: string;
  icon: LucideIcon;
  targetPath?: string;
}> = [
  {
    key: "profile_setup",
    title: "Bienvenue à bord",
    body: "VTC Intelligence vous aide à décider où aller, quelle course accepter, et combien vous gagnez vraiment. Découvrons l'essentiel en 5 étapes rapides — skippables à tout moment.",
    icon: Trophy,
  },
  {
    key: "try_focus",
    title: "Le bouton Focus",
    body: "Focus vous donne LA meilleure recommandation du moment : où aller, combien de temps attendre, et pourquoi. C'est votre copilote en un tap.",
    icon: Target,
    targetPath: "/focus",
  },
  {
    key: "try_bilan",
    title: "Le tableau Éco",
    body: "Suivez votre rentabilité réelle : gain net par heure, coût réel au kilomètre, bilan de fin de shift. Pas seulement le chiffre d'affaires brut.",
    icon: BarChart2,
    targetPath: "/economics",
  },
  {
    key: "discover_map",
    title: "La carte de rentabilité",
    body: "La carte affiche les zones les plus prometteuses en temps réel, les événements à proximité, et bientôt les bornes de recharge ⚡.",
    icon: Map,
    targetPath: "/",
  },
  {
    key: "community_signal",
    title: "Quêtes & notifications",
    body: "Des quêtes hebdomadaires non-monétaires et des notifications utiles (jamais culpabilisantes) vous aident à progresser à votre rythme.",
    icon: Bell,
  },
];

const DISMISS_KEY = "vtc.onboarding_dismissed";

export function OnboardingCoach() {
  const [, navigate] = useLocation();
  const [dismissedLocal, setDismissedLocal] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(DISMISS_KEY) === "1";
  });
  const [stepIndex, setStepIndex] = useState(0);

  const { data: progress } = useQuery<OnboardingProgressResponse>({
    queryKey: ["/api/onboarding/progress"],
    queryFn: () => apiRequest("GET", "/api/onboarding/progress").then((r) => r.json()),
    staleTime: 30_000,
  });

  const markDone = useMutation({
    mutationFn: (step_key: string) =>
      apiRequest("POST", "/api/onboarding/step-done", { step_key }).then((r) => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/onboarding/progress"] });
    },
  });

  // Positionne l'étape courante sur la première étape du coach non complétée.
  useEffect(() => {
    if (!progress) return;
    const idx = COACH_STEPS.findIndex((s) => !progress.completed[s.key]);
    setStepIndex(idx === -1 ? COACH_STEPS.length : idx);
  }, [progress]);

  if (dismissedLocal) return null;
  if (!progress) return null;
  if (progress.is_complete) return null;
  if (stepIndex >= COACH_STEPS.length) return null;

  const step = COACH_STEPS[stepIndex];
  const Icon = step.icon;
  const isLast = stepIndex === COACH_STEPS.length - 1;

  function dismissAll() {
    try {
      window.localStorage.setItem(DISMISS_KEY, "1");
    } catch { /* localStorage indisponible — ignore */ }
    setDismissedLocal(true);
    // Marque toutes les étapes restantes comme vues pour ne plus réafficher l'overlay.
    COACH_STEPS.forEach((s) => markDone.mutate(s.key));
    markDone.mutate("welcome");
    markDone.mutate("first_streak");
  }

  function nextStep() {
    markDone.mutate(step.key);
    if (step.targetPath) {
      navigate(step.targetPath);
    }
    if (isLast) {
      markDone.mutate("welcome");
      markDone.mutate("first_streak");
    }
    setStepIndex((i) => i + 1);
  }

  return (
    <div
      className="fixed inset-0 z-[80] flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm p-3 sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Tutoriel de découverte"
      data-testid="onboarding-coach-overlay"
    >
      <div className="w-full sm:max-w-sm bg-card border border-border rounded-2xl shadow-2xl overflow-hidden">
        {/* En-tête avec progression */}
        <div className="flex items-center justify-between px-4 pt-4">
          <div className="flex gap-1.5">
            {COACH_STEPS.map((s, i) => (
              <span
                key={s.key}
                className={`h-1.5 rounded-full transition-all ${
                  i === stepIndex ? "w-6 bg-primary" : i < stepIndex ? "w-1.5 bg-primary/50" : "w-1.5 bg-muted"
                }`}
              />
            ))}
          </div>
          <button
            type="button"
            onClick={dismissAll}
            className="flex items-center justify-center rounded-full hover:bg-accent transition-colors"
            style={{ minWidth: 44, minHeight: 44 }}
            aria-label="Fermer le tutoriel"
            data-testid="button-onboarding-dismiss"
          >
            <X size={18} />
          </button>
        </div>

        {/* Contenu de l'étape */}
        <div className="px-5 pb-5 pt-2">
          <div className="w-12 h-12 rounded-xl bg-primary/10 text-primary flex items-center justify-center mb-3">
            <Icon size={24} />
          </div>
          <h2 className="text-lg font-bold mb-1.5">{step.title}</h2>
          <p className="text-sm text-muted-foreground leading-relaxed mb-5">{step.body}</p>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={dismissAll}
              className="flex items-center gap-1.5 px-3 py-2.5 rounded-xl text-sm text-muted-foreground hover:bg-accent transition-colors"
              style={{ minHeight: 44 }}
              data-testid="button-onboarding-skip"
            >
              <SkipForward size={15} />
              Passer
            </button>
            <button
              type="button"
              onClick={nextStep}
              className="flex-1 flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-xl bg-primary text-primary-foreground font-semibold text-sm hover:opacity-90 transition-opacity"
              style={{ minHeight: 44 }}
              data-testid="button-onboarding-next"
            >
              {isLast ? "Terminer" : "Suivant"}
              <ArrowRight size={15} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default OnboardingCoach;
