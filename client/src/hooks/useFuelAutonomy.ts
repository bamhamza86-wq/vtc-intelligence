// ──────────────────────────────────────────────────────────────────────────────
// useFuelAutonomy — Suivi de l'autonomie carburant restante
// ──────────────────────────────────────────────────────────────────────────────
// Persiste les km restants dans localStorage (vtc.tank_km_left).
// Par défaut : 400 km. La fonction resetTank(km) permet de mettre à jour la
// valeur après un plein.
// ──────────────────────────────────────────────────────────────────────────────
import { useState, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";

// ──────────────────────────────────────────────────────────────────────────────
// Constantes
// ──────────────────────────────────────────────────────────────────────────────
const LS_KEY = "vtc.tank_km_left";
const DEFAULT_KM = 400;
const AVG_SPEED_KMH = 30; // vitesse moyenne VTC urbain

// ──────────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────────
interface DriverProfile {
  fuel_consumption_per100km?: number;
  hourly_target_income?: number;
}

export interface FuelAutonomyResult {
  kmProfitableLeft: number;
  hoursLeft: number;
  resetTank: (km: number) => void;
}

// ──────────────────────────────────────────────────────────────────────────────
// Helper localStorage
// ──────────────────────────────────────────────────────────────────────────────
function readKmFromStorage(): number {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw !== null) {
      const n = parseFloat(raw);
      if (!isNaN(n) && n >= 0) return n;
    }
  } catch {
    // SSR / indisponible
  }
  return DEFAULT_KM;
}

function writeKmToStorage(km: number): void {
  try {
    localStorage.setItem(LS_KEY, String(km));
  } catch {
    // ignoré
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Hook principal
// ──────────────────────────────────────────────────────────────────────────────
export function useFuelAutonomy(): FuelAutonomyResult {
  const [kmProfitableLeft, setKmProfitableLeft] = useState<number>(() => readKmFromStorage());

  // Profil conducteur — on lit mais n'en dépend pas pour le calcul principal
  useQuery<DriverProfile | null>({
    queryKey: ["/api/driver-profile"],
  });

  const hoursLeft = AVG_SPEED_KMH > 0 ? kmProfitableLeft / AVG_SPEED_KMH : 0;

  const resetTank = useCallback((km: number) => {
    const safeKm = Math.max(0, km);
    writeKmToStorage(safeKm);
    setKmProfitableLeft(safeKm);
  }, []);

  return { kmProfitableLeft, hoursLeft, resetTank };
}
