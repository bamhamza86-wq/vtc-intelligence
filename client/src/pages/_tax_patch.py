path = "client/src/pages/TaxJournalPage.tsx"
with open(path, "r", encoding="utf-8") as f:
    content = f.read()

# 1. Imports: React hooks/effect, API helper, extra icons
old_imports = '''import { useState } from "react";
import { API_BASE, getAuthToken } from "@/lib/queryClient";
import { Download, FileText, Calendar, Loader2 } from "lucide-react";
import { haptic } from "@/lib/haptics";'''
new_imports = '''import { useState, useEffect, useCallback } from "react";
import { apiRequest, API_BASE, getAuthToken } from "@/lib/queryClient";
import { Download, FileText, Calendar, Loader2, Gauge, Route, Calculator, X } from "lucide-react";
import { haptic } from "@/lib/haptics";'''
assert old_imports in content
content = content.replace(old_imports, new_imports)

# 2. Add types + component for the URSSAF/TVA/IK section and status simulator, before default export
anchor = "export default function TaxJournalPage() {"
new_block = '''// ── Couche Économie & Fiscalité (additif) — URSSAF/TVA/IK + simulateur de statut ──
interface UrssafSummary {
  total_ca: number; cvo_due: number; tva_franchise_threshold: number;
  tva_status: "franchise" | "assujetti" | "proche_seuil";
  remaining_before_tva: number; ik_estimated: number;
}
interface StatusSimulation {
  estimated_savings_or_cost: number; break_even_ca: number; recommendation_fr: string;
}

function TvaGauge({ summary }: { summary: UrssafSummary }) {
  const ratio = summary.tva_franchise_threshold > 0
    ? Math.min(100, (summary.total_ca / summary.tva_franchise_threshold) * 100)
    : 0;
  const cfg = {
    franchise: { color: "#22c55e", label: "Franchise en base" },
    proche_seuil: { color: "#f59e0b", label: "Proche du seuil" },
    assujetti: { color: "#ef4444", label: "Assujetti à la TVA" },
  }[summary.tva_status];
  return (
    <div className="bg-card border border-border rounded-xl p-4 space-y-3">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-2 text-sm font-medium">
          <Gauge size={15} className="text-muted-foreground" /> Seuil de franchise TVA
        </span>
        <span className="text-xs font-semibold px-2 py-0.5 rounded-full" style={{ background: `${cfg.color}22`, color: cfg.color }}>
          {cfg.label}
        </span>
      </div>
      <div className="h-3 rounded-full bg-muted overflow-hidden">
        <div className="h-full rounded-full transition-all" style={{ width: `${ratio}%`, background: cfg.color }} />
      </div>
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>CA : {summary.total_ca.toFixed(0)} € / {summary.tva_franchise_threshold.toFixed(0)} €</span>
        <span>reste {summary.remaining_before_tva.toFixed(0)} €</span>
      </div>
      <div className="grid grid-cols-2 gap-3 pt-1">
        <div className="bg-background/60 rounded-lg p-2.5">
          <p className="text-[10px] text-muted-foreground">Cotisations URSSAF dues</p>
          <p className="text-sm font-semibold tabular-nums">{summary.cvo_due.toFixed(0)} €</p>
        </div>
        <div className="bg-background/60 rounded-lg p-2.5">
          <p className="text-[10px] text-muted-foreground flex items-center gap-1"><Route size={10} />IK estimées (annuel)</p>
          <p className="text-sm font-semibold tabular-nums">{summary.ik_estimated.toFixed(0)} €</p>
        </div>
      </div>
    </div>
  );
}

function StatusSimulatorDialog({ open, onClose, currentCa }: { open: boolean; onClose: () => void; currentCa: number }) {
  const [regime, setRegime] = useState<"micro_bnc" | "ei_reel" | "sasu">("ei_reel");
  const [result, setResult] = useState<StatusSimulation | null>(null);
  const [loading, setLoading] = useState(false);

  const run = useCallback(async () => {
    setLoading(true);
    try {
      const r = await apiRequest("POST", "/api/tax/simulate-status", { new_regime: regime, annual_ca: currentCa });
      setResult(await r.json());
    } catch {
      setResult(null);
    } finally {
      setLoading(false);
    }
  }, [regime, currentCa]);

  useEffect(() => { if (open) run(); }, [open, run]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 p-3" onClick={onClose}>
      <div className="bg-card border border-border rounded-2xl max-w-md w-full p-4 space-y-3" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-sm flex items-center gap-2"><Calculator size={16} className="text-primary" /> Simulateur de changement de statut</h3>
          <button onClick={onClose} aria-label="Fermer"><X size={16} className="text-muted-foreground" /></button>
        </div>
        <div className="flex gap-2">
          {([
            { key: "micro_bnc", label: "Micro-BNC" },
            { key: "ei_reel", label: "EI au réel" },
            { key: "sasu", label: "SASU" },
          ] as const).map((r) => (
            <button
              key={r.key}
              onClick={() => setRegime(r.key)}
              className={`flex-1 text-xs py-2 rounded-lg border ${regime === r.key ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground"}`}
              data-testid={`button-regime-${r.key}`}
            >
              {r.label}
            </button>
          ))}
        </div>
        {loading || !result ? (
          <div className="h-24 rounded-lg bg-muted/40 animate-pulse" />
        ) : (
          <div className="space-y-2">
            <p className="text-sm">{result.recommendation_fr}</p>
            <div className="grid grid-cols-2 gap-2">
              <div className="bg-background/60 rounded-lg p-2.5">
                <p className="text-[10px] text-muted-foreground">Gain/coût estimé</p>
                <p className={`text-sm font-semibold tabular-nums ${result.estimated_savings_or_cost >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                  {result.estimated_savings_or_cost >= 0 ? "+" : ""}{result.estimated_savings_or_cost.toFixed(0)} €/an
                </p>
              </div>
              <div className="bg-background/60 rounded-lg p-2.5">
                <p className="text-[10px] text-muted-foreground">CA de bascule</p>
                <p className="text-sm font-semibold tabular-nums">{result.break_even_ca.toFixed(0)} €</p>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function TaxJournalPage() {'''
assert anchor in content
content = content.replace(anchor, new_block, 1)

with open(path, "w", encoding="utf-8") as f:
    f.write(content)
print("tax patch 1 OK")
