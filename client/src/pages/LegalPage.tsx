/**
 * LegalPage — Couche JURIDIQUE VTC (rapport.md §16, §18)
 * ─────────────────────────────────────────────────────────────────────────────
 * Inspiré de Bonsai (générateur de contrats freelance).
 *
 *   - FAQ juridique contextuelle (15+ questions récurrentes)
 *   - Générateur de contrats freelance (4 templates)
 *   - Base réglementaire 2026 (20+ règles)
 *   - Litiges plateformes (templates de réclamation + suivi)
 *   - Formation continue 5 ans (rappel + formateurs agréés IDF)
 *   - Simulateur retraite CIPAV
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import {
  Scale,
  MessageCircleQuestion,
  FileSignature,
  BookOpen,
  Gavel,
  GraduationCap,
  PiggyBank,
  Loader2,
  Copy,
  Plus,
  X,
  ExternalLink,
} from "lucide-react";

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

function copyToClipboard(text: string) {
  if (navigator.clipboard) navigator.clipboard.writeText(text).catch(() => {});
}

// ═══════════════════════════════════════════════════════════════════════════
// 6. FAQ JURIDIQUE CONTEXTUELLE
// ═══════════════════════════════════════════════════════════════════════════
interface FaqAnswer {
  matched: boolean;
  entry: { key: string; question: string; reponse_fr: string; source_url?: string } | null;
  suggestions: { key: string; question: string; reponse_fr?: string }[];
  message_fr: string;
}

function FaqSection() {
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<FaqAnswer | null>(null);
  const [loading, setLoading] = useState(false);
  const { data: allQuestions } = useQuery<{ questions: { key: string; question: string }[] }>({
    queryKey: ["/api/legal/faq"],
    queryFn: () => apiRequest("GET", "/api/legal/faq").then(r => r.json()),
  });

  async function ask(q?: string) {
    const finalQuestion = q ?? question;
    if (!finalQuestion.trim()) return;
    setLoading(true);
    try {
      const res = await apiRequest("POST", "/api/legal/faq", { question: finalQuestion });
      setAnswer(await res.json());
      if (q) setQuestion(q);
    } finally {
      setLoading(false);
    }
  }

  return (
    <SectionCard icon={MessageCircleQuestion} title="FAQ juridique VTC" subtitle="Posez votre question (maraude, réservation, T3P, cumul salarié...)">
      <div className="flex gap-2">
        <input
          type="text"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && ask()}
          placeholder="Ex : Puis-je marauder en VTC ?"
          className="flex-1 min-h-[44px] px-3 rounded-lg border border-border bg-background text-sm"
          data-testid="input-faq-question"
        />
        <button
          onClick={() => ask()}
          disabled={loading}
          className="min-h-[44px] px-4 rounded-lg bg-primary text-primary-foreground font-medium text-sm flex items-center gap-2 disabled:opacity-60"
          data-testid="button-ask-faq"
        >
          {loading ? <Loader2 size={16} className="animate-spin" /> : "Demander"}
        </button>
      </div>

      {answer && (
        <div className="bg-background/60 rounded-lg p-3 space-y-2">
          {answer.matched && answer.entry ? (
            <>
              <p className="text-sm font-semibold">{answer.entry.question}</p>
              <p className="text-xs text-muted-foreground leading-relaxed">{answer.entry.reponse_fr}</p>
              {answer.entry.source_url && (
                <a href={answer.entry.source_url} target="_blank" rel="noreferrer" className="text-xs text-primary flex items-center gap-1">
                  <ExternalLink size={12} /> Source officielle
                </a>
              )}
            </>
          ) : (
            <p className="text-xs text-muted-foreground">{answer.message_fr}</p>
          )}
        </div>
      )}

      <div>
        <p className="text-xs text-muted-foreground mb-1.5">Questions fréquentes :</p>
        <div className="flex flex-col gap-1.5 max-h-64 overflow-y-auto">
          {(allQuestions?.questions || []).map((q) => (
            <button
              key={q.key}
              onClick={() => ask(q.question)}
              className="text-left text-xs px-2.5 py-2 rounded-lg bg-background/60 hover:bg-accent transition-colors"
              data-testid={`faq-suggestion-${q.key}`}
            >
              {q.question}
            </button>
          ))}
        </div>
      </div>
    </SectionCard>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// 7. GÉNÉRATEUR DE CONTRATS FREELANCE
// ═══════════════════════════════════════════════════════════════════════════
function ContractGeneratorSection() {
  const { data: templatesData } = useQuery<{ templates: { key: string; label_fr: string; description_fr: string }[] }>({
    queryKey: ["/api/legal/contract-template"],
    queryFn: () => apiRequest("GET", "/api/legal/contract-template").then(r => r.json()),
  });
  const [template, setTemplate] = useState("mission_mariage");
  const [nomChauffeur, setNomChauffeur] = useState("");
  const [siret, setSiret] = useState("");
  const [nomClient, setNomClient] = useState("");
  const [datePrestation, setDatePrestation] = useState("");
  const [montant, setMontant] = useState("");
  const [details, setDetails] = useState("");
  const [result, setResult] = useState<{ title: string; body: string; source_note: string } | null>(null);
  const [loading, setLoading] = useState(false);

  async function generate() {
    if (!nomChauffeur.trim() || !nomClient.trim()) return;
    setLoading(true);
    try {
      const res = await apiRequest("POST", "/api/legal/contract-template", {
        template,
        nom_chauffeur: nomChauffeur,
        siret: siret || undefined,
        nom_client: nomClient,
        date_prestation: datePrestation || undefined,
        montant: montant ? Number(montant) : undefined,
        details: details || undefined,
      });
      setResult(await res.json());
    } finally {
      setLoading(false);
    }
  }

  return (
    <SectionCard icon={FileSignature} title="Générateur de contrats freelance" subtitle="4 modèles : mariage, contrat-cadre, CGV, décharge de responsabilité">
      <div>
        <label className="block text-xs text-muted-foreground mb-1">Type de contrat</label>
        <select value={template} onChange={(e) => setTemplate(e.target.value)}
          className="w-full min-h-[44px] px-3 rounded-lg border border-border bg-background text-sm" data-testid="select-contract-template">
          {(templatesData?.templates || []).map(t => <option key={t.key} value={t.key}>{t.label_fr}</option>)}
        </select>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <input type="text" value={nomChauffeur} onChange={(e) => setNomChauffeur(e.target.value)} placeholder="Votre nom *"
          className="min-h-[44px] px-3 rounded-lg border border-border bg-background text-sm" data-testid="input-contract-nom-chauffeur" />
        <input type="text" value={siret} onChange={(e) => setSiret(e.target.value)} placeholder="SIRET (optionnel)"
          className="min-h-[44px] px-3 rounded-lg border border-border bg-background text-sm" data-testid="input-contract-siret" />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <input type="text" value={nomClient} onChange={(e) => setNomClient(e.target.value)} placeholder="Nom du client *"
          className="min-h-[44px] px-3 rounded-lg border border-border bg-background text-sm" data-testid="input-contract-nom-client" />
        <input type="date" value={datePrestation} onChange={(e) => setDatePrestation(e.target.value)}
          className="min-h-[44px] px-3 rounded-lg border border-border bg-background text-sm" data-testid="input-contract-date" />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <input type="number" value={montant} onChange={(e) => setMontant(e.target.value)} placeholder="Montant (€)"
          className="min-h-[44px] px-3 rounded-lg border border-border bg-background text-sm" data-testid="input-contract-montant" />
      </div>
      <textarea value={details} onChange={(e) => setDetails(e.target.value)} placeholder="Détails complémentaires (optionnel)"
        className="w-full min-h-[70px] px-3 py-2 rounded-lg border border-border bg-background text-sm" data-testid="textarea-contract-details" />

      <button
        onClick={generate}
        disabled={loading || !nomChauffeur.trim() || !nomClient.trim()}
        className="w-full min-h-[48px] rounded-lg bg-primary text-primary-foreground font-medium text-sm flex items-center justify-center gap-2 disabled:opacity-60"
        data-testid="button-generate-contract"
      >
        {loading ? <Loader2 size={16} className="animate-spin" /> : <FileSignature size={16} />}
        Générer le contrat
      </button>

      {result && (
        <div className="space-y-2 pt-2 border-t border-border">
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold">{result.title}</p>
            <button onClick={() => copyToClipboard(result.body)} className="text-xs text-primary flex items-center gap-1" data-testid="button-copy-contract">
              <Copy size={12} /> Copier
            </button>
          </div>
          <pre className="text-xs whitespace-pre-wrap bg-background/60 rounded-lg p-3 max-h-80 overflow-y-auto font-sans">{result.body}</pre>
          <p className="text-[11px] text-muted-foreground italic">{result.source_note}</p>
        </div>
      )}
    </SectionCard>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// 8. BASE RÉGLEMENTAIRE 2026
// ═══════════════════════════════════════════════════════════════════════════
interface LegalRule {
  rule_key: string;
  category: string;
  title_fr: string;
  description_fr: string;
  reference_legale: string;
  source_url: string;
}

const RULE_CATEGORY_LABELS: Record<string, string> = {
  fiscalite: "Fiscalité",
  statut: "Statut",
  exercice: "Exercice de l'activité",
  tarification: "Tarification",
  vehicule: "Véhicule",
  identite: "Identité",
  formation: "Formation",
  assurance: "Assurance",
  financier: "Financier",
  juridique: "Juridique",
  jurisprudence: "Jurisprudence",
  contexte: "Contexte",
  donnees: "Données personnelles",
  penal: "Pénal",
  retraite: "Retraite",
};

function LegalRulesSection() {
  const [category, setCategory] = useState<string>("");
  const { data, isLoading } = useQuery<{ rules: LegalRule[]; total: number; categories: string[] }>({
    queryKey: ["/api/legal/rules", category],
    queryFn: () => apiRequest("GET", `/api/legal/rules${category ? `?category=${category}` : ""}`).then(r => r.json()),
  });

  return (
    <SectionCard icon={BookOpen} title="Base réglementaire 2026" subtitle={`${data?.total ?? "…"} règles VTC à jour`}>
      <div className="flex flex-wrap gap-1.5">
        <button onClick={() => setCategory("")} className={`text-xs px-2.5 py-1.5 rounded-full ${!category ? "bg-primary text-primary-foreground" : "bg-background/60"}`} data-testid="rule-category-all">
          Toutes
        </button>
        {(data?.categories || []).map((c) => (
          <button
            key={c}
            onClick={() => setCategory(c)}
            className={`text-xs px-2.5 py-1.5 rounded-full ${category === c ? "bg-primary text-primary-foreground" : "bg-background/60"}`}
            data-testid={`rule-category-${c}`}
          >
            {RULE_CATEGORY_LABELS[c] || c}
          </button>
        ))}
      </div>

      {isLoading ? (
        <div className="h-32 rounded-lg bg-muted/40 animate-pulse" />
      ) : (
        <div className="space-y-2 max-h-[420px] overflow-y-auto">
          {(data?.rules || []).map((rule) => (
            <details key={rule.rule_key} className="bg-background/60 rounded-lg p-2.5">
              <summary className="cursor-pointer text-sm font-medium flex items-center justify-between gap-2">
                <span>{rule.title_fr}</span>
                <span className="text-[10px] text-muted-foreground shrink-0">{RULE_CATEGORY_LABELS[rule.category] || rule.category}</span>
              </summary>
              <p className="text-xs text-muted-foreground mt-1.5">{rule.description_fr}</p>
              <p className="text-[11px] text-muted-foreground italic mt-1">{rule.reference_legale}</p>
              {rule.source_url && (
                <a href={rule.source_url} target="_blank" rel="noreferrer" className="text-[11px] text-primary flex items-center gap-1 mt-1">
                  <ExternalLink size={11} /> Source
                </a>
              )}
            </details>
          ))}
        </div>
      )}
    </SectionCard>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// 9 & 10. LITIGES PLATEFORMES — TEMPLATES + SUIVI
// ═══════════════════════════════════════════════════════════════════════════
interface DisputeTemplateResult { title: string; body: string; base_legale: string[] }
interface DisputeRow { id: number; ts: string; plateforme: string; type: string; montant: number; status: string; resolution: string }

function DisputesSection() {
  const qc = useQueryClient();
  const { data: templatesData } = useQuery<{ templates: { key: string; label_fr: string; description_fr: string }[] }>({
    queryKey: ["/api/legal/dispute-templates"],
    queryFn: () => apiRequest("GET", "/api/legal/dispute-templates").then(r => r.json()),
  });
  const { data: disputesData } = useQuery<{ disputes: DisputeRow[]; total: number; total_ouvert: number; total_resolu: number; montant_recupere: number }>({
    queryKey: ["/api/legal/disputes"],
    queryFn: () => apiRequest("GET", "/api/legal/disputes").then(r => r.json()),
  });

  const [template, setTemplate] = useState("paiement_manquant");
  const [plateforme, setPlateforme] = useState("Uber");
  const [nomChauffeur, setNomChauffeur] = useState("");
  const [montantIncident, setMontantIncident] = useState("");
  const [dateIncident, setDateIncident] = useState("");
  const [details, setDetails] = useState("");
  const [genResult, setGenResult] = useState<DisputeTemplateResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [showLogForm, setShowLogForm] = useState(false);

  async function generateTemplate() {
    if (!nomChauffeur.trim()) return;
    setLoading(true);
    try {
      const res = await apiRequest("POST", "/api/legal/dispute-templates", {
        template,
        plateforme,
        nom_chauffeur: nomChauffeur,
        montant: montantIncident ? Number(montantIncident) : undefined,
        date_incident: dateIncident || undefined,
        details: details || undefined,
      });
      setGenResult(await res.json());
    } finally {
      setLoading(false);
    }
  }

  async function logDispute() {
    await apiRequest("POST", "/api/legal/disputes", {
      plateforme,
      type: template,
      montant: montantIncident ? Number(montantIncident) : 0,
      status: "ouvert",
    });
    qc.invalidateQueries({ queryKey: ["/api/legal/disputes"] });
    setShowLogForm(false);
  }

  async function updateStatus(id: number, status: string) {
    await apiRequest("PATCH", `/api/legal/disputes/${id}`, { status });
    qc.invalidateQueries({ queryKey: ["/api/legal/disputes"] });
  }

  return (
    <SectionCard icon={Gavel} title="Litiges plateformes" subtitle="Templates de réclamation + suivi de vos litiges">
      <div>
        <label className="block text-xs text-muted-foreground mb-1">Type de litige</label>
        <select value={template} onChange={(e) => setTemplate(e.target.value)}
          className="w-full min-h-[44px] px-3 rounded-lg border border-border bg-background text-sm" data-testid="select-dispute-template">
          {(templatesData?.templates || []).map(t => <option key={t.key} value={t.key}>{t.label_fr}</option>)}
        </select>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <select value={plateforme} onChange={(e) => setPlateforme(e.target.value)}
          className="min-h-[44px] px-3 rounded-lg border border-border bg-background text-sm" data-testid="select-dispute-plateforme">
          <option>Uber</option>
          <option>Bolt</option>
          <option>Heetch</option>
          <option>FreeNow</option>
        </select>
        <input type="text" value={nomChauffeur} onChange={(e) => setNomChauffeur(e.target.value)} placeholder="Votre nom *"
          className="min-h-[44px] px-3 rounded-lg border border-border bg-background text-sm" data-testid="input-dispute-nom" />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <input type="number" value={montantIncident} onChange={(e) => setMontantIncident(e.target.value)} placeholder="Montant concerné (€)"
          className="min-h-[44px] px-3 rounded-lg border border-border bg-background text-sm" data-testid="input-dispute-montant" />
        <input type="date" value={dateIncident} onChange={(e) => setDateIncident(e.target.value)}
          className="min-h-[44px] px-3 rounded-lg border border-border bg-background text-sm" data-testid="input-dispute-date" />
      </div>
      <textarea value={details} onChange={(e) => setDetails(e.target.value)} placeholder="Détails de l'incident (optionnel)"
        className="w-full min-h-[60px] px-3 py-2 rounded-lg border border-border bg-background text-sm" data-testid="textarea-dispute-details" />

      <div className="flex gap-2">
        <button
          onClick={generateTemplate}
          disabled={loading || !nomChauffeur.trim()}
          className="flex-1 min-h-[48px] rounded-lg bg-primary text-primary-foreground font-medium text-sm flex items-center justify-center gap-2 disabled:opacity-60"
          data-testid="button-generate-dispute"
        >
          {loading ? <Loader2 size={16} className="animate-spin" /> : <Gavel size={16} />}
          Générer la réclamation
        </button>
        <button
          onClick={logDispute}
          className="min-h-[48px] px-3 rounded-lg bg-background/60 border border-border font-medium text-sm flex items-center gap-1"
          data-testid="button-log-dispute"
        >
          <Plus size={16} /> Suivre
        </button>
      </div>

      {genResult && (
        <div className="space-y-2 pt-2 border-t border-border">
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold">{genResult.title}</p>
            <button onClick={() => copyToClipboard(genResult.body)} className="text-xs text-primary flex items-center gap-1" data-testid="button-copy-dispute">
              <Copy size={12} /> Copier
            </button>
          </div>
          <pre className="text-xs whitespace-pre-wrap bg-background/60 rounded-lg p-3 max-h-64 overflow-y-auto font-sans">{genResult.body}</pre>
          <div className="text-[11px] text-muted-foreground">
            <p className="font-semibold">Base légale :</p>
            <ul className="list-disc list-inside">
              {genResult.base_legale.map((b, i) => <li key={i}>{b}</li>)}
            </ul>
          </div>
        </div>
      )}

      <div className="pt-2 border-t border-border space-y-2">
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>{disputesData?.total_ouvert ?? 0} ouvert(s) · {disputesData?.total_resolu ?? 0} résolu(s)</span>
          <span className="font-semibold text-green-600">{(disputesData?.montant_recupere ?? 0).toLocaleString("fr-FR")} € récupérés</span>
        </div>
        <div className="space-y-1.5 max-h-56 overflow-y-auto">
          {(disputesData?.disputes || []).map((d) => (
            <div key={d.id} className="flex items-center justify-between p-2 rounded-lg bg-background/60" data-testid={`dispute-row-${d.id}`}>
              <div className="min-w-0">
                <p className="text-xs font-medium">{d.plateforme} — {d.type.replace(/_/g, " ")}</p>
                <p className="text-[10px] text-muted-foreground">{d.montant.toLocaleString("fr-FR")} € · {new Date(d.ts).toLocaleDateString("fr-FR")}</p>
              </div>
              <select
                value={d.status}
                onChange={(e) => updateStatus(d.id, e.target.value)}
                className="text-xs px-2 py-1 rounded-md border border-border bg-background"
                data-testid={`dispute-status-${d.id}`}
              >
                <option value="ouvert">Ouvert</option>
                <option value="resolu">Résolu</option>
                <option value="perdu">Perdu</option>
              </select>
            </div>
          ))}
        </div>
      </div>
    </SectionCard>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// 11. FORMATION CONTINUE 5 ANS
// ═══════════════════════════════════════════════════════════════════════════
interface FormationStatus {
  heures_obligatoires: number;
  periode_annees: number;
  echeance_renouvellement: string | null;
  jours_restants: number | null;
  urgency: string;
  formateurs_agrees_idf: { nom: string; ville: string; contact_url: string; duree_h: number }[];
  message_fr: string;
}

const URGENCY_COLOR: Record<string, string> = { ok: "#22c55e", soon: "#f59e0b", urgent: "#f97316", overdue: "#ef4444", non_renseigne: "#94a3b8" };

function FormationContinueSection() {
  const [dateCarte, setDateCarte] = useState("");
  const { data, refetch } = useQuery<FormationStatus>({
    queryKey: ["/api/legal/formation-continue", dateCarte],
    queryFn: () => apiRequest("GET", `/api/legal/formation-continue${dateCarte ? `?date_obtention_carte=${dateCarte}` : ""}`).then(r => r.json()),
  });

  return (
    <SectionCard icon={GraduationCap} title="Formation continue (5 ans)" subtitle="14h obligatoires — rappel et formateurs agréés IDF">
      <div>
        <label className="block text-xs text-muted-foreground mb-1">Date d'obtention de votre carte VTC</label>
        <div className="flex gap-2">
          <input type="date" value={dateCarte} onChange={(e) => setDateCarte(e.target.value)}
            className="flex-1 min-h-[44px] px-3 rounded-lg border border-border bg-background text-sm" data-testid="input-date-carte-vtc" />
          <button onClick={() => refetch()} className="min-h-[44px] px-3 rounded-lg bg-primary text-primary-foreground text-sm" data-testid="button-check-formation">
            Vérifier
          </button>
        </div>
      </div>

      {data && (
        <>
          <div className="flex items-center justify-between bg-background/60 rounded-lg p-3">
            <div>
              <p className="text-[10px] text-muted-foreground">Échéance de renouvellement</p>
              <p className="text-sm font-semibold">{data.echeance_renouvellement ? new Date(data.echeance_renouvellement).toLocaleDateString("fr-FR") : "Non renseignée"}</p>
            </div>
            <span className="text-xs font-semibold px-2 py-1 rounded-full" style={{ background: `${URGENCY_COLOR[data.urgency]}22`, color: URGENCY_COLOR[data.urgency] }}>
              {data.jours_restants !== null ? `${data.jours_restants} j` : "—"}
            </span>
          </div>
          <p className="text-xs text-muted-foreground leading-relaxed">{data.message_fr}</p>

          <div>
            <p className="text-xs text-muted-foreground mb-1.5">Formateurs agréés en Île-de-France :</p>
            <div className="space-y-1.5">
              {data.formateurs_agrees_idf.map((f) => (
                <a
                  key={f.nom}
                  href={f.contact_url}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center justify-between p-2.5 rounded-lg bg-background/60 hover:bg-accent transition-colors"
                  data-testid={`formateur-${f.nom.replace(/\s+/g, "-").toLowerCase()}`}
                >
                  <div>
                    <p className="text-xs font-medium">{f.nom}</p>
                    <p className="text-[10px] text-muted-foreground">{f.ville} · {f.duree_h}h</p>
                  </div>
                  <ExternalLink size={14} className="text-muted-foreground" />
                </a>
              ))}
            </div>
          </div>
        </>
      )}
    </SectionCard>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// 12. SIMULATEUR RETRAITE CIPAV
// ═══════════════════════════════════════════════════════════════════════════
interface CipavResult {
  regime_probable: string;
  points_estimes: number;
  pension_annuelle_estimee: number;
  pension_mensuelle_estimee: number;
  annees_restantes: number;
  ca_cumule_estime: number;
  message_fr: string;
  avertissement_fr: string;
}

function CipavSimulatorSection() {
  const [caAnnuel, setCaAnnuel] = useState("30000");
  const [anneesCotisees, setAnneesCotisees] = useState("0");
  const [ageActuel, setAgeActuel] = useState("35");
  const [ageDepart, setAgeDepart] = useState("64");
  const [statutFiscal, setStatutFiscal] = useState("micro-bnc");
  const [result, setResult] = useState<CipavResult | null>(null);
  const [loading, setLoading] = useState(false);

  async function simulate() {
    setLoading(true);
    try {
      const res = await apiRequest("POST", "/api/legal/retirement-cipav-simulator", {
        ca_annuel_moyen: Number(caAnnuel) || 0,
        nombre_annees_cotisees: Number(anneesCotisees) || 0,
        age_actuel: Number(ageActuel) || 30,
        age_depart_souhaite: Number(ageDepart) || 64,
        statut_fiscal: statutFiscal,
      });
      setResult(await res.json());
    } finally {
      setLoading(false);
    }
  }

  return (
    <SectionCard icon={PiggyBank} title="Simulateur retraite CIPAV" subtitle="Pension future estimée selon votre CA cumulé">
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="block text-xs text-muted-foreground mb-1">CA annuel moyen (€)</label>
          <input type="number" value={caAnnuel} onChange={(e) => setCaAnnuel(e.target.value)}
            className="w-full min-h-[44px] px-3 rounded-lg border border-border bg-background text-sm" data-testid="input-cipav-ca" />
        </div>
        <div>
          <label className="block text-xs text-muted-foreground mb-1">Années déjà cotisées</label>
          <input type="number" value={anneesCotisees} onChange={(e) => setAnneesCotisees(e.target.value)}
            className="w-full min-h-[44px] px-3 rounded-lg border border-border bg-background text-sm" data-testid="input-cipav-annees" />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="block text-xs text-muted-foreground mb-1">Âge actuel</label>
          <input type="number" value={ageActuel} onChange={(e) => setAgeActuel(e.target.value)}
            className="w-full min-h-[44px] px-3 rounded-lg border border-border bg-background text-sm" data-testid="input-cipav-age" />
        </div>
        <div>
          <label className="block text-xs text-muted-foreground mb-1">Âge de départ souhaité</label>
          <input type="number" value={ageDepart} onChange={(e) => setAgeDepart(e.target.value)}
            className="w-full min-h-[44px] px-3 rounded-lg border border-border bg-background text-sm" data-testid="input-cipav-age-depart" />
        </div>
      </div>
      <div>
        <label className="block text-xs text-muted-foreground mb-1">Statut fiscal</label>
        <select value={statutFiscal} onChange={(e) => setStatutFiscal(e.target.value)}
          className="w-full min-h-[44px] px-3 rounded-lg border border-border bg-background text-sm" data-testid="select-cipav-statut">
          <option value="micro-bnc">Micro-BNC (CIPAV)</option>
          <option value="micro-bic">Micro-BIC (SSI)</option>
        </select>
      </div>
      <button
        onClick={simulate}
        disabled={loading}
        className="w-full min-h-[48px] rounded-lg bg-primary text-primary-foreground font-medium text-sm flex items-center justify-center gap-2 disabled:opacity-60"
        data-testid="button-simulate-cipav"
      >
        {loading ? <Loader2 size={16} className="animate-spin" /> : <PiggyBank size={16} />}
        Simuler ma retraite
      </button>

      {result && (
        <div className="space-y-2 pt-2 border-t border-border">
          <div className="grid grid-cols-2 gap-2">
            <div className="bg-background/60 rounded-lg p-2.5">
              <p className="text-[10px] text-muted-foreground">Pension mensuelle estimée</p>
              <p className="text-sm font-semibold tabular-nums">{result.pension_mensuelle_estimee.toLocaleString("fr-FR")} €</p>
            </div>
            <div className="bg-background/60 rounded-lg p-2.5">
              <p className="text-[10px] text-muted-foreground">Régime probable</p>
              <p className="text-sm font-semibold">{result.regime_probable}</p>
            </div>
          </div>
          <p className="text-xs text-muted-foreground leading-relaxed">{result.message_fr}</p>
          <p className="text-[11px] text-muted-foreground italic">{result.avertissement_fr}</p>
        </div>
      )}
    </SectionCard>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// PAGE PRINCIPALE
// ═══════════════════════════════════════════════════════════════════════════
export default function LegalPage() {
  return (
    <div className="p-3 sm:p-4 space-y-4 pb-24 max-w-2xl mx-auto">
      <div className="flex items-center gap-2">
        <div className="p-2 rounded-xl bg-primary/10 text-primary">
          <Scale size={20} />
        </div>
        <div>
          <h1 className="text-lg font-bold">Juridique VTC</h1>
          <p className="text-xs text-muted-foreground">FAQ, contrats, réglementation 2026, litiges et retraite CIPAV</p>
        </div>
      </div>

      <FaqSection />
      <ContractGeneratorSection />
      <LegalRulesSection />
      <DisputesSection />
      <FormationContinueSection />
      <CipavSimulatorSection />
    </div>
  );
}
