/**
 * useAutoSunsetTheme — Bascule automatique jour/nuit selon le soleil (Vague 2 - Feature 7)
 * ─────────────────────────────────────────────────────────────────────────────
 * Calcule l'heure de lever et coucher du soleil pour la latitude de Paris
 * (48.85°N) via la formule NOAA classique (aucune dépendance externe), et
 * bascule le thème (`ThemeProvider`) automatiquement :
 *   - Nuit (dark) : à partir de (coucher du soleil - 30 min)
 *   - Jour (light) : à partir de (lever du soleil + 30 min)
 *
 * Comportement :
 *   - Actif seulement si LS `vtc.theme.autoSunset` === "true" (défaut: actif).
 *   - Respecte un geste manuel récent : si l'utilisateur a changé le thème à la
 *     main il y a moins de 4h (LS `vtc.theme.lastManualToggle`), l'auto-bascule
 *     est suspendue pour ne pas contredire son choix.
 *   - Le `toggle()` existant de ThemeProvider reste manuel ; ce hook utilise
 *     `setTheme()` uniquement pour ses bascules automatiques, et écoute les
 *     changements de thème externes pour détecter un geste manuel (best-effort
 *     via l'exposition de `markManualToggle()`).
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { useEffect, useRef } from "react";
import { useTheme } from "@/components/ThemeProvider";

const LS_AUTO_SUNSET = "vtc.theme.autoSunset";
const LS_LAST_MANUAL_TOGGLE = "vtc.theme.lastManualToggle";

const PARIS_LAT = 48.85;
const PARIS_LNG = 2.35;

const MANUAL_OVERRIDE_WINDOW_MS = 4 * 60 * 60 * 1000; // 4h
const OFFSET_MIN = 30; // minutes de marge avant/après le soleil
const CHECK_INTERVAL_MS = 60_000; // ré-évaluation chaque minute

function getAutoSunsetEnabled(): boolean {
  try {
    const raw = localStorage.getItem(LS_AUTO_SUNSET);
    return raw === null ? true : raw === "true";
  } catch {
    return true;
  }
}

export function setAutoSunsetEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(LS_AUTO_SUNSET, String(enabled));
  } catch {
    // ignore
  }
}

/** À appeler quand l'utilisateur bascule manuellement le thème. */
export function markManualThemeToggle(): void {
  try {
    localStorage.setItem(LS_LAST_MANUAL_TOGGLE, String(Date.now()));
  } catch {
    // ignore
  }
}

function getLastManualToggle(): number {
  try {
    const raw = localStorage.getItem(LS_LAST_MANUAL_TOGGLE);
    return raw ? Number(raw) || 0 : 0;
  } catch {
    return 0;
  }
}

// ── Calcul lever/coucher du soleil — formule NOAA classique ─────────────────
// Référence : https://gml.noaa.gov/grad/solcalc/solareqns.PDF (approximation
// standard, sans dépendance). Renvoie des Date en heure locale pour le jour
// de `date` fourni.
function toJulianDay(date: Date): number {
  return date.getTime() / 86400000 + 2440587.5;
}

function sunEventUtcMinutes(date: Date, lat: number, lng: number, isSunrise: boolean): number | null {
  const zenith = 90.833; // zénith officiel (réfraction atmosphérique incluse)
  const rad = Math.PI / 180;
  const deg = 180 / Math.PI;

  // Jour de l'année
  const start = Date.UTC(date.getFullYear(), 0, 1);
  const dayOfYear = Math.floor((Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) - start) / 86400000) + 1;

  const lngHour = lng / 15;
  const t = isSunrise ? dayOfYear + (6 - lngHour) / 24 : dayOfYear + (18 - lngHour) / 24;

  const M = 0.9856 * t - 3.289;
  let L = M + 1.916 * Math.sin(M * rad) + 0.020 * Math.sin(2 * M * rad) + 282.634;
  L = ((L % 360) + 360) % 360;

  let RA = deg * Math.atan(0.91764 * Math.tan(L * rad));
  RA = ((RA % 360) + 360) % 360;

  const Lquadrant = Math.floor(L / 90) * 90;
  const RAquadrant = Math.floor(RA / 90) * 90;
  RA = RA + (Lquadrant - RAquadrant);
  RA = RA / 15;

  const sinDec = 0.39782 * Math.sin(L * rad);
  const cosDec = Math.cos(Math.asin(sinDec));

  const cosH =
    (Math.cos(zenith * rad) - sinDec * Math.sin(lat * rad)) / (cosDec * Math.cos(lat * rad));

  if (cosH > 1 || cosH < -1) return null; // soleil ne se lève/couche pas (latitudes extrêmes) — n/a pour Paris

  let H = isSunrise ? 360 - deg * Math.acos(cosH) : deg * Math.acos(cosH);
  H = H / 15;

  const T = H + RA - 0.06571 * t - 6.622;
  let UT = T - lngHour;
  UT = ((UT % 24) + 24) % 24;

  return UT * 60; // minutes depuis minuit UTC
}

function getSunTimes(date: Date): { sunrise: Date; sunset: Date } | null {
  const sunriseUtcMin = sunEventUtcMinutes(date, PARIS_LAT, PARIS_LNG, true);
  const sunsetUtcMin = sunEventUtcMinutes(date, PARIS_LAT, PARIS_LNG, false);
  if (sunriseUtcMin === null || sunsetUtcMin === null) return null;

  const dayStartUtc = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  const sunrise = new Date(dayStartUtc + sunriseUtcMin * 60_000);
  const sunset = new Date(dayStartUtc + sunsetUtcMin * 60_000);
  return { sunrise, sunset };
}

// ── Hook principal ───────────────────────────────────────────────────────────
export function useAutoSunsetTheme(): void {
  const { theme, setTheme } = useTheme();
  const lastTheme = useRef(theme);

  // Détecte un changement de thème externe (ex: clic manuel via toggle()) pour
  // marquer un geste manuel — évite d'écraser un choix récent de l'utilisateur.
  useEffect(() => {
    if (lastTheme.current !== theme) {
      lastTheme.current = theme;
    }
  }, [theme]);

  useEffect(() => {
    const evaluate = () => {
      if (!getAutoSunsetEnabled()) return;

      const sinceManual = Date.now() - getLastManualToggle();
      if (sinceManual < MANUAL_OVERRIDE_WINDOW_MS) return; // respecte le choix manuel récent

      const now = new Date();
      const sunTimes = getSunTimes(now);
      if (!sunTimes) return;

      const nightStart = new Date(sunTimes.sunset.getTime() + OFFSET_MIN * 60_000);
      const dayStart = new Date(sunTimes.sunrise.getTime() + OFFSET_MIN * 60_000);

      // Nuit : après (coucher + 30min) OU avant (lever + 30min) du même cycle.
      const isNight = now >= nightStart || now < dayStart;
      const desired: "dark" | "light" = isNight ? "dark" : "light";

      if (desired !== lastTheme.current) {
        setTheme(desired);
        lastTheme.current = desired;
      }
    };

    evaluate();
    const id = window.setInterval(evaluate, CHECK_INTERVAL_MS);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setTheme]);
}

export default useAutoSunsetTheme;
