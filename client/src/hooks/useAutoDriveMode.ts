/**
 * useAutoDriveMode — Bascule auto en mode Conduite XXL (Vague 1 - Levier 5)
 * ─────────────────────────────────────────────────────────────────────────────
 * Détecte la vitesse GPS :
 *   - > 15 km/h stable 5s → suggère "Mode conduite" (toast avec undo)
 *   - < 5 km/h stable 30s → suggère "Sortie mode conduite"
 * Le chauffeur peut désactiver dans les préférences (`vtc.autoDrive.enabled`).
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { useEffect, useRef, useState } from "react";
import { useGpsPosition } from "./useGpsPosition";
import { useLocation } from "wouter";

const LS_ENABLED = "vtc.autoDrive.enabled";
const LS_LAST_PROMPT = "vtc.autoDrive.lastPrompt";
const DEBOUNCE_MS = 5 * 60 * 1000; // 5 min entre deux prompts
const SPEED_ENTER = 15; // km/h
const SPEED_EXIT = 5;
const STABLE_ENTER_MS = 5_000;
const STABLE_EXIT_MS = 30_000;

export function autoDriveEnabled(): boolean {
  try {
    return localStorage.getItem(LS_ENABLED) !== "false"; // default: on
  } catch {
    return true;
  }
}

export function setAutoDriveEnabled(v: boolean) {
  try {
    localStorage.setItem(LS_ENABLED, String(v));
  } catch {}
}

export function useAutoDriveMode() {
  const { speedKmh } = useGpsPosition();
  const [location, navigate] = useLocation();
  const [suggestion, setSuggestion] = useState<null | "enter" | "exit">(null);

  const enterSince = useRef<number | null>(null);
  const exitSince = useRef<number | null>(null);

  useEffect(() => {
    if (!autoDriveEnabled()) return;
    const now = Date.now();
    const last = Number(localStorage.getItem(LS_LAST_PROMPT) || 0);
    if (now - last < DEBOUNCE_MS) return;

    const onDrive = location === "/drive";

    if (!onDrive && speedKmh >= SPEED_ENTER) {
      if (enterSince.current == null) enterSince.current = now;
      exitSince.current = null;
      if (now - enterSince.current >= STABLE_ENTER_MS) {
        setSuggestion("enter");
        localStorage.setItem(LS_LAST_PROMPT, String(now));
        enterSince.current = null;
      }
    } else if (onDrive && speedKmh < SPEED_EXIT) {
      if (exitSince.current == null) exitSince.current = now;
      enterSince.current = null;
      if (now - exitSince.current >= STABLE_EXIT_MS) {
        setSuggestion("exit");
        localStorage.setItem(LS_LAST_PROMPT, String(now));
        exitSince.current = null;
      }
    } else {
      enterSince.current = null;
      exitSince.current = null;
    }
  }, [speedKmh, location]);

  function accept() {
    if (suggestion === "enter") navigate("/drive");
    else if (suggestion === "exit") navigate("/focus");
    setSuggestion(null);
  }
  function dismiss() {
    setSuggestion(null);
  }
  return { suggestion, accept, dismiss, speedKmh };
}
