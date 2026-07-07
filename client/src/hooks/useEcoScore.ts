/**
 * useEcoScore — Tracker éco-conduite (Vague 2 - Feature 8)
 * ─────────────────────────────────────────────────────────────────────────────
 * Échantillonne la vitesse GPS toutes les 2s pendant la conduite (> 5 km/h),
 * calcule Δv/Δt et classe les accélérations/freinages brusques.
 *   - Accélération brusque  : > 8 km/h/s
 *   - Freinage brusque      : < -10 km/h/s
 * Score = 100 - min(50, harshA*3 + harshB*4)
 * CO2 estimé = km parcourus (en douceur) × 0.14 kg/km (moyenne diesel).
 * Compteurs persistés en LS `vtc.eco.today` (remis à zéro chaque jour).
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { useEffect, useRef, useState, useCallback } from "react";
import { useGpsPosition } from "./useGpsPosition";

const LS_KEY = "vtc.eco.today";
const SAMPLE_INTERVAL_MS = 2000;
const DRIVING_THRESHOLD_KMH = 5;
const HARSH_ACCEL_KMH_S = 8;
const HARSH_BRAKE_KMH_S = -10;
const CO2_KG_PER_KM = 0.14; // moyenne diesel

export interface EcoTodayData {
  day: string; // YYYY-MM-DD
  samples: number;
  harshA: number;
  harshB: number;
  kmSmooth: number;
}

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function defaultData(): EcoTodayData {
  return { day: todayStr(), samples: 0, harshA: 0, harshB: 0, kmSmooth: 0 };
}

export function readEcoToday(): EcoTodayData {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return defaultData();
    const parsed = JSON.parse(raw) as EcoTodayData;
    if (parsed.day !== todayStr()) return defaultData();
    return parsed;
  } catch {
    return defaultData();
  }
}

function writeEcoToday(data: EcoTodayData): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(data));
  } catch {
    // ignore
  }
}

export interface EcoScoreResult {
  score: number; // 0-100
  harshA: number;
  harshB: number;
  kmSmooth: number;
  co2Kg: number;
}

export function computeEcoScore(data: EcoTodayData): EcoScoreResult {
  const penalty = Math.min(50, data.harshA * 3 + data.harshB * 4);
  const score = Math.max(0, 100 - penalty);
  const co2Kg = Math.round(data.kmSmooth * CO2_KG_PER_KM * 100) / 100;
  return { score, harshA: data.harshA, harshB: data.harshB, kmSmooth: data.kmSmooth, co2Kg };
}

/**
 * Hook — échantillonne la vitesse en continu et met à jour les compteurs
 * éco-conduite du jour. Retourne le score courant.
 */
export function useEcoScore(): EcoScoreResult {
  const { speedKmh } = useGpsPosition();
  const [data, setData] = useState<EcoTodayData>(() => readEcoToday());

  const lastSampleRef = useRef<{ speed: number; ts: number } | null>(null);

  const sample = useCallback(() => {
    const now = Date.now();
    const current = readEcoToday();

    if (speedKmh > DRIVING_THRESHOLD_KMH) {
      const prev = lastSampleRef.current;
      let next: EcoTodayData = { ...current, samples: current.samples + 1 };

      if (prev) {
        const dtSec = (now - prev.ts) / 1000;
        if (dtSec > 0) {
          const dv = speedKmh - prev.speed;
          const rate = dv / dtSec; // km/h par seconde
          if (rate > HARSH_ACCEL_KMH_S) {
            next.harshA += 1;
          } else if (rate < HARSH_BRAKE_KMH_S) {
            next.harshB += 1;
          } else {
            // Trajet "en douceur" : on ajoute la distance parcourue pendant l'intervalle
            const kmInInterval = (speedKmh * (dtSec / 3600));
            next.kmSmooth = Math.round((next.kmSmooth + kmInInterval) * 1000) / 1000;
          }
        }
      }

      writeEcoToday(next);
      setData(next);
      lastSampleRef.current = { speed: speedKmh, ts: now };
    } else {
      lastSampleRef.current = null;
    }
  }, [speedKmh]);

  useEffect(() => {
    const id = setInterval(sample, SAMPLE_INTERVAL_MS);
    return () => clearInterval(id);
  }, [sample]);

  return computeEcoScore(data);
}
