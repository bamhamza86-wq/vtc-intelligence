/**
 * useTelemetry — Capteur discret pour le Fatigue Coach (Itération 3)
 * ─────────────────────────────────────────────────────────────────────────────
 * Capture des proxys comportementaux SANS caméra, uniquement via Web APIs
 * natives (aucune dépendance npm) :
 *   - Temps entre `pointerdown` et `pointerup` sur un tap → tap_latency_ms
 *   - "Jerk" de swipe (variation brutale de vitesse pendant un touchmove)
 *   - DeviceMotion (accélération) → accel_variance
 *   - DeviceOrientation (gyro logique) → gyro_variance
 *   - Temps de décision : délai entre l'affichage d'un écran/action proposée
 *     et le premier tap qui suit (approximé ici par le délai entre deux taps)
 *   - Ratio de correction : proportion de taps annulés / doubles taps rapprochés
 *
 * Respect vie privée : AUCUNE donnée de contenu (pas de texte, pas de position
 * exacte de tap sur l'écran, pas d'identifiant d'élément). Seulement des
 * mesures temporelles/physiques agrégées, envoyées en mini-batch toutes les
 * 20s vers POST /api/fatigue/telemetry.
 *
 * Usage : appeler useTelemetry() une seule fois, tout en haut de l'app
 * (ex: dans App.tsx), après authentification. Les composants n'ont rien à
 * faire de spécial — la capture est globale via des écouteurs passifs sur
 * `window`.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { useEffect, useRef } from "react";
import { apiRequest } from "@/lib/queryClient";

const BATCH_INTERVAL_MS = 20_000;
const MAX_BUFFER = 40;

interface RawPoint {
  ts: string;
  tap_latency_ms?: number;
  swipe_jerk?: number;
  accel_variance?: number;
  gyro_variance?: number;
  decision_time_ms?: number;
  correction_ratio?: number;
}

export function useTelemetry(enabled: boolean = true) {
  const bufferRef = useRef<RawPoint[]>([]);
  const lastTapTsRef = useRef<number>(0);
  const lastTapDownRef = useRef<number>(0);
  const tapCountRef = useRef<number>(0);
  const correctionCountRef = useRef<number>(0);
  const accelSamplesRef = useRef<number[]>([]);
  const gyroSamplesRef = useRef<number[]>([]);
  const swipeStartRef = useRef<{ x: number; y: number; t: number } | null>(null);
  const swipeVelocitiesRef = useRef<number[]>([]);

  useEffect(() => {
    if (!enabled) return;

    // ── Tap latency (pointerdown → pointerup) ──
    const onPointerDown = () => {
      lastTapDownRef.current = performance.now();
    };
    const onPointerUp = () => {
      const now = performance.now();
      if (lastTapDownRef.current > 0) {
        const latency = now - lastTapDownRef.current;
        if (latency >= 0 && latency < 2000) {
          bufferRef.current.push({ ts: new Date().toISOString(), tap_latency_ms: Math.round(latency) });
        }
      }
      // Temps de décision approximé = délai entre deux taps successifs (proxy)
      if (lastTapTsRef.current > 0) {
        const gap = now - lastTapTsRef.current;
        if (gap > 150 && gap < 15_000) {
          bufferRef.current.push({ ts: new Date().toISOString(), decision_time_ms: Math.round(gap) });
        }
        // Double-tap rapproché (<250ms) = correction probable (retap après erreur)
        if (gap < 250) {
          correctionCountRef.current++;
        }
      }
      lastTapTsRef.current = now;
      tapCountRef.current++;
      trimBuffer();
    };

    // ── Swipe jerk (variation brutale de vitesse pendant un touchmove) ──
    const onTouchStart = (e: TouchEvent) => {
      const t = e.touches[0];
      if (t) swipeStartRef.current = { x: t.clientX, y: t.clientY, t: performance.now() };
      swipeVelocitiesRef.current = [];
    };
    const onTouchMove = (e: TouchEvent) => {
      const t = e.touches[0];
      const start = swipeStartRef.current;
      if (!t || !start) return;
      const now = performance.now();
      const dt = now - start.t;
      if (dt <= 0) return;
      const dist = Math.hypot(t.clientX - start.x, t.clientY - start.y);
      const velocity = dist / dt;
      swipeVelocitiesRef.current.push(velocity);
      swipeStartRef.current = { x: t.clientX, y: t.clientY, t: now };
    };
    const onTouchEnd = () => {
      const vels = swipeVelocitiesRef.current;
      if (vels.length >= 3) {
        // Jerk = variance des variations de vitesse successives
        const diffs: number[] = [];
        for (let i = 1; i < vels.length; i++) diffs.push(Math.abs(vels[i] - vels[i - 1]));
        const meanDiff = diffs.reduce((a, b) => a + b, 0) / diffs.length;
        const variance = diffs.reduce((a, b) => a + (b - meanDiff) ** 2, 0) / diffs.length;
        bufferRef.current.push({ ts: new Date().toISOString(), swipe_jerk: Math.round(variance * 100) / 100 });
      }
      swipeStartRef.current = null;
      swipeVelocitiesRef.current = [];
      trimBuffer();
    };

    // ── DeviceMotion (accéléromètre) ──
    const onDeviceMotion = (e: DeviceMotionEvent) => {
      const acc = e.accelerationIncludingGravity || e.acceleration;
      if (!acc) return;
      const magnitude = Math.sqrt((acc.x || 0) ** 2 + (acc.y || 0) ** 2 + (acc.z || 0) ** 2);
      accelSamplesRef.current.push(magnitude);
      if (accelSamplesRef.current.length > 50) accelSamplesRef.current.shift();
    };

    // ── DeviceOrientation (proxy "gyro") ──
    const onDeviceOrientation = (e: DeviceOrientationEvent) => {
      const val = Math.abs(e.beta || 0) + Math.abs(e.gamma || 0);
      gyroSamplesRef.current.push(val);
      if (gyroSamplesRef.current.length > 50) gyroSamplesRef.current.shift();
    };

    window.addEventListener("pointerdown", onPointerDown, { passive: true });
    window.addEventListener("pointerup", onPointerUp, { passive: true });
    window.addEventListener("touchstart", onTouchStart, { passive: true });
    window.addEventListener("touchmove", onTouchMove, { passive: true });
    window.addEventListener("touchend", onTouchEnd, { passive: true });

    // DeviceMotion/Orientation nécessitent une permission explicite sur iOS 13+.
    // On tente un ajout direct (Android + navigateurs sans restriction) sans
    // bloquer l'UI par une demande de permission intrusive (respect §consignes
    // "non intrusif") — si iOS exige un geste utilisateur, ces events resteront
    // simplement silencieux, ce qui dégrade gracieusement vers les autres signaux.
    try {
      window.addEventListener("devicemotion", onDeviceMotion, { passive: true } as any);
      window.addEventListener("deviceorientation", onDeviceOrientation, { passive: true } as any);
    } catch {
      // ignore — capteurs indisponibles
    }

    function trimBuffer() {
      if (bufferRef.current.length > MAX_BUFFER) {
        bufferRef.current = bufferRef.current.slice(-MAX_BUFFER);
      }
    }

    // ── Flush périodique vers le serveur ──
    const flush = () => {
      const points = [...bufferRef.current];
      bufferRef.current = [];

      // Ajoute un point agrégé variance accel/gyro + ratio de correction si dispo
      if (accelSamplesRef.current.length >= 3 || gyroSamplesRef.current.length >= 3) {
        const accel = accelSamplesRef.current;
        const gyro = gyroSamplesRef.current;
        const variance = (arr: number[]) => {
          if (arr.length < 2) return undefined;
          const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
          return arr.reduce((a, b) => a + (b - mean) ** 2, 0) / arr.length;
        };
        points.push({
          ts: new Date().toISOString(),
          accel_variance: variance(accel),
          gyro_variance: variance(gyro),
        });
        accelSamplesRef.current = [];
        gyroSamplesRef.current = [];
      }

      const totalTaps = tapCountRef.current;
      if (totalTaps > 0 && correctionCountRef.current > 0) {
        points.push({
          ts: new Date().toISOString(),
          correction_ratio: Math.min(1, correctionCountRef.current / totalTaps),
        });
      }
      tapCountRef.current = 0;
      correctionCountRef.current = 0;

      if (points.length === 0) return;

      apiRequest("POST", "/api/fatigue/telemetry", { points }).catch(() => {
        // silencieux — la télémétrie ne doit jamais impacter l'UX si le réseau échoue
      });
    };

    const intervalId = window.setInterval(flush, BATCH_INTERVAL_MS);

    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("touchstart", onTouchStart);
      window.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("touchend", onTouchEnd);
      try {
        window.removeEventListener("devicemotion", onDeviceMotion as any);
        window.removeEventListener("deviceorientation", onDeviceOrientation as any);
      } catch {
        // ignore
      }
      window.clearInterval(intervalId);
    };
  }, [enabled]);
}
