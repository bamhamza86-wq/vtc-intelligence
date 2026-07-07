/**
 * FocusAIBanner.tsx — Couche ML Personnel
 * ─────────────────────────────────────────────────────────────────────────────
 * Bannière sobre affichée en haut de Focus/Reco quand le chauffeur a activé
 * « pas d'IA aujourd'hui ». Permet de réactiver l'IA en un tap et enregistre
 * le résultat net de la journée pour comparaison a posteriori.
 */
import { useEffect, useState } from "react";
import { BrainCircuit, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { apiRequest } from "@/lib/queryClient";
import { isAiDisabledToday, disableAiDisabledToday } from "@/lib/aiToggle";
import { useToast } from "@/hooks/use-toast";

export function FocusAIBanner() {
  const [active, setActive] = useState(isAiDisabledToday());
  const { toast } = useToast();

  useEffect(() => {
    const check = () => setActive(isAiDisabledToday());
    check();
    window.addEventListener("storage", check);
    const interval = setInterval(check, 60_000); // vérifie le changement de jour (minuit)
    return () => {
      window.removeEventListener("storage", check);
      clearInterval(interval);
    };
  }, []);

  if (!active) return null;

  const handleReenable = async () => {
    // Récupère le net du jour pour la comparaison a posteriori, best-effort.
    try {
      const stats = await apiRequest("GET", "/api/rides/stats").then((r) => r.json());
      const net = stats?.today?.netProfit ?? stats?.netProfit ?? null;
      await apiRequest("POST", "/api/ml/ai-disabled-log", {
        date: new Date().toISOString().slice(0, 10),
        net_profit_that_day: typeof net === "number" ? net : 0,
      });
    } catch {
      // best-effort — ne bloque pas la réactivation
    }
    disableAiDisabledToday();
    setActive(false);
    toast({ title: "IA réactivée", description: "Les suggestions personnalisées sont de retour." });
  };

  return (
    <div
      className="rounded-2xl border border-slate-600/40 bg-slate-800/60 px-4 py-3 flex items-center gap-3"
      data-testid="banner-ai-disabled"
    >
      <BrainCircuit className="w-4 h-4 text-slate-400 shrink-0" />
      <div className="flex-1 min-w-0 text-sm text-slate-300">
        Mode sans IA activé pour aujourd'hui — décisions 100% manuelles.
      </div>
      <Button size="sm" variant="ghost" className="text-xs h-8 px-2 text-slate-300" onClick={handleReenable} data-testid="button-reenable-ai">
        <X className="w-3.5 h-3.5 mr-1" />
        Réactiver
      </Button>
    </div>
  );
}
