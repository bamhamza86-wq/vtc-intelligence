/**
 * FinancePage.tsx — Couche FINANCE PERSO chauffeur (Itération Santé & Finance)
 * ─────────────────────────────────────────────────────────────────────────────
 * Rapport §6, §11, §19 + gaps benchmark (inDrive Money, Uber Pro Card cashout,
 * Everlance garantie audit fiscal, Hurdlr réconciliation bancaire) :
 *   - Budget du mois (progress bars par catégorie)
 *   - Épargne automatique (jauge + toggle)
 *   - Objectifs annuels (liste + progress)
 *   - Simulateur crédit
 *   - Projection retraite (chart CSS simple)
 *   - Alertes financières
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import {
  PiggyBank,
  Target,
  TrendingUp,
  Wallet,
  AlertTriangle,
  Info,
  AlertCircle,
  Calculator,
} from "lucide-react";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────
interface Budget {
  mois: number;
  annee: number;
  revenu_brut: number;
  charges: number;
  provision_impot: number;
  epargne_target: number;
  disponible: number;
  categories: { nom: string; montant: number; type: string }[];
  pct_utilise: number;
}

interface AutoSaveSettings {
  enabled: number;
  percent: number;
  total_saved: number;
}

interface AnnualGoal {
  annee: number;
  ca_target: number;
  net_target: number;
  epargne_target: number;
  projet: { vacances: number; voiture: number; immo: number; retraite: number };
  progress: {
    ca_realise: number;
    ca_pct: number;
    net_realise: number;
    net_pct: number;
    epargne_realisee: number;
    epargne_pct: number;
  };
}

interface LoanResult {
  montant_finance: number;
  apport: number;
  duree_mois: number;
  taux_annuel_pct: number;
  mensualite: number;
  cout_total: number;
  cout_credit: number;
  conseil_fr: string;
}

interface RetirementForecast {
  annees_restantes: number;
  cipav: { pension_mensuelle_estimee: number; note_fr: string };
  versement_liberatoire: { actif: boolean; impot_annuel_estime: number | null; note_fr: string };
  per: { versement_mensuel: number; capital_estime_depart: number; rente_mensuelle_indicative: number; note_fr: string };
  comparatif_fr: string;
}

interface SmartAlert {
  type: string;
  severity: "info" | "warning" | "critical";
  message_fr: string;
}

const SEVERITY_ICON: Record<string, JSX.Element> = {
  info: <Info size={16} className="text-sky-500" />,
  warning: <AlertTriangle size={16} className="text-amber-500" />,
  critical: <AlertCircle size={16} className="text-red-500" />,
};

const MONTHS_FR = ["Jan", "Fév", "Mar", "Avr", "Mai", "Juin", "Juil", "Août", "Sep", "Oct", "Nov", "Déc"];

// ─────────────────────────────────────────────────────────────────────────────
// Budget du mois
// ─────────────────────────────────────────────────────────────────────────────
function BudgetCard() {
  const qc = useQueryClient();
  const now = new Date();
  const { data, isLoading } = useQuery<{ budget: Budget | null }>({
    queryKey: ["/api/finance/budget"],
    queryFn: async () => (await apiRequest("GET", "/api/finance/budget")).json(),
  });

  const [revenu, setRevenu] = useState("");
  const [charges, setCharges] = useState("");
  const [saving, setSaving] = useState(false);

  async function handleSubmit() {
    setSaving(true);
    try {
      await apiRequest("POST", "/api/finance/budget", {
        mois: now.getMonth() + 1,
        annee: now.getFullYear(),
        revenu_brut: Number(revenu),
        charges: Number(charges),
      });
      qc.invalidateQueries({ queryKey: ["/api/finance/budget"] });
      setRevenu("");
      setCharges("");
    } finally {
      setSaving(false);
    }
  }

  const budget = data?.budget;

  return (
    <Card data-testid="card-budget">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Wallet size={18} className="text-emerald-500" />
          Budget du mois — {MONTHS_FR[now.getMonth()]} {now.getFullYear()}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <Skeleton className="h-40 w-full" />
        ) : budget ? (
          <div className="space-y-3">
            {budget.categories.map((c) => (
              <div key={c.nom}>
                <div className="mb-1 flex justify-between text-sm">
                  <span>{c.nom}</span>
                  <span className="font-medium">{c.montant.toFixed(2)} €</span>
                </div>
                <Progress value={budget.revenu_brut > 0 ? Math.min(100, (c.montant / budget.revenu_brut) * 100) : 0} />
              </div>
            ))}
            <div className={`rounded-lg p-3 text-center font-semibold ${budget.disponible < 0 ? "bg-red-500/10 text-red-500" : "bg-emerald-500/10 text-emerald-600"}`}>
              Disponible : {budget.disponible.toFixed(2)} €
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Aucun budget renseigné ce mois-ci.</p>
        )}

        <div className="grid grid-cols-2 gap-3 border-t border-border pt-3">
          <div>
            <label className="mb-1 block text-sm font-medium">Revenu brut (€)</label>
            <input
              type="number"
              value={revenu}
              onChange={(e) => setRevenu(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              style={{ minHeight: 44 }}
              data-testid="input-budget-revenu"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium">Charges (€)</label>
            <input
              type="number"
              value={charges}
              onChange={(e) => setCharges(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              style={{ minHeight: 44 }}
              data-testid="input-budget-charges"
            />
          </div>
        </div>
        <Button
          onClick={handleSubmit}
          disabled={!revenu || !charges || saving}
          className="w-full"
          style={{ minHeight: 44 }}
          data-testid="button-save-budget"
        >
          {saving ? "Enregistrement..." : "Mettre à jour le budget"}
        </Button>
      </CardContent>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Épargne automatique
// ─────────────────────────────────────────────────────────────────────────────
function AutoSaveCard() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<{ settings: AutoSaveSettings }>({
    queryKey: ["/api/finance/auto-save"],
    queryFn: async () => (await apiRequest("GET", "/api/finance/auto-save")).json(),
  });
  const [percent, setPercent] = useState(10);

  async function toggle(enabled: boolean) {
    await apiRequest("POST", "/api/finance/auto-save", { enabled, percent: data?.settings.percent ?? percent });
    qc.invalidateQueries({ queryKey: ["/api/finance/auto-save"] });
  }

  async function updatePercent(p: number) {
    setPercent(p);
    await apiRequest("POST", "/api/finance/auto-save", { enabled: !!data?.settings.enabled, percent: p });
    qc.invalidateQueries({ queryKey: ["/api/finance/auto-save"] });
  }

  const settings = data?.settings;

  return (
    <Card data-testid="card-auto-save">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <PiggyBank size={18} className="text-violet-500" />
          Épargne automatique
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : (
          <>
            <div className="flex items-center justify-between rounded-lg border border-border p-3">
              <div>
                <div className="text-sm font-medium">Règle : {settings?.percent ?? 10}% de chaque course</div>
                <div className="text-xs text-muted-foreground">Provision automatique vers ton épargne</div>
              </div>
              <button
                role="switch"
                aria-checked={!!settings?.enabled}
                onClick={() => toggle(!settings?.enabled)}
                className={`relative h-7 w-12 rounded-full transition-colors ${settings?.enabled ? "bg-emerald-500" : "bg-muted"}`}
                style={{ minHeight: 44, minWidth: 48 }}
                data-testid="toggle-auto-save"
              >
                <span
                  className={`absolute top-1 h-5 w-5 rounded-full bg-white transition-transform ${settings?.enabled ? "translate-x-6" : "translate-x-1"}`}
                />
              </button>
            </div>

            <div>
              <label className="mb-1 flex justify-between text-sm font-medium">
                <span>Pourcentage épargné</span>
                <span>{settings?.percent ?? percent}%</span>
              </label>
              <input
                type="range"
                min={0}
                max={50}
                value={settings?.percent ?? percent}
                onChange={(e) => updatePercent(Number(e.target.value))}
                className="w-full"
                style={{ minHeight: 44 }}
                data-testid="input-auto-save-percent"
              />
            </div>

            <div className="text-center">
              <div className="text-3xl font-bold text-violet-500">{(settings?.total_saved ?? 0).toFixed(2)} €</div>
              <div className="text-xs text-muted-foreground">Total épargné automatiquement</div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Objectifs annuels
// ─────────────────────────────────────────────────────────────────────────────
function AnnualGoalsCard() {
  const qc = useQueryClient();
  const year = new Date().getFullYear();
  const { data, isLoading } = useQuery<{ goal: AnnualGoal | null }>({
    queryKey: ["/api/finance/goals", year],
    queryFn: async () => (await apiRequest("GET", `/api/finance/goals?annee=${year}`)).json(),
  });

  const [caTarget, setCaTarget] = useState("");
  const [netTarget, setNetTarget] = useState("");
  const [epargneTarget, setEpargneTarget] = useState("");
  const [saving, setSaving] = useState(false);

  async function handleSubmit() {
    setSaving(true);
    try {
      await apiRequest("POST", "/api/finance/goals", {
        annee: year,
        ca_target: Number(caTarget),
        net_target: Number(netTarget),
        epargne_target: Number(epargneTarget),
      });
      qc.invalidateQueries({ queryKey: ["/api/finance/goals", year] });
    } finally {
      setSaving(false);
    }
  }

  const goal = data?.goal;

  return (
    <Card data-testid="card-annual-goals">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Target size={18} className="text-orange-500" />
          Objectifs annuels {year}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <Skeleton className="h-32 w-full" />
        ) : goal ? (
          <div className="space-y-3">
            <div>
              <div className="mb-1 flex justify-between text-sm">
                <span>Chiffre d'affaires</span>
                <span>{goal.progress.ca_realise.toFixed(0)} / {goal.ca_target.toFixed(0)} € ({goal.progress.ca_pct}%)</span>
              </div>
              <Progress value={Math.min(100, goal.progress.ca_pct)} />
            </div>
            <div>
              <div className="mb-1 flex justify-between text-sm">
                <span>Revenu net</span>
                <span>{goal.progress.net_realise.toFixed(0)} / {goal.net_target.toFixed(0)} € ({goal.progress.net_pct}%)</span>
              </div>
              <Progress value={Math.min(100, goal.progress.net_pct)} />
            </div>
            <div>
              <div className="mb-1 flex justify-between text-sm">
                <span>Épargne</span>
                <span>{goal.progress.epargne_realisee.toFixed(0)} / {goal.epargne_target.toFixed(0)} € ({goal.progress.epargne_pct}%)</span>
              </div>
              <Progress value={Math.min(100, goal.progress.epargne_pct)} />
            </div>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Aucun objectif défini pour {year}.</p>
        )}

        <div className="grid grid-cols-3 gap-2 border-t border-border pt-3">
          <div>
            <label className="mb-1 block text-xs font-medium">CA cible (€)</label>
            <input type="number" value={caTarget} onChange={(e) => setCaTarget(e.target.value)} className="w-full rounded-md border border-input bg-background px-2 py-2 text-sm" style={{ minHeight: 44 }} data-testid="input-goal-ca" />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium">Net cible (€)</label>
            <input type="number" value={netTarget} onChange={(e) => setNetTarget(e.target.value)} className="w-full rounded-md border border-input bg-background px-2 py-2 text-sm" style={{ minHeight: 44 }} data-testid="input-goal-net" />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium">Épargne cible (€)</label>
            <input type="number" value={epargneTarget} onChange={(e) => setEpargneTarget(e.target.value)} className="w-full rounded-md border border-input bg-background px-2 py-2 text-sm" style={{ minHeight: 44 }} data-testid="input-goal-epargne" />
          </div>
        </div>
        <Button onClick={handleSubmit} disabled={saving} className="w-full" style={{ minHeight: 44 }} data-testid="button-save-goals">
          {saving ? "Enregistrement..." : "Enregistrer les objectifs"}
        </Button>
      </CardContent>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Simulateur crédit véhicule
// ─────────────────────────────────────────────────────────────────────────────
function LoanSimulatorCard() {
  const [montant, setMontant] = useState("20000");
  const [taux, setTaux] = useState("4.5");
  const [duree, setDuree] = useState("60");
  const [apport, setApport] = useState("2000");
  const [result, setResult] = useState<LoanResult | null>(null);
  const [loading, setLoading] = useState(false);

  async function simulate() {
    setLoading(true);
    try {
      const res = await apiRequest("POST", "/api/finance/loan-simulator", {
        montant: Number(montant),
        taux: Number(taux),
        duree: Number(duree),
        apport: Number(apport),
      });
      setResult(await res.json());
    } finally {
      setLoading(false);
    }
  }

  return (
    <Card data-testid="card-loan-simulator">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Calculator size={18} className="text-blue-500" />
          Simulateur crédit véhicule
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1 block text-xs font-medium">Montant (€)</label>
            <input type="number" value={montant} onChange={(e) => setMontant(e.target.value)} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm" style={{ minHeight: 44 }} data-testid="input-loan-montant" />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium">Taux annuel (%)</label>
            <input type="number" step="0.1" value={taux} onChange={(e) => setTaux(e.target.value)} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm" style={{ minHeight: 44 }} data-testid="input-loan-taux" />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium">Durée (mois)</label>
            <input type="number" value={duree} onChange={(e) => setDuree(e.target.value)} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm" style={{ minHeight: 44 }} data-testid="input-loan-duree" />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium">Apport (€)</label>
            <input type="number" value={apport} onChange={(e) => setApport(e.target.value)} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm" style={{ minHeight: 44 }} data-testid="input-loan-apport" />
          </div>
        </div>
        <Button onClick={simulate} disabled={loading} className="w-full" style={{ minHeight: 44 }} data-testid="button-simulate-loan">
          {loading ? "Calcul..." : "Simuler"}
        </Button>
        {result && (
          <div className="space-y-1 rounded-lg bg-muted p-3 text-sm">
            <div className="flex justify-between"><span>Mensualité</span><strong>{result.mensualite.toFixed(2)} €</strong></div>
            <div className="flex justify-between"><span>Coût total</span><strong>{result.cout_total.toFixed(2)} €</strong></div>
            <div className="flex justify-between"><span>Coût du crédit</span><strong>{result.cout_credit.toFixed(2)} €</strong></div>
            <p className="pt-1 text-xs italic text-muted-foreground">{result.conseil_fr}</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Projection retraite (chart CSS simple)
// ─────────────────────────────────────────────────────────────────────────────
function RetirementForecastCard() {
  const [age, setAge] = useState(35);
  const [revenu, setRevenu] = useState(25000);
  const [vl, setVl] = useState(false);
  const [per, setPer] = useState(100);

  const { data, isLoading, refetch } = useQuery<RetirementForecast>({
    queryKey: ["/api/finance/retirement-forecast", age, revenu, vl, per],
    queryFn: async () =>
      (
        await apiRequest(
          "GET",
          `/api/finance/retirement-forecast?age_actuel=${age}&age_depart=64&revenu_annuel_moyen=${revenu}&versement_liberatoire=${vl}&per_mensuel=${per}`
        )
      ).json(),
  });

  const maxBar = Math.max(data?.cipav.pension_mensuelle_estimee ?? 0, data?.per.rente_mensuelle_indicative ?? 0, 1);

  return (
    <Card data-testid="card-retirement-forecast">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <TrendingUp size={18} className="text-teal-500" />
          Projection retraite
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1 block text-xs font-medium">Âge actuel</label>
            <input type="number" value={age} onChange={(e) => setAge(Number(e.target.value))} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm" style={{ minHeight: 44 }} data-testid="input-retirement-age" />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium">Revenu annuel moyen (€)</label>
            <input type="number" value={revenu} onChange={(e) => setRevenu(Number(e.target.value))} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm" style={{ minHeight: 44 }} data-testid="input-retirement-revenu" />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium">Versement PER mensuel (€)</label>
            <input type="number" value={per} onChange={(e) => setPer(Number(e.target.value))} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm" style={{ minHeight: 44 }} data-testid="input-retirement-per" />
          </div>
          <label className="flex items-center gap-2 self-end pb-2 text-sm">
            <input type="checkbox" checked={vl} onChange={(e) => setVl(e.target.checked)} style={{ width: 20, height: 20 }} data-testid="checkbox-versement-liberatoire" />
            Versement libératoire
          </label>
        </div>
        <Button onClick={() => refetch()} variant="outline" className="w-full" style={{ minHeight: 44 }} data-testid="button-refresh-retirement">
          Recalculer
        </Button>

        {isLoading ? (
          <Skeleton className="h-40 w-full" />
        ) : data ? (
          <div className="space-y-3">
            <div className="flex items-end gap-4" style={{ height: 120 }}>
              <div className="flex flex-1 flex-col items-center justify-end gap-1">
                <div className="text-xs font-medium">{data.cipav.pension_mensuelle_estimee} €/mois</div>
                <div
                  className="w-full rounded-t-md bg-sky-500"
                  style={{ height: `${Math.max(4, (data.cipav.pension_mensuelle_estimee / maxBar) * 100)}px` }}
                />
                <div className="text-[11px] text-muted-foreground">CIPAV</div>
              </div>
              <div className="flex flex-1 flex-col items-center justify-end gap-1">
                <div className="text-xs font-medium">{data.per.rente_mensuelle_indicative} €/mois</div>
                <div
                  className="w-full rounded-t-md bg-teal-500"
                  style={{ height: `${Math.max(4, (data.per.rente_mensuelle_indicative / maxBar) * 100)}px` }}
                />
                <div className="text-[11px] text-muted-foreground">PER (indicatif)</div>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">{data.cipav.note_fr}</p>
            {data.versement_liberatoire.impot_annuel_estime != null && (
              <p className="text-xs text-muted-foreground">
                Versement libératoire : impôt annuel estimé {data.versement_liberatoire.impot_annuel_estime} € — {data.versement_liberatoire.note_fr}
              </p>
            )}
            <p className="rounded-lg bg-muted p-2 text-xs italic">{data.comparatif_fr}</p>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Alertes financières
// ─────────────────────────────────────────────────────────────────────────────
function SmartAlertsCard() {
  const { data, isLoading } = useQuery<{ alerts: SmartAlert[] }>({
    queryKey: ["/api/finance/smart-alerts"],
    queryFn: async () => (await apiRequest("GET", "/api/finance/smart-alerts")).json(),
  });

  return (
    <Card data-testid="card-smart-alerts">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <AlertTriangle size={18} className="text-amber-500" />
          Alertes financières
        </CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-20 w-full" />
        ) : (
          <div className="space-y-2">
            {(data?.alerts || []).map((a, i) => (
              <div key={i} className="flex items-start gap-2 rounded-lg border border-border p-2.5 text-sm" data-testid={`alert-${a.type}`}>
                {SEVERITY_ICON[a.severity]}
                <span>{a.message_fr}</span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Page principale
// ─────────────────────────────────────────────────────────────────────────────
export default function FinancePage() {
  return (
    <div className="mx-auto max-w-2xl space-y-4 p-4 pb-24" data-testid="page-finance">
      <div>
        <h1 className="text-xl font-bold flex items-center gap-2">
          <Wallet size={22} className="text-emerald-500" />
          Finance perso
        </h1>
        <p className="text-sm text-muted-foreground">Budget, épargne, objectifs et simulateurs pour piloter tes finances de chauffeur.</p>
      </div>
      <BudgetCard />
      <AutoSaveCard />
      <AnnualGoalsCard />
      <LoanSimulatorCard />
      <RetirementForecastCard />
      <SmartAlertsCard />
    </div>
  );
}
