/**
 * useDailyStreak — Streaks + objectif journalier (Vague 2 - Feature 3)
 * ─────────────────────────────────────────────────────────────────────────────
 * S'appuie sur le hook existant `useDailyGoal` (déjà branché sur
 * /api/driver-profile + /api/rides/stats) pour connaître le revenu du jour et
 * calcule un objectif éditable indépendant (LS `vtc.dailyGoal.target`,
 * défaut 250€), ainsi qu'un compteur de streak (jours consécutifs où
 * l'objectif a été atteint), stocké en LS.
 *
 * Expose { progress: 0..1, target, currentEuros, streakDays }.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { useEffect, useState, useCallback } from "react";
import { useDailyGoal } from "./useDailyGoal";

const LS_TARGET = "vtc.dailyGoal.target";
const LS_STREAK = "vtc.dailyGoal.streak";
const LS_LAST_REACHED = "vtc.dailyGoal.lastReached";

const DEFAULT_TARGET = 250;

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function yesterdayStr(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function getDailyGoalTarget(): number {
  try {
    const raw = localStorage.getItem(LS_TARGET);
    const n = raw ? Number(raw) : DEFAULT_TARGET;
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_TARGET;
  } catch {
    return DEFAULT_TARGET;
  }
}

export function setDailyGoalTarget(value: number): void {
  try {
    localStorage.setItem(LS_TARGET, String(Math.max(1, Math.round(value))));
  } catch {
    // ignore
  }
}

function getStreak(): number {
  try {
    const raw = localStorage.getItem(LS_STREAK);
    return raw ? Number(raw) || 0 : 0;
  } catch {
    return 0;
  }
}

function getLastReached(): string | null {
  try {
    return localStorage.getItem(LS_LAST_REACHED);
  } catch {
    return null;
  }
}

function persistStreak(streak: number, lastReached: string): void {
  try {
    localStorage.setItem(LS_STREAK, String(streak));
    localStorage.setItem(LS_LAST_REACHED, lastReached);
  } catch {
    // ignore
  }
}

export interface DailyStreakResult {
  progress: number; // 0..1
  target: number;
  currentEuros: number;
  streakDays: number;
}

export function useDailyStreak(): DailyStreakResult {
  const { currentEuros } = useDailyGoal();
  const [target, setTarget] = useState<number>(getDailyGoalTarget);
  const [streakDays, setStreakDays] = useState<number>(getStreak);

  // Re-lit la cible si modifiée ailleurs (ex: ProfilePage) via storage event
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === LS_TARGET) setTarget(getDailyGoalTarget());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const evaluateStreak = useCallback(() => {
    if (currentEuros < target) return;
    const today = todayStr();
    const lastReached = getLastReached();
    if (lastReached === today) return; // déjà comptabilisé aujourd'hui

    const yesterday = yesterdayStr();
    const currentStreak = getStreak();
    const nextStreak = lastReached === yesterday ? currentStreak + 1 : 1;
    persistStreak(nextStreak, today);
    setStreakDays(nextStreak);
  }, [currentEuros, target]);

  useEffect(() => {
    evaluateStreak();
  }, [evaluateStreak]);

  const progress = target > 0 ? Math.min(1, currentEuros / target) : 0;

  return { progress, target, currentEuros, streakDays };
}
