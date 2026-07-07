/**
 * CommunityRadar — Canvas HTML5 façon "radar aérien" (Flightradar24-like)
 * ─────────────────────────────────────────────────────────────────────────────
 * Référence rapport : §15.9 (Wow factor — carte façon radar aérien pour la
 * densité de demande, points mouvants représentant l'activité anonymisée
 * agrégée, plutôt qu'une simple heatmap statique) et §1.8/1.10 (heatmap
 * collaborative, convergence).
 *
 * Dessine, centré sur la position du chauffeur (toujours au centre, comme un
 * radar d'avion) :
 *  - Cercles de portée concentriques (1km / 3km / 5km) avec label
 *  - Balayage radar tournant (sweep) façon écran radar classique
 *  - Blips animés (autres chauffeurs anonymisés) qui dérivent doucement
 *  - Heatspots pulsants (zones chaudes) — taille/opacité liées à l'intensité
 *  - Corridors en flux (lignes pointillées animées entre zones fréquentées)
 *  - Convergences (cercles d'alerte oranges/rouges autour des sur-concentrations)
 *  - Bulle d'info au tap/clic sur un blip ou heatspot (ETA, tarif estimé)
 *
 * Zéro nouvelle dépendance : Canvas 2D natif + requestAnimationFrame, 60fps.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { useEffect, useRef, useState, useCallback } from "react";

export interface RadarBlip {
  blip_id: string;
  lat: number;
  lng: number;
  direction_deg: number | null;
  speed_kmh: number | null;
  age_sec: number;
}
export interface RadarHeatspot {
  lat: number;
  lng: number;
  intensity: number;
  zone_id: string | null;
  zone_name: string | null;
}
export interface RadarConvergence {
  lat: number;
  lng: number;
  count_chauffeurs: number;
  radius_m: number;
}
export interface RadarArrival {
  blip_id: string;
  eta_min: number;
  distance_km: number;
}
export interface HotCorridor {
  from_zone: string;
  from_zone_name: string;
  to_zone: string;
  to_zone_name: string;
  count_chauffeurs: number;
  avg_duration_s: number;
}

export interface CommunityRadarProps {
  center: { lat: number; lng: number };
  blips: RadarBlip[];
  heatspots: RadarHeatspot[];
  convergences: RadarConvergence[];
  corridors: HotCorridor[];
  radiusKm: number;
  showBlips: boolean;
  showHeatspots: boolean;
  showCorridors: boolean;
  estimateFare: (distanceKm: number) => number;
}

// ── Conversion lat/lng -> pixels radar (centre = position chauffeur) ────────
const LAT_DEG_PER_KM = 1 / 111.32;
function lngDegPerKm(lat: number): number {
  return 1 / (111.32 * Math.cos((lat * Math.PI) / 180));
}

function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function bearingDeg(from: { lat: number; lng: number }, to: { lat: number; lng: number }): number {
  const φ1 = (from.lat * Math.PI) / 180;
  const φ2 = (to.lat * Math.PI) / 180;
  const λ1 = (from.lng * Math.PI) / 180;
  const λ2 = (to.lng * Math.PI) / 180;
  const y = Math.sin(λ2 - λ1) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(λ2 - λ1);
  return (Math.atan2(y, x) * 180) / Math.PI;
}

interface Point2D { x: number; y: number; }

interface SelectedInfo {
  kind: "blip" | "heatspot" | "convergence";
  x: number;
  y: number;
  title: string;
  lines: string[];
}

// Positions animées internes (pour un mouvement fluide même si le serveur
// n'envoie qu'un point toutes les 5s — interpolation + dérive légère).
interface AnimatedBlip extends RadarBlip {
  driftAngle: number; // radians, direction de dérive visuelle
  driftSpeed: number; // px/frame approximatif à l'échelle courante
}

export default function CommunityRadar({
  center,
  blips,
  heatspots,
  convergences,
  corridors,
  radiusKm,
  showBlips,
  showHeatspots,
  showCorridors,
  estimateFare,
}: CommunityRadarProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const sweepAngleRef = useRef(0);
  const pulseRef = useRef(0);
  const animatedBlipsRef = useRef<Map<string, AnimatedBlip>>(new Map());
  const [selected, setSelected] = useState<SelectedInfo | null>(null);
  const [dims, setDims] = useState({ w: 320, h: 320 });

  // ── Redimensionnement responsive (observe le conteneur) ──────────────────
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        setDims({ w: Math.max(200, Math.floor(width)), h: Math.max(200, Math.floor(height)) });
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ── Fusionne les nouveaux blips serveur avec l'état animé local ──────────
  useEffect(() => {
    const current = animatedBlipsRef.current;
    const nextIds = new Set(blips.map((b) => b.blip_id));

    // Supprime les blips disparus
    Array.from(current.keys()).forEach((id) => {
      if (!nextIds.has(id)) current.delete(id);
    });

    for (const b of blips) {
      const existing = current.get(b.blip_id);
      if (existing) {
        // Met à jour la donnée serveur, conserve la dérive visuelle
        current.set(b.blip_id, { ...existing, ...b });
      } else {
        current.set(b.blip_id, {
          ...b,
          driftAngle: Math.random() * Math.PI * 2,
          driftSpeed: 0.04 + Math.random() * 0.05,
        });
      }
    }
  }, [blips]);

  const project = useCallback(
    (lat: number, lng: number, scalePxPerKm: number, w: number, h: number): Point2D => {
      const dKm = haversineKm(center, { lat, lng });
      const brg = (bearingDeg(center, { lat, lng }) * Math.PI) / 180;
      const x = w / 2 + Math.sin(brg) * dKm * scalePxPerKm;
      const y = h / 2 - Math.cos(brg) * dKm * scalePxPerKm;
      return { x, y };
    },
    [center]
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx2d = canvas.getContext("2d");
    if (!ctx2d) return;
    // Alias non-null capturé par la closure drawFrame (évite les faux positifs
    // TS18047 "possibly null" — ctx2d est garanti non-null à ce point).
    const ctx: CanvasRenderingContext2D = ctx2d;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = dims.w * dpr;
    canvas.height = dims.h * dpr;
    canvas.style.width = `${dims.w}px`;
    canvas.style.height = `${dims.h}px`;
    ctx.scale(dpr, dpr);

    const w = dims.w;
    const h = dims.h;
    const cx = w / 2;
    const cy = h / 2;
    const maxRadiusPx = Math.min(w, h) / 2 - 24;
    const scalePxPerKm = maxRadiusPx / Math.max(0.5, radiusKm);

    let lastTs = performance.now();

    function drawFrame(ts: number) {
      const dt = Math.min(50, ts - lastTs);
      lastTs = ts;
      sweepAngleRef.current = (sweepAngleRef.current + dt * 0.0009) % (Math.PI * 2);
      pulseRef.current = (pulseRef.current + dt * 0.0016) % (Math.PI * 2);

      ctx.clearRect(0, 0, w, h);

      // Fond radar (dégradé radial sombre)
      const bgGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, maxRadiusPx + 20);
      bgGrad.addColorStop(0, "rgba(6,18,14,0.95)");
      bgGrad.addColorStop(1, "rgba(3,8,8,0.98)");
      ctx.fillStyle = bgGrad;
      ctx.fillRect(0, 0, w, h);

      // Cercles de portée concentriques
      const rings = radiusKm <= 5 ? [1, 3, 5] : [Math.round(radiusKm / 3), Math.round((radiusKm * 2) / 3), radiusKm];
      ctx.strokeStyle = "rgba(16,185,129,0.25)";
      ctx.lineWidth = 1;
      ctx.font = "10px Inter, sans-serif";
      ctx.fillStyle = "rgba(16,185,129,0.55)";
      for (const rKm of rings) {
        const rPx = rKm * scalePxPerKm;
        if (rPx > maxRadiusPx + 2) continue;
        ctx.beginPath();
        ctx.arc(cx, cy, rPx, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillText(`${rKm}km`, cx + 4, cy - rPx - 2);
      }

      // Croix graduée
      ctx.strokeStyle = "rgba(16,185,129,0.12)";
      ctx.beginPath();
      ctx.moveTo(cx - maxRadiusPx, cy);
      ctx.lineTo(cx + maxRadiusPx, cy);
      ctx.moveTo(cx, cy - maxRadiusPx);
      ctx.lineTo(cx, cy + maxRadiusPx);
      ctx.stroke();

      // Balayage radar (sweep) — cône dégradé tournant
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(sweepAngleRef.current);
      const ctxAny = ctx as CanvasRenderingContext2D & { createConicGradient?: (startAngle: number, x: number, y: number) => CanvasGradient };
      const sweepGrad = typeof ctxAny.createConicGradient === "function"
        ? ctxAny.createConicGradient(0, 0, 0)
        : null;
      if (sweepGrad) {
        sweepGrad.addColorStop(0, "rgba(16,185,129,0.35)");
        sweepGrad.addColorStop(0.06, "rgba(16,185,129,0.08)");
        sweepGrad.addColorStop(0.12, "rgba(16,185,129,0)");
        sweepGrad.addColorStop(1, "rgba(16,185,129,0)");
        ctx.fillStyle = sweepGrad;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.arc(0, 0, maxRadiusPx, 0, Math.PI * 2);
        ctx.fill();
      } else {
        // Fallback sans createConicGradient : simple arc translucide
        ctx.fillStyle = "rgba(16,185,129,0.12)";
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.arc(0, 0, maxRadiusPx, -0.18, 0);
        ctx.closePath();
        ctx.fill();
      }
      ctx.restore();

      // Corridors (lignes pointillées animées entre zones)
      if (showCorridors) {
        const dashOffset = (ts * 0.03) % 16;
        for (const c of corridors) {
          // Les corridors n'ont pas de lat/lng direct — approximés via heatspots si dispo
          const from = heatspots.find((hsp) => hsp.zone_id === c.from_zone);
          const to = heatspots.find((hsp) => hsp.zone_id === c.to_zone);
          if (!from || !to) continue;
          const p1 = project(from.lat, from.lng, scalePxPerKm, w, h);
          const p2 = project(to.lat, to.lng, scalePxPerKm, w, h);
          ctx.save();
          ctx.setLineDash([6, 6]);
          ctx.lineDashOffset = -dashOffset;
          ctx.strokeStyle = "rgba(56,189,248,0.55)";
          ctx.lineWidth = Math.min(4, 1 + c.count_chauffeurs / 4);
          ctx.beginPath();
          ctx.moveTo(p1.x, p1.y);
          ctx.lineTo(p2.x, p2.y);
          ctx.stroke();
          ctx.restore();
        }
      }

      // Heatspots pulsants
      if (showHeatspots) {
        for (const hspot of heatspots) {
          const p = project(hspot.lat, hspot.lng, scalePxPerKm, w, h);
          if (p.x < -20 || p.x > w + 20 || p.y < -20 || p.y > h + 20) continue;
          const baseR = 6 + (hspot.intensity / 100) * 16;
          const pulse = 1 + Math.sin(pulseRef.current + hspot.lat * 10) * 0.15;
          const r = baseR * pulse;
          const alpha = 0.15 + (hspot.intensity / 100) * 0.35;
          const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r * 2.2);
          grad.addColorStop(0, `rgba(249,115,22,${alpha + 0.25})`);
          grad.addColorStop(0.5, `rgba(249,115,22,${alpha})`);
          grad.addColorStop(1, "rgba(249,115,22,0)");
          ctx.fillStyle = grad;
          ctx.beginPath();
          ctx.arc(p.x, p.y, r * 2.2, 0, Math.PI * 2);
          ctx.fill();

          ctx.fillStyle = "rgba(249,115,22,0.9)";
          ctx.beginPath();
          ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // Convergences — anneaux d'alerte
      for (const conv of convergences) {
        const p = project(conv.lat, conv.lng, scalePxPerKm, w, h);
        const ringPulse = 1 + Math.sin(pulseRef.current * 1.6) * 0.2;
        ctx.strokeStyle = "rgba(239,68,68,0.75)";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(p.x, p.y, (10 + conv.count_chauffeurs) * ringPulse, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = "rgba(239,68,68,0.9)";
        ctx.font = "bold 10px Inter, sans-serif";
        ctx.fillText(`⚠ ${conv.count_chauffeurs}`, p.x + 12, p.y - 12);
      }

      // Blips animés (autres chauffeurs)
      if (showBlips) {
        animatedBlipsRef.current.forEach((b) => {
          const p = project(b.lat, b.lng, scalePxPerKm, w, h);
          if (p.x < -20 || p.x > w + 20 || p.y < -20 || p.y > h + 20) return;

          // Petite dérive visuelle organique (le serveur ne renvoie qu'un
          // point toutes les 5s — on anime doucement autour pour donner vie)
          const jitterX = Math.cos(b.driftAngle + ts * 0.0004) * 2;
          const jitterY = Math.sin(b.driftAngle + ts * 0.0004) * 2;

          const freshness = Math.max(0, 1 - b.age_sec / 300);
          const alpha = 0.35 + freshness * 0.65;

          ctx.save();
          ctx.translate(p.x + jitterX, p.y + jitterY);
          if (b.direction_deg != null) ctx.rotate((b.direction_deg * Math.PI) / 180);

          // Triangle façon "avion" (Flightradar-like)
          ctx.fillStyle = `rgba(52,211,153,${alpha})`;
          ctx.beginPath();
          ctx.moveTo(0, -6);
          ctx.lineTo(4, 5);
          ctx.lineTo(0, 2.5);
          ctx.lineTo(-4, 5);
          ctx.closePath();
          ctx.fill();

          // Halo léger
          ctx.strokeStyle = `rgba(52,211,153,${alpha * 0.4})`;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(0, 0, 9, 0, Math.PI * 2);
          ctx.stroke();
          ctx.restore();
        });
      }

      // Position du chauffeur — toujours au centre
      ctx.fillStyle = "#22d3ee";
      ctx.beginPath();
      ctx.arc(cx, cy, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "rgba(34,211,238,0.4)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(cx, cy, 10 + Math.sin(pulseRef.current * 2) * 2, 0, Math.PI * 2);
      ctx.stroke();

      rafRef.current = requestAnimationFrame(drawFrame);
    }

    rafRef.current = requestAnimationFrame(drawFrame);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [dims, radiusKm, heatspots, convergences, corridors, showBlips, showHeatspots, showCorridors, project]);

  // ── Interaction tactile/click : détecte le blip/heatspot le plus proche ──
  const handleCanvasClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const clickX = e.clientX - rect.left;
      const clickY = e.clientY - rect.top;

      const w = dims.w;
      const h = dims.h;
      const maxRadiusPx = Math.min(w, h) / 2 - 24;
      const scalePxPerKm = maxRadiusPx / Math.max(0.5, radiusKm);

      let best: SelectedInfo | null = null;
      let bestDist = 26; // rayon de tolérance tap (accessible, ~44px zone effective)

      if (showHeatspots) {
        for (const hspot of heatspots) {
          const p = project(hspot.lat, hspot.lng, scalePxPerKm, w, h);
          const d = Math.hypot(p.x - clickX, p.y - clickY);
          if (d < bestDist) {
            bestDist = d;
            const distKm = haversineKm(center, hspot);
            const fare = estimateFare(distKm);
            best = {
              kind: "heatspot",
              x: p.x,
              y: p.y,
              title: hspot.zone_name || "Zone chaude",
              lines: [
                `Intensité : ${hspot.intensity}/100`,
                `Distance : ${distKm.toFixed(1)} km`,
                `Tarif estimé : ~${fare.toFixed(2)} €`,
              ],
            };
          }
        }
      }

      if (showBlips) {
        animatedBlipsRef.current.forEach((b) => {
          const p = project(b.lat, b.lng, scalePxPerKm, w, h);
          const d = Math.hypot(p.x - clickX, p.y - clickY);
          if (d < bestDist) {
            bestDist = d;
            const distKm = haversineKm(center, b);
            const etaMin = b.speed_kmh && b.speed_kmh > 3 ? Math.round((distKm / b.speed_kmh) * 60) : Math.round((distKm / 25) * 60);
            best = {
              kind: "blip",
              x: p.x,
              y: p.y,
              title: "Chauffeur actif",
              lines: [
                `Distance : ${distKm.toFixed(1)} km`,
                `ETA estimé : ~${Math.max(1, etaMin)} min`,
                b.speed_kmh ? `Vitesse : ${Math.round(b.speed_kmh)} km/h` : "Vitesse inconnue",
              ],
            };
          }
        });
      }

      for (const conv of convergences) {
        const p = project(conv.lat, conv.lng, scalePxPerKm, w, h);
        const d = Math.hypot(p.x - clickX, p.y - clickY);
        if (d < bestDist) {
          bestDist = d;
          best = {
            kind: "convergence",
            x: p.x,
            y: p.y,
            title: "Convergence détectée",
            lines: [`${conv.count_chauffeurs} chauffeurs sur ${conv.radius_m}m`, "Risque de sur-concentration — envisagez une autre zone"],
          };
        }
      }

      setSelected(best);
    },
    [dims, radiusKm, heatspots, convergences, showBlips, showHeatspots, center, estimateFare, project]
  );

  return (
    <div ref={containerRef} className="relative w-full h-full min-h-[280px]" data-testid="community-radar-canvas">
      <canvas
        ref={canvasRef}
        onClick={handleCanvasClick}
        className="w-full h-full touch-manipulation"
        role="img"
        aria-label="Radar aérien communautaire — chauffeurs actifs, zones chaudes et convergences autour de vous"
      />

      {selected && (
        <div
          className="absolute z-10 max-w-[220px] rounded-lg bg-black/90 border border-emerald-400/30 backdrop-blur px-3 py-2 text-white shadow-xl"
          style={{
            left: Math.min(Math.max(selected.x, 8), dims.w - 200),
            top: Math.min(Math.max(selected.y - 10, 8), dims.h - 90),
            transform: "translateY(-100%)",
          }}
          data-testid="radar-info-bubble"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-bold">{selected.title}</span>
            <button
              type="button"
              onClick={() => setSelected(null)}
              aria-label="Fermer"
              className="text-white/60 hover:text-white"
              style={{ minWidth: 20, minHeight: 20 }}
            >
              ✕
            </button>
          </div>
          {selected.lines.map((line, i) => (
            <div key={i} className="text-[11px] text-white/80 mt-0.5">{line}</div>
          ))}
        </div>
      )}
    </div>
  );
}
