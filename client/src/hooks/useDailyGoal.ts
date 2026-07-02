// ──────────────────────────────────────────────────────────────────────────────
// useDailyGoal — Suivi de l'objectif journalier
// ──────────────────────────────────────────────────────────────────────────────
// Récupère le profil conducteur (/api/driver-profile) et les stats de courses
// (/api/rides/stats). Calcule la progression vers l'objectif journalier
// (hourly_target_income × SESSION_HOURS_TARGET).
//
// Si /api/rides/stats n'expose pas de champ gains du jour, tente un calcul
// manuel via /api/rides (filtre sur la date du jour), avec fallback à 0.
// ──────────────────────────────────────────────────────────────────────────────
import { useQuery } from "@tanstack/react-query";
import { useSmartQueryRefresh } from "./useSmartQueryRefresh";
import { useDrivingSession } from "./useDrivingSession";
import { apiRequest } from "@/lib/queryClient";

// ──────────────────────────────────────────────────────────────────────────────
// Constantes
// ──────────────────────────────────────────────────────────────────────────────
const SESSION_HOURS_TARGET = 8;

// ──────────────────────────────────────────────────────────────────────────────
// Types internes
// ──────────────────────────────────────────────────────────────────────────────
interface DriverProfile {
  hourly_target_income: number;
}

interface RideStats {
  totalNetProfit?: number;
  total_net_eur?: number;
  // Autres champs potentiels renvoyés par l'API
  [key: string]: unknown;
}

interface Ride {
  timestamp: string;
  net_profit?: number;
  fare?: number;
  commission?: number;
  fuel_cost?: number;
}

// ──────────────────────────────────────────────────────────────────────────────
// Helper — vérifie si une ISO string correspond à aujourd'hui
// ──────────────────────────────────────────────────────────────────────────────
function isToday(isoString: string): boolean {
  try {
    const d = new Date(isoString);
    const ref = new Date();
    return (
      d.getFullYear() === ref.getFullYear() &&
      d.getMonth() === ref.getMonth() &&
      d.getDate() === ref.getDate()
    );
  } catch {
    return false;
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Extraire les gains du jour depuis les différentes formes de réponse possibles
// ──────────────────────────────────────────────────────────────────────────────
function extractCurrentEuros(stats: RideStats | null | undefined, rides: Ride[] | null | undefined): number {
  // 1. Champ direct totalNetProfit (camelCase) ou total_net_eur (snake_case)
  if (stats) {
    if (typeof stats.totalNetProfit === "number" && stats.totalNetProfit > 0) {
      return stats.totalNetProfit;
    }
    if (typeof stats.total_net_eur === "number" && stats.total_net_eur > 0) {
      return stats.total_net_eur;
    }
  }

  // 2. Calcul manuel sur les courses du jour
  if (Array.isArray(rides)) {
    const todayRides = rides.filter((r) => r.timestamp && isToday(r.timestamp));
    if (todayRides.length > 0) {
      return todayRides.reduce((sum, r) => {
        // Privilégie net_profit s'il existe, sinon fare - commission - fuel_cost
        if (typeof r.net_profit === "number") return sum + r.net_profit;
        const fare = r.fare ?? 0;
        const commission = r.commission ?? 0;
        const fuel = r.fuel_cost ?? 0;
        return sum + (fare - commission - fuel);
      }, 0);
    }
  }

  // 3. Fallback — pas de données disponibles
  return 0;
}

// ──────────────────────────────────────────────────────────────────────────────
// Interface de retour du hook
// ──────────────────────────────────────────────────────────────────────────────
export interface DailyGoalResult {
  goalEuros: number;
  currentEuros: number;
  remainingEuros: number;
  progressPct: number;    // 0–100
  hoursLeftAtCurrentRate: number;
  onTrack: boolean;
}

// ──────────────────────────────────────────────────────────────────────────────
// Hook principal
// ──────────────────────────────────────────────────────────────────────────────
export function useDailyGoal(): DailyGoalResult {
  const { hoursDriven } = useDrivingSession();

  // Migration vers useSmartQueryRefresh : pulse 30s + auto-pause en arrière-plan
  const profileQ = useSmartQueryRefresh<DriverProfile | null>(
    ["/api/driver-profile"],
    () => apiRequest("GET", "/api/driver-profile").then((r) => r.json()),
  );

  // Migration vers useSmartQueryRefresh : pulse 30s + auto-pause en arrière-plan
  const statsQ = useSmartQueryRefresh<RideStats>(
    ["/api/rides/stats"],
    () => apiRequest("GET", "/api/rides/stats").then((r) => r.json()),
  );

  // /api/rides non migré — endpoint non listé comme temps réel critique
  const ridesQ = useQuery<Ride[]>({
    queryKey: ["/api/rides"],
  });

  const hourlyTarget = profileQ.data?.hourly_target_income ?? 35;
  const goalEuros = hourlyTarget * SESSION_HOURS_TARGET;

  const currentEuros = extractCurrentEuros(statsQ.data, ridesQ.data);
  const remainingEuros = Math.max(0, goalEuros - currentEuros);
  const progressPct = goalEuros > 0 ? Math.min(100, (currentEuros / goalEuros) * 100) : 0;

  // Heures restantes au taux actuel
  const currentRate = hoursDriven > 0 ? currentEuros / hoursDriven : 0;
  const hoursLeftAtCurrentRate =
    currentRate > 0 ? remainingEuros / currentRate : remainingEuros > 0 ? SESSION_HOURS_TARGET : 0;

  // onTrack : on compare ratio gains réalisés / objectif vs ratio heures conduites / session cible
  const onTrack =
    goalEuros > 0 && hoursDriven > 0
      ? currentEuros / goalEuros >= hoursDriven / SESSION_HOURS_TARGET
      : currentEuros >= goalEuros;

  return {
    goalEuros,
    currentEuros,
    remainingEuros,
    progressPct,
    hoursLeftAtCurrentRate,
    onTrack,
  };
}
