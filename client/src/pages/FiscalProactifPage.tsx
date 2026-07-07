/**
 * FiscalProactifPage — Couche FISCAL PROACTIF (rapport.md §5, §6, §18)
 * ─────────────────────────────────────────────────────────────────────────────
 * Page additive regroupant les leviers de fiscalité proactive et de coûts
 * cachés véhicule :
 *   - Provisionnement du jour (URSSAF/TVA/IR)
 *   - Jauge seuil TVA (progression annuelle + alerte 80/90/100%)
 *   - Notes de frais (liste + ajout rapide + total mensuel)
 *   - Entretien véhicule (planning km + prochaine échéance)
 *   - Échéances administratives (URSSAF/TVA/CFE/carte pro/CT/assurance)
 *   - Simulateur ACRE (économies si éligible)
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import {
  Receipt,
  Calendar,
  Wrench,
  AlertTriangle,
  PiggyBank,
  Gauge,
  Plus,
  X,
  Loader2,
  CheckCircle2,
  Car,
  IdCard,
  ShieldCheck,
  BadgeCheck,
} from "lucide-react";

// ─── Types ───────────────────────────────────────────────────────────────────
interface DailyProvision {
  date: string;
  ca_jour: number;
  urssaf_provision: number;
  tva_provision: number;
  ir_provision: number;
  total_provision: number;
  pct_total: number;
  message_fr: string;
}

interface TvaThresholdForecast {
  ca_ytd: number;
  ca_projected_year_end: number;
  seuil_base: number;
  seuil_majore: number;
  pct_seuil_base: number;
  alert_level: "ok" | "80" | "90" | "100" | "depasse_majore";
  message_fr: string;
}

interface ExpenseRow {
  id: number;
  date: string;
  category: string;
  label: string;
  amount_eur: number;
  km: number | null;
  deductible: number;
}

interface ExpensesData {
  rows: ExpenseRow[];
  total_month_eur: number;
  by_category: Record<string, number>;
}

interface MaintenanceItem {
  component: string;
  label_fr: string;
  urgency: "ok" | "soon" | "urgent" | "overdue";
  estimated_cost_eur: number;
  next_due_label_fr: string;
}

interface PreventiveMaintenanceData {
  items: MaintenanceItem[];
  prochaine_echeance: MaintenanceItem | null;
}

interface UpcomingDeadline {
  id: number;
  type: string;
  label_fr: string;
  due_date_fr: string;
  jours_restants: number;
  urgency: "ok" | "soon" | "urgent" | "overdue";
}

interface AcreSimulation {
  eligible: boolean;
  raison_fr: string;
  taux_normal_pct: number;
  taux_acre_pct: number;
  economie_annuelle_estimee: number;
  fin_periode_acre: string | null;
  mois_restants_acre: number;
}

interface ProfessionalCardStatus {
  carte_pro_expiry: string | null;
  jours_restants: number | null;
  urgency: "ok" | "soon" | "urgent" | "overdue" | "non_renseigne";
  message_fr: string;
}

interface ControleTechniqueStatus {
  prochaine_echeance: string | null;
  jours_restants: number | null;
  urgency: "ok" | "soon" | "urgent" | "overdue" | "non_renseigne";
  message_fr: string;
}

interface AssuranceRcStatus {
  expiry: string | null;
  jours_restants: number | null;
  urgency: "ok" | "soon" | "urgent" | "overdue" | "non_renseigne";
  message_fr: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
const CATEGORIES: { key: string; label: string }[] = [
  { key: "carburant", label: "Carburant" },
  { key: "peage", label: "Péage" },
  { key: "entretien", label: "Entretien" },
  { key: "assurance", label: "Assurance" },
  { key: "telepeage", label: "Télépéage" },
  { key: "kilometrage", label: "Kilométrage (IK)" },
  { key: "autre", label: "Autre" },
];

const URGENCY_COLOR: Record<string, string> = {
  ok: "#22c55e",
  soon: "#f59e0b",
  urgent: "#f97316",
  overdue: "#ef4444",
  non_renseigne: "#94a3b8",
};

const URGENCY_LABEL: Record<string, string> = {
  ok: "OK",
  soon: "Bientôt",
  urgent: "Urgent",
  overdue: "Dépassé",
  non_renseigne: "Non renseigné",
};

function frDate(dateStr: string): string {
  const [y, m, d] = dateStr.split("-");
  if (!y || !m || !d) return dateStr;
  return `${d}/${m}/${y}`;
}

// ─── Sous-composants ────────────────────────────────────────────────────────

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

function ProvisioningSection() {
  const { data, isLoading } = useQuery<DailyProvision>({
    queryKey: ["/api/tax/daily-provision"],
    queryFn: () => apiRequest("GET", "/api/tax/daily-provision").then((r) => r.json()),
  });

  return (
    <SectionCard icon={PiggyBank} title="Provisionnement du jour" subtitle="Montants à mettre de côté aujourd'hui">
      {isLoading || !data ? (
        <div className="h-20 rounded-lg bg-muted/40 animate-pulse" />
      ) : (
        <>
          <div className="grid grid-cols-3 gap-2">
            <div className="bg-background/60 rounded-lg p-2.5">
              <p className="text-[10px] text-muted-foreground">URSSAF</p>
              <p className="text-sm font-semibold tabular-nums">{data.urssaf_provision.toFixed(0)} €</p>
            </div>
            <div className="bg-background/60 rounded-lg p-2.5">
              <p className="text-[10px] text-muted-foreground">TVA</p>
              <p className="text-sm font-semibold tabular-nums">{data.tva_provision.toFixed(0)} €</p>
            </div>
            <div className="bg-background/60 rounded-lg p-2.5">
              <p className="text-[10px] text-muted-foreground">IR</p>
              <p className="text-sm font-semibold tabular-nums">{data.ir_provision.toFixed(0)} €</p>
            </div>
          </div>
          <div className="flex items-center justify-between bg-primary/10 rounded-lg p-3">
            <span className="text-xs text-muted-foreground">Total à provisionner</span>
            <span className="text-lg font-bold text-primary tabular-nums">{data.total_provision.toFixed(0)} €</span>
          </div>
          <p className="text-xs text-muted-foreground leading-relaxed">{data.message_fr}</p>
        </>
      )}
    </SectionCard>
  );
}

function TvaThresholdSection() {
  const { data, isLoading } = useQuery<TvaThresholdForecast>({
    queryKey: ["/api/tax/tva-threshold-forecast"],
    queryFn: () => apiRequest("GET", "/api/tax/tva-threshold-forecast").then((r) => r.json()),
  });

  if (isLoading || !data) {
    return (
      <SectionCard icon={Gauge} title="Seuil TVA" subtitle="Progression du CA annuel">
        <div className="h-20 rounded-lg bg-muted/40 animate-pulse" />
      </SectionCard>
    );
  }

  const ratio = Math.min(100, data.pct_seuil_base);
  const color = data.alert_level === "depasse_majore" || data.alert_level === "100"
    ? "#ef4444"
    : data.alert_level === "90"
      ? "#f97316"
      : data.alert_level === "80"
        ? "#f59e0b"
        : "#22c55e";

  return (
    <SectionCard icon={Gauge} title="Seuil TVA" subtitle="Franchise en base — progression annuelle">
      <div className="h-3 rounded-full bg-muted overflow-hidden">
        <div className="h-full rounded-full transition-all" style={{ width: `${ratio}%`, background: color }} />
      </div>
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>CA : {data.ca_ytd.toFixed(0)} € / {data.seuil_base.toFixed(0)} €</span>
        <span className="font-semibold" style={{ color }}>{data.pct_seuil_base.toFixed(0)}%</span>
      </div>
      <div className="bg-background/60 rounded-lg p-2.5">
        <p className="text-[10px] text-muted-foreground">Projection fin d'année</p>
        <p className="text-sm font-semibold tabular-nums">{data.ca_projected_year_end.toFixed(0)} €</p>
      </div>
      <p className="text-xs text-muted-foreground leading-relaxed">{data.message_fr}</p>
    </SectionCard>
  );
}

function AddExpenseDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const [category, setCategory] = useState("carburant");
  const [amount, setAmount] = useState("");
  const [km, setKm] = useState("");
  const [label, setLabel] = useState("");
  const [saving, setSaving] = useState(false);

  if (!open) return null;

  const isKm = category === "kilometrage";

  async function submit() {
    setSaving(true);
    try {
      await apiRequest("POST", "/api/expenses", {
        category,
        label,
        amount_eur: isKm ? undefined : Number(amount) || 0,
        km: isKm ? Number(km) || 0 : undefined,
      });
      setAmount("");
      setKm("");
      setLabel("");
      onCreated();
      onClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 p-3" onClick={onClose}>
      <div className="bg-card border border-border rounded-2xl max-w-md w-full p-4 space-y-3" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-sm flex items-center gap-2">
            <Receipt size={16} className="text-primary" /> Nouvelle dépense
          </h3>
          <button onClick={onClose} aria-label="Fermer"><X size={16} className="text-muted-foreground" /></button>
        </div>

        <label className="block text-xs text-muted-foreground">Catégorie</label>
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          className="w-full min-h-[44px] px-3 rounded-lg border border-border bg-background text-sm"
          data-testid="select-expense-category"
        >
          {CATEGORIES.map((c) => (
            <option key={c.key} value={c.key}>{c.label}</option>
          ))}
        </select>

        <label className="block text-xs text-muted-foreground">Libellé (optionnel)</label>
        <input
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          className="w-full min-h-[44px] px-3 rounded-lg border border-border bg-background text-sm"
          placeholder="Ex : Station Total A1"
          data-testid="input-expense-label"
        />

        {isKm ? (
          <>
            <label className="block text-xs text-muted-foreground">Kilomètres parcourus</label>
            <input
              type="number"
              value={km}
              onChange={(e) => setKm(e.target.value)}
              className="w-full min-h-[44px] px-3 rounded-lg border border-border bg-background text-sm"
              placeholder="Ex : 120"
              data-testid="input-expense-km"
            />
            <p className="text-xs text-muted-foreground">Montant calculé automatiquement via le barème IK 2026.</p>
          </>
        ) : (
          <>
            <label className="block text-xs text-muted-foreground">Montant (€)</label>
            <input
              type="number"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="w-full min-h-[44px] px-3 rounded-lg border border-border bg-background text-sm"
              placeholder="Ex : 45.20"
              data-testid="input-expense-amount"
            />
          </>
        )}

        <button
          onClick={submit}
          disabled={saving}
          className="w-full min-h-[48px] rounded-lg bg-primary text-primary-foreground font-medium text-sm flex items-center justify-center gap-2 disabled:opacity-60"
          data-testid="button-save-expense"
        >
          {saving ? <Loader2 size={16} className="animate-spin" /> : <Plus size={16} />}
          <span>Enregistrer</span>
        </button>
      </div>
    </div>
  );
}

function ExpensesSection() {
  const qc = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const { data, isLoading } = useQuery<ExpensesData>({
    queryKey: ["/api/expenses"],
    queryFn: () => apiRequest("GET", "/api/expenses").then((r) => r.json()),
  });

  return (
    <SectionCard icon={Receipt} title="Notes de frais" subtitle="Dépenses déductibles du mois en cours">
      <div className="flex items-center justify-between bg-background/60 rounded-lg p-3">
        <span className="text-xs text-muted-foreground">Total du mois</span>
        <span className="text-lg font-bold text-primary tabular-nums">
          {isLoading || !data ? "—" : `${data.total_month_eur.toFixed(0)} €`}
        </span>
      </div>

      <button
        onClick={() => setDialogOpen(true)}
        className="w-full min-h-[48px] rounded-lg border border-primary/40 bg-primary/10 text-primary font-medium text-sm flex items-center justify-center gap-2"
        data-testid="button-add-expense"
      >
        <Plus size={16} /> Ajouter une dépense
      </button>

      {isLoading ? (
        <div className="h-16 rounded-lg bg-muted/40 animate-pulse" />
      ) : data && data.rows.length > 0 ? (
        <div className="space-y-1.5 max-h-64 overflow-auto">
          {data.rows.slice(0, 15).map((row) => (
            <div key={row.id} className="flex items-center justify-between text-xs bg-background/40 rounded-lg px-3 py-2">
              <div className="min-w-0">
                <p className="font-medium truncate">{CATEGORIES.find((c) => c.key === row.category)?.label ?? row.category}</p>
                <p className="text-muted-foreground">{frDate(row.date)}{row.label ? ` · ${row.label}` : ""}{row.km ? ` · ${row.km} km` : ""}</p>
              </div>
              <span className="font-semibold tabular-nums shrink-0 ml-2">{row.amount_eur.toFixed(2)} €</span>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground text-center py-2">Aucune dépense enregistrée ce mois-ci.</p>
      )}

      <AddExpenseDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onCreated={() => qc.invalidateQueries({ queryKey: ["/api/expenses"] })}
      />
    </SectionCard>
  );
}

function MaintenanceSection() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<PreventiveMaintenanceData>({
    queryKey: ["/api/maintenance/preventive"],
    queryFn: () => apiRequest("GET", "/api/maintenance/preventive").then((r) => r.json()),
  });

  async function markDone(component: string) {
    await apiRequest("PUT", `/api/maintenance/preventive/${component}/done`);
    qc.invalidateQueries({ queryKey: ["/api/maintenance/preventive"] });
  }

  return (
    <SectionCard icon={Wrench} title="Entretien véhicule" subtitle="Planning kilométrique et rappels">
      {isLoading || !data ? (
        <div className="h-24 rounded-lg bg-muted/40 animate-pulse" />
      ) : (
        <>
          {data.prochaine_echeance && (
            <div
              className="rounded-lg p-3 flex items-center justify-between"
              style={{ background: `${URGENCY_COLOR[data.prochaine_echeance.urgency]}22` }}
            >
              <div>
                <p className="text-xs text-muted-foreground">Prochaine échéance</p>
                <p className="text-sm font-semibold">{data.prochaine_echeance.label_fr}</p>
              </div>
              <span
                className="text-xs font-semibold px-2 py-0.5 rounded-full"
                style={{ color: URGENCY_COLOR[data.prochaine_echeance.urgency] }}
              >
                {data.prochaine_echeance.next_due_label_fr}
              </span>
            </div>
          )}
          <div className="space-y-1.5">
            {data.items.map((item) => (
              <div key={item.component} className="flex items-center justify-between text-xs bg-background/40 rounded-lg px-3 py-2">
                <div className="min-w-0 flex items-center gap-2">
                  <span
                    className="w-2 h-2 rounded-full shrink-0"
                    style={{ background: URGENCY_COLOR[item.urgency] }}
                  />
                  <div>
                    <p className="font-medium">{item.label_fr}</p>
                    <p className="text-muted-foreground">{item.next_due_label_fr} · ~{item.estimated_cost_eur.toFixed(0)} €</p>
                  </div>
                </div>
                <button
                  onClick={() => markDone(item.component)}
                  className="p-1.5 rounded-md hover:bg-accent text-muted-foreground hover:text-primary shrink-0"
                  aria-label={`Marquer ${item.label_fr} comme fait`}
                  data-testid={`button-maintenance-done-${item.component}`}
                >
                  <CheckCircle2 size={16} />
                </button>
              </div>
            ))}
          </div>
        </>
      )}
    </SectionCard>
  );
}

function DeadlinesSection() {
  const { data, isLoading } = useQuery<{ deadlines: UpcomingDeadline[] }>({
    queryKey: ["/api/admin/deadlines"],
    queryFn: () => apiRequest("GET", "/api/admin/deadlines").then((r) => r.json()),
  });
  const { data: card } = useQuery<ProfessionalCardStatus>({
    queryKey: ["/api/admin/professional-card"],
    queryFn: () => apiRequest("GET", "/api/admin/professional-card").then((r) => r.json()),
  });
  const { data: ct } = useQuery<ControleTechniqueStatus>({
    queryKey: ["/api/admin/controle-technique"],
    queryFn: () => apiRequest("GET", "/api/admin/controle-technique").then((r) => r.json()),
  });
  const { data: rc } = useQuery<AssuranceRcStatus>({
    queryKey: ["/api/admin/assurance-rc"],
    queryFn: () => apiRequest("GET", "/api/admin/assurance-rc").then((r) => r.json()),
  });

  return (
    <SectionCard icon={Calendar} title="Échéances administratives" subtitle="URSSAF, TVA, CFE, carte pro, contrôle technique, assurance">
      {isLoading || !data ? (
        <div className="h-24 rounded-lg bg-muted/40 animate-pulse" />
      ) : (
        <div className="space-y-1.5 max-h-48 overflow-auto">
          {data.deadlines.slice(0, 8).map((d) => (
            <div key={d.id} className="flex items-center justify-between text-xs bg-background/40 rounded-lg px-3 py-2">
              <div className="min-w-0">
                <p className="font-medium truncate">{d.label_fr}</p>
                <p className="text-muted-foreground">{d.due_date_fr}</p>
              </div>
              <span
                className="text-[10px] font-semibold px-2 py-0.5 rounded-full shrink-0 ml-2"
                style={{ background: `${URGENCY_COLOR[d.urgency]}22`, color: URGENCY_COLOR[d.urgency] }}
              >
                {d.jours_restants >= 0 ? `J-${d.jours_restants}` : "En retard"}
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 gap-2 pt-1">
        {card && (
          <div className="flex items-center gap-2 text-xs bg-background/60 rounded-lg p-2.5">
            <IdCard size={14} style={{ color: URGENCY_COLOR[card.urgency] }} className="shrink-0" />
            <span className="text-muted-foreground leading-snug">{card.message_fr}</span>
          </div>
        )}
        {ct && (
          <div className="flex items-center gap-2 text-xs bg-background/60 rounded-lg p-2.5">
            <Car size={14} style={{ color: URGENCY_COLOR[ct.urgency] }} className="shrink-0" />
            <span className="text-muted-foreground leading-snug">{ct.message_fr}</span>
          </div>
        )}
        {rc && (
          <div className="flex items-center gap-2 text-xs bg-background/60 rounded-lg p-2.5">
            <ShieldCheck size={14} style={{ color: URGENCY_COLOR[rc.urgency] }} className="shrink-0" />
            <span className="text-muted-foreground leading-snug">{rc.message_fr}</span>
          </div>
        )}
      </div>
    </SectionCard>
  );
}

function AcreSection() {
  const { data, isLoading } = useQuery<AcreSimulation>({
    queryKey: ["/api/tax/acre-simulator"],
    queryFn: () => apiRequest("GET", "/api/tax/acre-simulator").then((r) => r.json()),
  });

  return (
    <SectionCard icon={BadgeCheck} title="Simulateur ACRE" subtitle="Économies si éligible à la réduction de cotisations">
      {isLoading || !data ? (
        <div className="h-20 rounded-lg bg-muted/40 animate-pulse" />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2">
            <div className="bg-background/60 rounded-lg p-2.5">
              <p className="text-[10px] text-muted-foreground">Taux normal</p>
              <p className="text-sm font-semibold tabular-nums">{data.taux_normal_pct.toFixed(1)} %</p>
            </div>
            <div className="bg-background/60 rounded-lg p-2.5">
              <p className="text-[10px] text-muted-foreground">Taux ACRE</p>
              <p className="text-sm font-semibold tabular-nums text-primary">{data.taux_acre_pct.toFixed(1)} %</p>
            </div>
          </div>
          <div className="flex items-center justify-between bg-primary/10 rounded-lg p-3">
            <span className="text-xs text-muted-foreground">Économie annuelle estimée</span>
            <span className="text-lg font-bold text-primary tabular-nums">
              {data.economie_annuelle_estimee.toFixed(0)} €
            </span>
          </div>
          <p className="text-xs text-muted-foreground leading-relaxed">{data.raison_fr}</p>
        </>
      )}
    </SectionCard>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────
export default function FiscalProactifPage() {
  return (
    <div className="min-h-full bg-background px-4 py-6 pb-24">
      <div className="max-w-md mx-auto space-y-6">
        <header className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-primary/10 text-primary">
            <AlertTriangle size={22} />
          </div>
          <div>
            <h1 className="text-lg font-semibold">Fiscal proactif</h1>
            <p className="text-xs text-muted-foreground">
              Anticipez URSSAF, TVA, entretien et échéances administratives
            </p>
          </div>
        </header>

        <ProvisioningSection />
        <TvaThresholdSection />
        <ExpensesSection />
        <MaintenanceSection />
        <DeadlinesSection />
        <AcreSection />

        <p className="text-xs text-muted-foreground leading-relaxed px-1">
          Estimations indicatives basées sur les barèmes fiscaux et sociaux 2026 (URSSAF, TVA,
          barème IK). Ne remplacent pas l'avis d'un expert-comptable.
        </p>
      </div>
    </div>
  );
}
