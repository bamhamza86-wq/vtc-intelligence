/**
 * OnboardingPage — Couche ONBOARDING NOUVEAU CHAUFFEUR (rapport.md §16, §18)
 * ─────────────────────────────────────────────────────────────────────────────
 * Inspiré de Bonsai (business plan structuré) et QuickBooks Live Tax (guide
 * de statut fiscal assisté).
 *
 *   - Simulateur d'installation (break-even, CA 3 ans, cash-flow mensuel)
 *   - Business plan automatique (aperçu HTML "PDF-ready")
 *   - Checklist administrative pré-activité (15+ items)
 *   - Guide statut fiscal initial (micro-BIC / micro-BNC / EI réel / SASU)
 *   - Parcours des 30 premiers jours (30 jalons progressifs)
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import {
  Rocket,
  Calculator,
  FileText,
  CheckCircle,
  CheckCircle2,
  Circle,
  Compass,
  TrendingUp,
  Loader2,
  ChevronDown,
  ChevronUp,
  Download,
} from "lucide-react";

// ─── Sous-composant générique de section ────────────────────────────────────
function SectionCard({ icon: Icon, title, subtitle, children }: any) {
  return (
    <div className="bg-card border border-border rounded-xl p-4 space-y-3">
      <div className="flex items-center gap-2">
        <div className="p-1.5 rounded-lg bg-primary/10 text-primary">
          <Icon size={16} />
        </div>
        <div>
          <h2 className="text-sm font-semibold">{title}</h2>
          {subtitle && <p className="text-xs text-muted-foreground">{subtitle}</p>}
        </div>
      </div>
      {children}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. SIMULATEUR D'INSTALLATION
// ═══════════════════════════════════════════════════════════════════════════
interface InstallationResult {
  hypotheses: Record<string, any>;
  breakeven_mois: number;
  ca_year1: number;
  ca_year2: number;
  ca_year3: number;
  cash_flow_mensuel: { mois: number; ca: number; charges: number; mensualite: number; net: number; cumul: number }[];
  seuil_rentabilite_eur_mois: number;
  message_fr: string;
}

const STATUTS_FISCAUX = [
  { key: "micro-bic", label: "Micro-entrepreneur (micro-BIC)" },
  { key: "micro-bnc", label: "Micro-entrepreneur (micro-BNC)" },
  { key: "ei-reel", label: "EI au régime réel" },
  { key: "sasu", label: "SASU" },
];
const ZONES = [
  { key: "paris", label: "Paris intra-muros" },
  { key: "petite-couronne", label: "Petite couronne" },
  { key: "grande-couronne", label: "Grande couronne" },
  { key: "aeroport", label: "Zone aéroportuaire" },
];
const EXPERIENCES = [
  { key: "debutant", label: "Débutant (aucune expérience VTC)" },
  { key: "1-2ans", label: "1 à 2 ans d'expérience" },
  { key: "2ans-plus", label: "Plus de 2 ans d'expérience" },
];

function InstallationSimulatorSection({ onBusinessPlanInputsChange }: { onBusinessPlanInputsChange: (i: any) => void }) {
  const [vehiculePrix, setVehiculePrix] = useState("22000");
  const [apport, setApport] = useState("4000");
  const [statutFiscal, setStatutFiscal] = useState("micro-bic");
  const [zone, setZone] = useState("petite-couronne");
  const [experience, setExperience] = useState("debutant");
  const [result, setResult] = useState<InstallationResult | null>(null);
  const [loading, setLoading] = useState(false);

  async function simulate() {
    setLoading(true);
    try {
      const payload = {
        vehicule_prix: Number(vehiculePrix) || 0,
        apport: Number(apport) || 0,
        statut_fiscal: statutFiscal,
        zone,
        experience,
      };
      const res = await apiRequest("POST", "/api/onboarding/installation-simulator", payload);
      const data = await res.json();
      setResult(data);
      onBusinessPlanInputsChange(payload);
    } finally {
      setLoading(false);
    }
  }

  return (
    <SectionCard icon={Calculator} title="Simulateur d'installation" subtitle="Break-even, CA prévisionnel 3 ans, cash-flow mensuel">
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="block text-xs text-muted-foreground mb-1">Prix véhicule (€)</label>
          <input type="number" value={vehiculePrix} onChange={(e) => setVehiculePrix(e.target.value)}
            className="w-full min-h-[44px] px-3 rounded-lg border border-border bg-background text-sm" data-testid="input-vehicule-prix" />
        </div>
        <div>
          <label className="block text-xs text-muted-foreground mb-1">Apport (€)</label>
          <input type="number" value={apport} onChange={(e) => setApport(e.target.value)}
            className="w-full min-h-[44px] px-3 rounded-lg border border-border bg-background text-sm" data-testid="input-apport" />
        </div>
      </div>
      <div>
        <label className="block text-xs text-muted-foreground mb-1">Statut fiscal</label>
        <select value={statutFiscal} onChange={(e) => setStatutFiscal(e.target.value)}
          className="w-full min-h-[44px] px-3 rounded-lg border border-border bg-background text-sm" data-testid="select-statut-fiscal">
          {STATUTS_FISCAUX.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
        </select>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="block text-xs text-muted-foreground mb-1">Zone</label>
          <select value={zone} onChange={(e) => setZone(e.target.value)}
            className="w-full min-h-[44px] px-3 rounded-lg border border-border bg-background text-sm" data-testid="select-zone">
            {ZONES.map(z => <option key={z.key} value={z.key}>{z.label}</option>)}
          </select>
        </div>
        <div>
          <label className="block text-xs text-muted-foreground mb-1">Expérience</label>
          <select value={experience} onChange={(e) => setExperience(e.target.value)}
            className="w-full min-h-[44px] px-3 rounded-lg border border-border bg-background text-sm" data-testid="select-experience">
            {EXPERIENCES.map(x => <option key={x.key} value={x.key}>{x.label}</option>)}
          </select>
        </div>
      </div>
      <button
        onClick={simulate}
        disabled={loading}
        className="w-full min-h-[48px] rounded-lg bg-primary text-primary-foreground font-medium text-sm flex items-center justify-center gap-2 disabled:opacity-60"
        data-testid="button-simulate-installation"
      >
        {loading ? <Loader2 size={16} className="animate-spin" /> : <Calculator size={16} />}
        Simuler mon installation
      </button>

      {result && (
        <div className="space-y-3 pt-2 border-t border-border">
          <div className="grid grid-cols-2 gap-2">
            <div className="bg-background/60 rounded-lg p-2.5">
              <p className="text-[10px] text-muted-foreground">Break-even</p>
              <p className="text-sm font-semibold tabular-nums">{result.breakeven_mois > 0 ? `${result.breakeven_mois} mois` : "> 36 mois"}</p>
            </div>
            <div className="bg-background/60 rounded-lg p-2.5">
              <p className="text-[10px] text-muted-foreground">Seuil rentabilité / mois</p>
              <p className="text-sm font-semibold tabular-nums">{result.seuil_rentabilite_eur_mois.toFixed(0)} €</p>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div className="bg-background/60 rounded-lg p-2.5 text-center">
              <p className="text-[10px] text-muted-foreground">CA An 1</p>
              <p className="text-sm font-semibold tabular-nums">{result.ca_year1.toLocaleString("fr-FR")} €</p>
            </div>
            <div className="bg-background/60 rounded-lg p-2.5 text-center">
              <p className="text-[10px] text-muted-foreground">CA An 2</p>
              <p className="text-sm font-semibold tabular-nums">{result.ca_year2.toLocaleString("fr-FR")} €</p>
            </div>
            <div className="bg-background/60 rounded-lg p-2.5 text-center">
              <p className="text-[10px] text-muted-foreground">CA An 3</p>
              <p className="text-sm font-semibold tabular-nums">{result.ca_year3.toLocaleString("fr-FR")} €</p>
            </div>
          </div>
          <p className="text-xs text-muted-foreground leading-relaxed">{result.message_fr}</p>

          <details className="text-xs">
            <summary className="cursor-pointer text-primary font-medium">Voir le cash-flow mensuel détaillé</summary>
            <div className="mt-2 max-h-64 overflow-y-auto">
              <table className="w-full text-[11px]">
                <thead>
                  <tr className="text-muted-foreground">
                    <th className="text-left py-1">Mois</th>
                    <th className="text-right py-1">CA</th>
                    <th className="text-right py-1">Charges</th>
                    <th className="text-right py-1">Net</th>
                    <th className="text-right py-1">Cumul</th>
                  </tr>
                </thead>
                <tbody>
                  {result.cash_flow_mensuel.map((r) => (
                    <tr key={r.mois} className="border-t border-border/50">
                      <td className="py-1">M{r.mois}</td>
                      <td className="text-right py-1 tabular-nums">{r.ca.toFixed(0)} €</td>
                      <td className="text-right py-1 tabular-nums">{r.charges.toFixed(0)} €</td>
                      <td className="text-right py-1 tabular-nums">{r.net.toFixed(0)} €</td>
                      <td className={`text-right py-1 tabular-nums font-medium ${r.cumul >= 0 ? "text-green-600" : "text-red-500"}`}>{r.cumul.toFixed(0)} €</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </div>
      )}
    </SectionCard>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. BUSINESS PLAN AUTOMATIQUE
// ═══════════════════════════════════════════════════════════════════════════
function BusinessPlanSection({ baseInputs }: { baseInputs: any }) {
  const [nomChauffeur, setNomChauffeur] = useState("");
  const [ville, setVille] = useState("Île-de-France");
  const [html, setHtml] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);

  async function generate() {
    setLoading(true);
    try {
      const payload = {
        vehicule_prix: baseInputs?.vehicule_prix ?? 22000,
        apport: baseInputs?.apport ?? 4000,
        statut_fiscal: baseInputs?.statut_fiscal ?? "micro-bic",
        zone: baseInputs?.zone ?? "petite-couronne",
        experience: baseInputs?.experience ?? "debutant",
        nom_chauffeur: nomChauffeur || "Chauffeur VTC",
        ville,
      };
      const res = await apiRequest("POST", "/api/onboarding/business-plan", payload);
      const data = await res.json();
      setHtml(data.html);
      setExpanded(true);
    } finally {
      setLoading(false);
    }
  }

  function downloadHtml() {
    if (!html) return;
    const blob = new Blob([html], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "business-plan-vtc.html";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <SectionCard icon={FileText} title="Business plan automatique" subtitle="Document PDF-ready : executive summary, marché, prévisionnel 3 ans">
      <p className="text-xs text-muted-foreground">Lancez d'abord le simulateur d'installation ci-dessus pour des hypothèses cohérentes, puis générez votre business plan.</p>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="block text-xs text-muted-foreground mb-1">Votre nom</label>
          <input type="text" value={nomChauffeur} onChange={(e) => setNomChauffeur(e.target.value)}
            placeholder="Ex : Karim B." className="w-full min-h-[44px] px-3 rounded-lg border border-border bg-background text-sm" data-testid="input-nom-chauffeur" />
        </div>
        <div>
          <label className="block text-xs text-muted-foreground mb-1">Ville / secteur</label>
          <input type="text" value={ville} onChange={(e) => setVille(e.target.value)}
            className="w-full min-h-[44px] px-3 rounded-lg border border-border bg-background text-sm" data-testid="input-ville" />
        </div>
      </div>
      <button
        onClick={generate}
        disabled={loading}
        className="w-full min-h-[48px] rounded-lg bg-primary text-primary-foreground font-medium text-sm flex items-center justify-center gap-2 disabled:opacity-60"
        data-testid="button-generate-business-plan"
      >
        {loading ? <Loader2 size={16} className="animate-spin" /> : <FileText size={16} />}
        Générer mon business plan
      </button>

      {html && (
        <div className="space-y-2 pt-2 border-t border-border">
          <div className="flex items-center justify-between">
            <button onClick={() => setExpanded(v => !v)} className="text-xs text-primary font-medium flex items-center gap-1" data-testid="button-toggle-preview">
              {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
              {expanded ? "Masquer l'aperçu" : "Afficher l'aperçu"}
            </button>
            <button onClick={downloadHtml} className="text-xs text-primary font-medium flex items-center gap-1" data-testid="button-download-business-plan">
              <Download size={14} /> Télécharger (.html)
            </button>
          </div>
          {expanded && (
            <iframe
              title="Aperçu business plan"
              srcDoc={html}
              className="w-full h-[480px] rounded-lg border border-border bg-white"
              data-testid="iframe-business-plan-preview"
            />
          )}
        </div>
      )}
    </SectionCard>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. CHECKLIST ADMINISTRATIVE
// ═══════════════════════════════════════════════════════════════════════════
interface ChecklistItem {
  key: string;
  label_fr: string;
  description_fr: string;
  category: string;
  obligatoire: boolean;
  completed: boolean;
}
interface ChecklistData {
  items: ChecklistItem[];
  total_items: number;
  done_items: number;
  pct_obligatoire_complete: number;
}

const CATEGORY_LABELS: Record<string, string> = {
  identite: "Identité & permis",
  juridique: "Juridique",
  assurance: "Assurances",
  vehicule: "Véhicule",
  formation: "Formation",
  financier: "Financier",
};

function ChecklistSection() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<ChecklistData>({
    queryKey: ["/api/onboarding/checklist"],
    queryFn: () => apiRequest("GET", "/api/onboarding/checklist").then(r => r.json()),
  });

  async function toggle(itemKey: string, completed: boolean) {
    await apiRequest("PATCH", `/api/onboarding/checklist/${itemKey}`, { completed: !completed });
    qc.invalidateQueries({ queryKey: ["/api/onboarding/checklist"] });
  }

  if (isLoading || !data) {
    return (
      <SectionCard icon={CheckCircle} title="Checklist administrative" subtitle="Obligations avant de démarrer l'activité">
        <div className="h-32 rounded-lg bg-muted/40 animate-pulse" />
      </SectionCard>
    );
  }

  const grouped: Record<string, ChecklistItem[]> = {};
  for (const item of data.items) {
    (grouped[item.category] ||= []).push(item);
  }

  return (
    <SectionCard icon={CheckCircle} title="Checklist administrative" subtitle={`${data.done_items}/${data.total_items} éléments complétés · ${data.pct_obligatoire_complete.toFixed(0)}% des obligatoires`}>
      <div className="h-2.5 rounded-full bg-muted overflow-hidden">
        <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${data.pct_obligatoire_complete}%` }} />
      </div>
      {Object.entries(grouped).map(([cat, items]) => (
        <div key={cat} className="space-y-1.5">
          <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mt-2">{CATEGORY_LABELS[cat] || cat}</h4>
          {items.map((item) => (
            <button
              key={item.key}
              onClick={() => toggle(item.key, item.completed)}
              className="w-full flex items-start gap-2 p-2.5 rounded-lg bg-background/60 hover:bg-accent text-left transition-colors"
              data-testid={`checklist-item-${item.key}`}
            >
              {item.completed ? (
                <CheckCircle2 size={18} className="text-green-500 shrink-0 mt-0.5" />
              ) : (
                <Circle size={18} className="text-muted-foreground shrink-0 mt-0.5" />
              )}
              <div className="min-w-0">
                <p className={`text-sm ${item.completed ? "line-through text-muted-foreground" : ""}`}>
                  {item.label_fr} {item.obligatoire && <span className="text-[10px] text-red-500 font-semibold">OBLIGATOIRE</span>}
                </p>
                <p className="text-xs text-muted-foreground">{item.description_fr}</p>
              </div>
            </button>
          ))}
        </div>
      ))}
    </SectionCard>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. GUIDE STATUT FISCAL
// ═══════════════════════════════════════════════════════════════════════════
interface StatusGuideResult {
  recommandation: string;
  label_fr: string;
  score_details: { statut: string; label_fr: string; score: number; avantages: string[]; inconvenients: string[] }[];
  explication_fr: string;
}

function StatusGuideSection() {
  const [ca, setCa] = useState("30000");
  const [situation, setSituation] = useState("celibataire");
  const [wantsAssocies, setWantsAssocies] = useState(false);
  const [wantsCharges, setWantsCharges] = useState(false);
  const [result, setResult] = useState<StatusGuideResult | null>(null);
  const [loading, setLoading] = useState(false);

  async function analyze() {
    setLoading(true);
    try {
      const res = await apiRequest("POST", "/api/onboarding/status-guide", {
        ca_previsionnel_annuel: Number(ca) || 0,
        situation_famille: situation,
        souhaite_associes: wantsAssocies,
        souhaite_deduire_charges_reelles: wantsCharges,
      });
      setResult(await res.json());
    } finally {
      setLoading(false);
    }
  }

  return (
    <SectionCard icon={Compass} title="Guide statut fiscal initial" subtitle="Recommandation micro-BIC / micro-BNC / EI réel / SASU">
      <div>
        <label className="block text-xs text-muted-foreground mb-1">CA prévisionnel annuel (€)</label>
        <input type="number" value={ca} onChange={(e) => setCa(e.target.value)}
          className="w-full min-h-[44px] px-3 rounded-lg border border-border bg-background text-sm" data-testid="input-ca-previsionnel" />
      </div>
      <div>
        <label className="block text-xs text-muted-foreground mb-1">Situation familiale</label>
        <select value={situation} onChange={(e) => setSituation(e.target.value)}
          className="w-full min-h-[44px] px-3 rounded-lg border border-border bg-background text-sm" data-testid="select-situation-famille">
          <option value="celibataire">Célibataire</option>
          <option value="marie">Marié(e)</option>
          <option value="pacse">Pacsé(e)</option>
          <option value="famille_enfants">Famille avec enfants</option>
        </select>
      </div>
      <div className="flex flex-col gap-2">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={wantsAssocies} onChange={(e) => setWantsAssocies(e.target.checked)} className="w-5 h-5" data-testid="checkbox-associes" />
          Je souhaite m'associer / accueillir des investisseurs
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={wantsCharges} onChange={(e) => setWantsCharges(e.target.checked)} className="w-5 h-5" data-testid="checkbox-charges-reelles" />
          Je souhaite déduire mes charges réelles (véhicule, carburant...)
        </label>
      </div>
      <button
        onClick={analyze}
        disabled={loading}
        className="w-full min-h-[48px] rounded-lg bg-primary text-primary-foreground font-medium text-sm flex items-center justify-center gap-2 disabled:opacity-60"
        data-testid="button-analyze-status"
      >
        {loading ? <Loader2 size={16} className="animate-spin" /> : <Compass size={16} />}
        Recommander un statut
      </button>

      {result && (
        <div className="space-y-2 pt-2 border-t border-border">
          <div className="bg-primary/10 rounded-lg p-3">
            <p className="text-xs text-muted-foreground">Recommandation</p>
            <p className="text-base font-bold text-primary">{result.label_fr}</p>
          </div>
          <p className="text-xs text-muted-foreground leading-relaxed">{result.explication_fr}</p>
          <div className="space-y-2">
            {result.score_details.map((s) => (
              <details key={s.statut} className="bg-background/60 rounded-lg p-2.5" open={s.statut === result.recommandation}>
                <summary className="cursor-pointer text-sm font-medium flex items-center justify-between">
                  <span>{s.label_fr}</span>
                  <span className="text-xs text-muted-foreground">Score {s.score}/100</span>
                </summary>
                <div className="mt-2 grid grid-cols-1 gap-2 text-xs">
                  <div>
                    <p className="font-semibold text-green-600 mb-1">Avantages</p>
                    <ul className="list-disc list-inside space-y-0.5 text-muted-foreground">
                      {s.avantages.map((a, i) => <li key={i}>{a}</li>)}
                    </ul>
                  </div>
                  <div>
                    <p className="font-semibold text-red-500 mb-1">Inconvénients</p>
                    <ul className="list-disc list-inside space-y-0.5 text-muted-foreground">
                      {s.inconvenients.map((a, i) => <li key={i}>{a}</li>)}
                    </ul>
                  </div>
                </div>
              </details>
            ))}
          </div>
        </div>
      )}
    </SectionCard>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. PARCOURS 30 PREMIERS JOURS
// ═══════════════════════════════════════════════════════════════════════════
interface JourneyMilestone {
  id: number;
  day_number: number;
  milestone: string;
  target: string;
  completed: number;
  note: string;
}
interface JourneyData { milestones: JourneyMilestone[]; total: number; done: number; pct: number }

function JourneySection() {
  const qc = useQueryClient();
  const [showAll, setShowAll] = useState(false);
  const { data, isLoading } = useQuery<JourneyData>({
    queryKey: ["/api/onboarding/journey"],
    queryFn: () => apiRequest("GET", "/api/onboarding/journey").then(r => r.json()),
  });

  async function toggle(day: number, completed: number) {
    await apiRequest("PATCH", `/api/onboarding/journey/${day}`, { completed: !completed });
    qc.invalidateQueries({ queryKey: ["/api/onboarding/journey"] });
  }

  if (isLoading || !data) {
    return (
      <SectionCard icon={TrendingUp} title="Parcours des 30 premiers jours" subtitle="Jalons progressifs pour démarrer sereinement">
        <div className="h-32 rounded-lg bg-muted/40 animate-pulse" />
      </SectionCard>
    );
  }

  const visibleMilestones = showAll ? data.milestones : data.milestones.filter(m => !m.completed).slice(0, 7);

  return (
    <SectionCard icon={TrendingUp} title="Parcours des 30 premiers jours" subtitle={`${data.done}/${data.total} jalons complétés (${data.pct.toFixed(0)}%)`}>
      <div className="h-2.5 rounded-full bg-muted overflow-hidden">
        <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${data.pct}%` }} />
      </div>
      <div className="space-y-1.5 max-h-[420px] overflow-y-auto">
        {visibleMilestones.map((m) => (
          <button
            key={m.day_number}
            onClick={() => toggle(m.day_number, m.completed)}
            className="w-full flex items-start gap-2 p-2.5 rounded-lg bg-background/60 hover:bg-accent text-left transition-colors"
            data-testid={`journey-day-${m.day_number}`}
          >
            {m.completed ? (
              <CheckCircle2 size={18} className="text-green-500 shrink-0 mt-0.5" />
            ) : (
              <Circle size={18} className="text-muted-foreground shrink-0 mt-0.5" />
            )}
            <div className="min-w-0">
              <p className={`text-sm font-medium ${m.completed ? "line-through text-muted-foreground" : ""}`}>
                Jour {m.day_number} — {m.milestone}
              </p>
              <p className="text-xs text-muted-foreground">{m.target}</p>
            </div>
          </button>
        ))}
      </div>
      <button onClick={() => setShowAll(v => !v)} className="text-xs text-primary font-medium" data-testid="button-toggle-journey-view">
        {showAll ? "Afficher seulement les jalons restants" : "Afficher les 30 jours complets"}
      </button>
    </SectionCard>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// PAGE PRINCIPALE
// ═══════════════════════════════════════════════════════════════════════════
export default function OnboardingPage() {
  const [businessPlanInputs, setBusinessPlanInputs] = useState<any>(null);

  return (
    <div className="p-3 sm:p-4 space-y-4 pb-24 max-w-2xl mx-auto">
      <div className="flex items-center gap-2">
        <div className="p-2 rounded-xl bg-primary/10 text-primary">
          <Rocket size={20} />
        </div>
        <div>
          <h1 className="text-lg font-bold">Onboarding nouveau chauffeur</h1>
          <p className="text-xs text-muted-foreground">Simulateur, business plan, checklist et parcours des 30 premiers jours</p>
        </div>
      </div>

      <InstallationSimulatorSection onBusinessPlanInputsChange={setBusinessPlanInputs} />
      <BusinessPlanSection baseInputs={businessPlanInputs} />
      <ChecklistSection />
      <StatusGuideSection />
      <JourneySection />
    </div>
  );
}
