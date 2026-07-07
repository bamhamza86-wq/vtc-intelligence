/**
 * ProactiveTipsCard — Couche Décision Avancée : tip du jour rotatif
 * ─────────────────────────────────────────────────────────────────────────────
 * GET /api/coach/proactive-tips → jusqu'à 3 tips personnalisés (rides + météo
 * + calendrier). Affiche 1 tip à la fois, rotation manuelle (flèche) ou
 * automatique toutes les 12s. Intégré en haut de MapPage et FocusPage.
 */
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { Lightbulb, ChevronRight, MapPin, Clock, CloudSun, Wallet } from "lucide-react";

interface ProactiveTip {
  id: string;
  text_fr: string;
  category: "zone" | "timing" | "meteo" | "economie";
  confidence: number;
}

const CATEGORY_ICON: Record<ProactiveTip["category"], React.ComponentType<{ size?: number; className?: string }>> = {
  zone: MapPin,
  timing: Clock,
  meteo: CloudSun,
  economie: Wallet,
};

async function fetchProactiveTips(): Promise<ProactiveTip[]> {
  const res = await apiRequest("GET", "/api/coach/proactive-tips");
  const data = await res.json();
  return data.tips ?? data;
}

export function ProactiveTipsCard() {
  const { data: tips, isLoading, isError } = useQuery({
    queryKey: ["coach-proactive-tips"],
    queryFn: fetchProactiveTips,
    staleTime: 5 * 60_000,
  });
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (!tips || tips.length <= 1) return;
    const t = setInterval(() => setIndex((i) => (i + 1) % tips.length), 12_000);
    return () => clearInterval(t);
  }, [tips]);

  if (isLoading || isError || !tips || tips.length === 0) return null;

  const tip = tips[index % tips.length];
  const Icon = CATEGORY_ICON[tip.category] ?? Lightbulb;

  return (
    <div
      className="rounded-2xl border border-amber-400/20 bg-gradient-to-r from-amber-500/10 to-slate-900/60 p-3.5 flex items-center gap-3"
      data-testid="proactive-tips-card"
    >
      <div className="shrink-0 w-8 h-8 rounded-full bg-amber-400/15 flex items-center justify-center">
        <Icon size={15} className="text-amber-400" />
      </div>
      <p className="text-xs text-slate-200 leading-snug flex-1" data-testid="proactive-tip-text">
        {tip.text_fr}
      </p>
      {tips.length > 1 && (
        <button
          onClick={() => setIndex((i) => (i + 1) % tips.length)}
          className="tap-target shrink-0 w-9 h-9 rounded-full flex items-center justify-center text-slate-400 hover:text-white active:scale-90 transition-transform"
          aria-label="Tip suivant"
          data-testid="button-next-tip"
        >
          <ChevronRight size={16} />
        </button>
      )}
    </div>
  );
}

export default ProactiveTipsCard;
