/**
 * useBatteryStatus — Dégradation adaptative selon la batterie (Vague 2 - Feature 4)
 * ─────────────────────────────────────────────────────────────────────────────
 * Utilise `navigator.getBattery()` (Battery Status API, best-effort — non
 * supportée par tous les navigateurs, notamment Safari/iOS) pour détecter un
 * niveau de batterie faible, et l'API `navigator.connection.saveData` pour
 * détecter le mode "Économie de données".
 *
 * Si niveau < 20% OU saveData actif → passe en `perfMode = "low"` :
 *   - pose la classe CSS `.perf-low` sur <html> (désactive animations lourdes,
 *     voir index.css)
 *   - ralentit le polling des hooks qui consultent `getPollingIntervalMs()`
 *
 * Fallback total no-op si aucune des deux API n'est disponible (le mode reste
 * "normal" en permanence).
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { useEffect, useState } from "react";
import { getPerfMode, setPerfMode, type PerfMode } from "@/lib/perfMode";

const LOW_BATTERY_THRESHOLD = 0.2;

interface BatteryManagerLike {
  level: number;
  charging: boolean;
  addEventListener: (type: string, listener: () => void) => void;
  removeEventListener: (type: string, listener: () => void) => void;
}

interface NetworkInformationLike {
  saveData?: boolean;
  addEventListener?: (type: string, listener: () => void) => void;
  removeEventListener?: (type: string, listener: () => void) => void;
}

export interface BatteryStatusResult {
  level: number | null; // 0..1, null si API indisponible
  charging: boolean | null;
  saveData: boolean;
  perfMode: PerfMode;
}

export function useBatteryStatus(): BatteryStatusResult {
  const [level, setLevel] = useState<number | null>(null);
  const [charging, setCharging] = useState<boolean | null>(null);
  const [saveData, setSaveData] = useState<boolean>(false);
  const [perfMode, setPerfModeState] = useState<PerfMode>(getPerfMode());

  // ── Battery Status API (best-effort) ──────────────────────────────────────
  useEffect(() => {
    let battery: BatteryManagerLike | null = null;
    let cancelled = false;

    const getBattery = (navigator as any)?.getBattery;
    if (typeof getBattery === "function") {
      getBattery
        .call(navigator)
        .then((bm: BatteryManagerLike) => {
          if (cancelled) return;
          battery = bm;
          const update = () => {
            setLevel(bm.level);
            setCharging(bm.charging);
          };
          update();
          bm.addEventListener("levelchange", update);
          bm.addEventListener("chargingchange", update);
        })
        .catch(() => {
          // API présente mais indisponible (permissions, environnement) → no-op
        });
    }

    return () => {
      cancelled = true;
      if (battery) {
        // Les listeners exacts ne sont pas conservés hors de la closure ci-
        // dessus ; navigateur les nettoie au GC de l'objet battery.
      }
    };
  }, []);

  // ── Network Information API — saveData ────────────────────────────────────
  useEffect(() => {
    const connection: NetworkInformationLike | undefined = (navigator as any)?.connection;
    if (!connection) return;

    const update = () => setSaveData(Boolean(connection.saveData));
    update();
    connection.addEventListener?.("change", update);
    return () => connection.removeEventListener?.("change", update);
  }, []);

  // ── Calcule et applique le perfMode global ────────────────────────────────
  useEffect(() => {
    const lowBattery = level !== null && level < LOW_BATTERY_THRESHOLD && charging !== true;
    const next: PerfMode = lowBattery || saveData ? "low" : "normal";
    setPerfMode(next);
    setPerfModeState(next);
  }, [level, charging, saveData]);

  return { level, charging, saveData, perfMode };
}

export default useBatteryStatus;
