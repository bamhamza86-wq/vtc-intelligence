/**
 * SantePage.tsx — Couche SANTÉ chauffeur (Itération Santé & Finance)
 * ─────────────────────────────────────────────────────────────────────────────
 * Rapport §6 (Santé physique/mentale du chauffeur), §11, §19 + gaps benchmark
 * (Stride/Gridwise : marketplace assurance santé/véhicule pour indépendants) :
 *   - Journal santé du jour (formulaire quick)
 *   - Exercice recommandé (carte + timer)
 *   - Score ergonomie véhicule (questionnaire → score)
 *   - Comparateur mutuelles TNS
 *
 * Honnêteté : aucun diagnostic médical, uniquement suivi personnel + conseils
 * génériques de bon sens et comparatifs indicatifs (tarifs à vérifier par devis).
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Heart,
  Activity,
  Timer,
  Moon,
  Droplets,
  Coffee,
  RefreshCw,
  CheckCircle2,
  ShieldCheck,
} from "lucide-react";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────
interface HealthToday {
  entries: any[];
  sitting_minutes: number;
  breaks_count: number;
  stretch_done: boolean;
  hydration_glasses: number;
  sleep_hours: number;
  avg_pain_score: number;
}

interface Exercise {
  id: string;
  nom: string;
  categorie: string;
  duree_secondes: number;
  instructions: string[];
  benefice_fr: string;
}

interface RecommendedExercise {
  exercise: Exercise;
  raison_fr: string;
}

interface ErgoQuestion {
  id: string;
  question: string;
  options: { label: string; points: number }[];
}

interface ErgoResult {
  score: number;
  niveau: string;
  recommandations: string[];
}

interface Mutuelle {
  id: number;
  nom: string;
  prix_min: number;
  prix_max: number;
  indemnites_journalieres: string;
  garanties: string[];
  delai_carence_jours: number;
  note_fr: string;
  url: string;
}

const NIVEAU_COLOR: Record<string, string> = {
  critique: "text-red-500",
  "à améliorer": "text-amber-500",
  correct: "text-sky-500",
  excellent: "text-emerald-500",
};

// ─────────────────────────────────────────────────────────────────────────────
// Journal santé du jour
// ─────────────────────────────────────────────────────────────────────────────
function HealthJournalCard() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<HealthToday>({
    queryKey: ["/api/health/log/today"],
    queryFn: async () => (await apiRequest("GET", "/api/health/log/today")).json(),
  });

  const [painScore, setPainScore] = useState(2);
  const [breaksCount, setBreaksCount] = useState(0);
  const [sleepHours, setSleepHours] = useState(7);
  const [hydration, setHydration] = useState(2);
  const [stretchDone, setStretchDone] = useState(false);
  const [saving, setSaving] = useState(false);
  const [tips, setTips] = useState<string[]>([]);

  async function handleSubmit() {
    setSaving(true);
    try {
      const res = await apiRequest("POST", "/api/health/log", {
        pain_score: painScore,
        breaks_count: breaksCount,
        sleep_hours: sleepHours,
        hydration_glasses: hydration,
        stretch_done: stretchDone,
        sitting_minutes: data?.sitting_minutes ?? 0,
      });
      const json = await res.json();
      setTips(json.tips_fr || []);
      qc.invalidateQueries({ queryKey: ["/api/health/log/today"] });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card data-testid="card-health-journal">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Heart size={18} className="text-rose-500" />
          Journal santé du jour
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : (
          <div className="grid grid-cols-3 gap-2 text-center text-xs text-muted-foreground">
            <div className="rounded-lg bg-muted p-2">
              <div className="text-lg font-semibold text-foreground">{data?.breaks_count ?? 0}</div>
              Pauses aujourd'hui
            </div>
            <div className="rounded-lg bg-muted p-2">
              <div className="text-lg font-semibold text-foreground">{data?.avg_pain_score ?? 0}/10</div>
              Douleur moyenne
            </div>
            <div className="rounded-lg bg-muted p-2">
              <div className="text-lg font-semibold text-foreground">{data?.hydration_glasses ?? 0}</div>
              Verres d'eau
            </div>
          </div>
        )}

        <div className="space-y-3">
          <div>
            <label className="mb-1 flex items-center justify-between text-sm font-medium">
              <span className="flex items-center gap-1.5"><Activity size={14} /> Douleur ressentie</span>
              <span className="text-muted-foreground">{painScore}/10</span>
            </label>
            <input
              type="range"
              min={0}
              max={10}
              value={painScore}
              onChange={(e) => setPainScore(Number(e.target.value))}
              className="w-full"
              style={{ minHeight: 44 }}
              data-testid="input-pain-score"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 flex items-center gap-1.5 text-sm font-medium">
                <Coffee size={14} /> Pauses prises
              </label>
              <input
                type="number"
                min={0}
                value={breaksCount}
                onChange={(e) => setBreaksCount(Number(e.target.value))}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                style={{ minHeight: 44 }}
                data-testid="input-breaks-count"
              />
            </div>
            <div>
              <label className="mb-1 flex items-center gap-1.5 text-sm font-medium">
                <Moon size={14} /> Sommeil (h)
              </label>
              <input
                type="number"
                min={0}
                max={14}
                step={0.5}
                value={sleepHours}
                onChange={(e) => setSleepHours(Number(e.target.value))}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                style={{ minHeight: 44 }}
                data-testid="input-sleep-hours"
              />
            </div>
          </div>

          <div>
            <label className="mb-1 flex items-center gap-1.5 text-sm font-medium">
              <Droplets size={14} /> Verres d'eau bus
            </label>
            <input
              type="number"
              min={0}
              value={hydration}
              onChange={(e) => setHydration(Number(e.target.value))}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              style={{ minHeight: 44 }}
              data-testid="input-hydration"
            />
          </div>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={stretchDone}
              onChange={(e) => setStretchDone(e.target.checked)}
              style={{ width: 20, height: 20 }}
              data-testid="checkbox-stretch-done"
            />
            J'ai fait un exercice d'étirement aujourd'hui
          </label>

          <Button onClick={handleSubmit} disabled={saving} className="w-full" style={{ minHeight: 44 }} data-testid="button-save-health-log">
            {saving ? "Enregistrement..." : "Enregistrer mon journal"}
          </Button>

          {tips.length > 0 && (
            <div className="space-y-1 rounded-lg bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-400">
              {tips.map((t, i) => (
                <div key={i}>• {t}</div>
              ))}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Exercice recommandé + timer
// ─────────────────────────────────────────────────────────────────────────────
function ExerciseTimer({ exercise }: { exercise: Exercise }) {
  const [running, setRunning] = useState(false);
  const [remaining, setRemaining] = useState(exercise.duree_secondes);
  const intervalRef = useRef<number | null>(null);

  useEffect(() => {
    setRemaining(exercise.duree_secondes);
    setRunning(false);
    if (intervalRef.current) window.clearInterval(intervalRef.current);
  }, [exercise.id, exercise.duree_secondes]);

  useEffect(() => {
    if (running) {
      intervalRef.current = window.setInterval(() => {
        setRemaining((r) => {
          if (r <= 1) {
            window.clearInterval(intervalRef.current!);
            setRunning(false);
            return 0;
          }
          return r - 1;
        });
      }, 1000);
    }
    return () => {
      if (intervalRef.current) window.clearInterval(intervalRef.current);
    };
  }, [running]);

  const pct = Math.round(((exercise.duree_secondes - remaining) / exercise.duree_secondes) * 100);

  return (
    <div className="flex items-center gap-3">
      <div
        className="relative flex h-16 w-16 shrink-0 items-center justify-center rounded-full"
        style={{
          background: `conic-gradient(#38bdf8 ${pct * 3.6}deg, hsl(var(--muted)) 0deg)`,
          transition: "background 1s linear",
        }}
      >
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-background text-sm font-semibold">
          {remaining}s
        </div>
      </div>
      <Button
        variant={running ? "secondary" : "default"}
        onClick={() => setRunning((r) => !r)}
        disabled={remaining === 0}
        style={{ minHeight: 44 }}
        data-testid="button-exercise-timer"
      >
        {remaining === 0 ? "Terminé !" : running ? "Pause" : "Démarrer"}
      </Button>
      {remaining === 0 && (
        <Button variant="outline" onClick={() => setRemaining(exercise.duree_secondes)} style={{ minHeight: 44 }}>
          Recommencer
        </Button>
      )}
    </div>
  );
}

function RecommendedExerciseCard() {
  const { data, isLoading, refetch } = useQuery<RecommendedExercise>({
    queryKey: ["/api/health/exercises/recommended"],
    queryFn: async () => (await apiRequest("GET", "/api/health/exercises/recommended")).json(),
  });
  const { data: allExercises } = useQuery<{ exercises: Exercise[] }>({
    queryKey: ["/api/health/exercises"],
    queryFn: async () => (await apiRequest("GET", "/api/health/exercises")).json(),
  });
  const [selected, setSelected] = useState<Exercise | null>(null);

  const exercise = selected || data?.exercise;

  return (
    <Card data-testid="card-recommended-exercise">
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2 text-base">
          <Timer size={18} className="text-sky-500" />
          Exercice recommandé
        </CardTitle>
        <button onClick={() => refetch()} className="rounded-full p-2 text-muted-foreground hover:bg-accent" style={{ minHeight: 44, minWidth: 44 }} data-testid="button-refresh-exercise" aria-label="Rafraîchir">
          <RefreshCw size={16} />
        </button>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading || !exercise ? (
          <Skeleton className="h-32 w-full" />
        ) : (
          <>
            <div className="rounded-lg border border-border p-3">
              <div className="mb-1 flex items-center justify-between">
                <h3 className="font-semibold">{exercise.nom}</h3>
                <Badge variant="outline">{exercise.categorie}</Badge>
              </div>
              {!selected && data && <p className="mb-2 text-xs text-muted-foreground">{data.raison_fr}</p>}
              <ol className="mb-2 list-decimal space-y-1 pl-4 text-sm text-muted-foreground">
                {exercise.instructions.map((ins, i) => (
                  <li key={i}>{ins}</li>
                ))}
              </ol>
              <p className="mb-3 text-xs italic text-muted-foreground">{exercise.benefice_fr}</p>
              <ExerciseTimer exercise={exercise} />
            </div>

            <details className="text-sm">
              <summary className="cursor-pointer text-muted-foreground" data-testid="summary-all-exercises">
                Voir les {allExercises?.exercises?.length ?? 12} exercices de la bibliothèque
              </summary>
              <div className="mt-2 grid grid-cols-2 gap-2">
                {(allExercises?.exercises || []).map((ex) => (
                  <button
                    key={ex.id}
                    onClick={() => setSelected(ex)}
                    className="rounded-md border border-border p-2 text-left text-xs hover:bg-accent"
                    style={{ minHeight: 44 }}
                    data-testid={`button-select-exercise-${ex.id}`}
                  >
                    <div className="font-medium">{ex.nom}</div>
                    <div className="text-muted-foreground">{ex.categorie} · {ex.duree_secondes}s</div>
                  </button>
                ))}
              </div>
            </details>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Score ergonomie véhicule
// ─────────────────────────────────────────────────────────────────────────────
function ErgoScoreCard() {
  const { data, isLoading } = useQuery<{ questions: ErgoQuestion[]; history: any[] }>({
    queryKey: ["/api/health/vehicle-ergo-score"],
    queryFn: async () => (await apiRequest("GET", "/api/health/vehicle-ergo-score")).json(),
  });
  const [answers, setAnswers] = useState<Record<string, number>>({});
  const [result, setResult] = useState<ErgoResult | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const questions = data?.questions || [];
  const answeredCount = Object.keys(answers).length;

  async function handleSubmit() {
    setSubmitting(true);
    try {
      const res = await apiRequest("POST", "/api/health/vehicle-ergo-score", { answers });
      setResult(await res.json());
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card data-testid="card-ergo-score">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldCheck size={18} className="text-emerald-500" />
          Score ergonomie véhicule
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading ? (
          <Skeleton className="h-40 w-full" />
        ) : result ? (
          <div className="space-y-3">
            <div className="text-center">
              <div className={`text-4xl font-bold ${NIVEAU_COLOR[result.niveau] || ""}`}>{result.score}/100</div>
              <div className="text-sm text-muted-foreground capitalize">{result.niveau}</div>
            </div>
            <div className="space-y-1.5">
              <div className="text-sm font-medium">Recommandations d'achat :</div>
              {result.recommandations.map((r, i) => (
                <div key={i} className="flex gap-2 text-sm text-muted-foreground">
                  <CheckCircle2 size={14} className="mt-0.5 shrink-0 text-emerald-500" />
                  {r}
                </div>
              ))}
            </div>
            <Button variant="outline" className="w-full" style={{ minHeight: 44 }} onClick={() => { setResult(null); setAnswers({}); }} data-testid="button-ergo-retry">
              Refaire le questionnaire
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="text-xs text-muted-foreground">{answeredCount}/{questions.length} questions répondues</div>
            {questions.map((q) => (
              <div key={q.id}>
                <div className="mb-1.5 text-sm font-medium">{q.question}</div>
                <div className="flex flex-col gap-1.5">
                  {q.options.map((opt) => (
                    <button
                      key={opt.label}
                      onClick={() => setAnswers((a) => ({ ...a, [q.id]: opt.points }))}
                      className={`rounded-md border px-3 py-2 text-left text-sm transition-colors ${
                        answers[q.id] === opt.points
                          ? "border-primary bg-primary/10 font-medium"
                          : "border-border hover:bg-accent"
                      }`}
                      style={{ minHeight: 44 }}
                      data-testid={`button-ergo-option-${q.id}`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
            ))}
            <Button
              onClick={handleSubmit}
              disabled={answeredCount < questions.length || submitting}
              className="w-full"
              style={{ minHeight: 44 }}
              data-testid="button-ergo-submit"
            >
              {submitting ? "Calcul..." : "Calculer mon score"}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Comparateur mutuelles TNS
// ─────────────────────────────────────────────────────────────────────────────
function MutuellesTable() {
  const { data, isLoading } = useQuery<{ mutuelles: Mutuelle[] }>({
    queryKey: ["/api/health/mutuelles-tns"],
    queryFn: async () => (await apiRequest("GET", "/api/health/mutuelles-tns")).json(),
  });

  return (
    <Card data-testid="card-mutuelles-tns">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Heart size={18} className="text-rose-500" />
          Comparateur mutuelles TNS
        </CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-64 w-full" />
        ) : (
          <div className="space-y-3">
            {(data?.mutuelles || []).map((m) => (
              <div key={m.id} className="rounded-lg border border-border p-3" data-testid={`row-mutuelle-${m.id}`}>
                <div className="mb-1 flex items-center justify-between">
                  <h3 className="font-semibold">{m.nom}</h3>
                  <Badge>{m.prix_min}–{m.prix_max} €/mois</Badge>
                </div>
                <p className="mb-1 text-xs text-muted-foreground">
                  <strong>Indemnités journalières :</strong> {m.indemnites_journalieres}
                </p>
                <p className="mb-1 text-xs text-muted-foreground">
                  Carence : {m.delai_carence_jours} jour{m.delai_carence_jours > 1 ? "s" : ""}
                </p>
                <div className="mb-1 flex flex-wrap gap-1">
                  {m.garanties.map((g, i) => (
                    <Badge key={i} variant="outline" className="text-[10px]">{g}</Badge>
                  ))}
                </div>
                <p className="text-xs italic text-muted-foreground">{m.note_fr}</p>
                <a href={m.url} target="_blank" rel="noreferrer" className="mt-1 inline-block text-xs text-sky-500 underline">
                  {m.url}
                </a>
              </div>
            ))}
          </div>
        )}
        <p className="mt-3 text-[11px] text-muted-foreground">
          Tarifs indicatifs, à confirmer par devis personnalisé selon âge et niveau de garanties.
        </p>
      </CardContent>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Page principale
// ─────────────────────────────────────────────────────────────────────────────
export default function SantePage() {
  return (
    <div className="mx-auto max-w-2xl space-y-4 p-4 pb-24" data-testid="page-sante">
      <div>
        <h1 className="text-xl font-bold flex items-center gap-2">
          <Heart size={22} className="text-rose-500" />
          Santé chauffeur
        </h1>
        <p className="text-sm text-muted-foreground">Suivi bien-être, ergonomie et couverture santé au quotidien.</p>
      </div>
      <HealthJournalCard />
      <RecommendedExerciseCard />
      <ErgoScoreCard />
      <MutuellesTable />
    </div>
  );
}
