/**
 * useAmberNight — Mode "conduite nuit" façon cockpit avion
 * ─────────────────────────────────────────────────────────────────────────────
 * Distinct du dark mode existant (ThemeProvider / classe `.dark`). Ce mode
 * applique une palette rouge/ambre <2700K sur tout le document pour préserver
 * la vision nocturne du chauffeur (contraste ≥ 4.5:1, cf. index.css bloc
 * `:root.amber-night`).
 *
 * Modes disponibles (persistés dans localStorage `vtc.amberNight`) :
 *   "off"  — jamais actif
 *   "on"   — toujours actif
 *   "auto" — actif entre 21h et 6h (heure locale du chauffeur)
 *
 * Test rapide en dev (console navigateur), sans passer par le hook :
 *   document.documentElement.classList.add('amber-night')
 *   document.documentElement.classList.remove('amber-night')
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { useCallback, useEffect, useState } from "react";

// ── Types ─────────────────────────────────────────────────────────────────────
export type AmberNightMode = "off" | "on" | "auto";

// ── Constantes ────────────────────────────────────────────────────────────────
const STORAGE_KEY = "vtc.amberNight";
const CSS_CLASS = "amber-night";
const AUTO_START_HOUR = 21; // 21h locale
const AUTO_END_HOUR = 6; // 6h locale
/** Fréquence de ré-évaluation du mode "auto" (bascule automatique jour/nuit). */
const AUTO_CHECK_INTERVAL_MS = 60_000; // 1 minute

// ── Helpers ───────────────────────────────────────────────────────────────────
function readStoredMode(): AmberNightMode {
  if (typeof localStorage === "undefined") return "auto";
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw === "off" || raw === "on" || raw === "auto") return raw;
  return "auto";
}

function writeStoredMode(mode: AmberNightMode): void {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(STORAGE_KEY, mode);
}

/** Détermine si l'heure locale actuelle tombe dans la plage nuit [21h, 6h[. */
function isNightHourNow(): boolean {
  const hour = new Date().getHours();
  return hour >= AUTO_START_HOUR || hour < AUTO_END_HOUR;
}

function applyDomClass(active: boolean): void {
  if (typeof document === "undefined") return;
  document.documentElement.classList.toggle(CSS_CLASS, active);
}

// ── Hook principal ────────────────────────────────────────────────────────────
export function useAmberNight() {
  const [mode, setModeState] = useState<AmberNightMode>(() => readStoredMode());
  const [isActive, setIsActive] = useState<boolean>(() => {
    const m = readStoredMode();
    return m === "on" || (m === "auto" && isNightHourNow());
  });

  // Recalcule l'état actif à chaque changement de mode + tick périodique
  // (nécessaire pour que le mode "auto" bascule tout seul à 21h/6h sans
  // rechargement de page).
  useEffect(() => {
    const recompute = () => {
      const active = mode === "on" || (mode === "auto" && isNightHourNow());
      setIsActive(active);
      applyDomClass(active);
    };

    recompute();

    if (mode !== "auto") return;

    const id = window.setInterval(recompute, AUTO_CHECK_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [mode]);

  const setMode = useCallback((next: AmberNightMode) => {
    setModeState(next);
    writeStoredMode(next);
  }, []);

  return { mode, setMode, isActive };
}

export default useAmberNight;
