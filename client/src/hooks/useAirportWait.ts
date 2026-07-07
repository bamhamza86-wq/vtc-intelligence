/**
 * useAirportWait — Détection géofence aéroport & FIFO estimé (Vague 1 - Levier 6)
 * ─────────────────────────────────────────────────────────────────────────────
 * Détecte si le chauffeur est dans le parking d'attente CDG/Orly/Beauvais.
 * Démarre un timer local dès l'entrée et enregistre les cycles pour estimer
 * un temps d'attente moyen. Utilisable pour "sortir de la file en avance"
 * (par ex. si un pic de demande imminent en zone voisine).
 *
 * Zones parking d'attente (approximation) :
 *   - CDG-VTC : 49.0025, 2.5606  (rayon 700 m)
 *   - ORY-VTC : 48.7317, 2.3596  (rayon 500 m)
 *   - BVA-VTC : 49.4526, 2.1128  (rayon 500 m)
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { useEffect, useState, useRef } from "react";
import { useGpsPosition } from "./useGpsPosition";

export interface AirportZone {
  code: "CDG" | "ORY" | "BVA";
  name: string;
  lat: number;
  lng: number;
  radiusM: number;
}

const ZONES: AirportZone[] = [
  { code: "CDG", name: "CDG parking VTC", lat: 49.0025, lng: 2.5606, radiusM: 700 },
  { code: "ORY", name: "Orly parking VTC", lat: 48.7317, lng: 2.3596, radiusM: 500 },
  { code: "BVA", name: "Beauvais parking VTC", lat: 49.4526, lng: 2.1128, radiusM: 500 },
];

function distanceM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const LS_HISTORY = "vtc.airportWait.history";

interface WaitEntry {
  code: string;
  enteredAt: number;
  exitedAt: number;
  durationMin: number;
}

function readHistory(): WaitEntry[] {
  try {
    return JSON.parse(localStorage.getItem(LS_HISTORY) || "[]");
  } catch {
    return [];
  }
}

function saveHistory(h: WaitEntry[]) {
  try {
    localStorage.setItem(LS_HISTORY, JSON.stringify(h.slice(-50)));
  } catch {}
}

export function useAirportWait() {
  const { position } = useGpsPosition();
  const [currentZone, setCurrentZone] = useState<AirportZone | null>(null);
  const [enteredAt, setEnteredAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const enteredRef = useRef<number | null>(null);
  const zoneRef = useRef<AirportZone | null>(null);

  // Tick horloge (1s) pour rafraîchir le temps écoulé
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Détection géofence
  useEffect(() => {
    if (!position.lat || !position.lng) return;
    const zone = ZONES.find(
      (z) => distanceM(position.lat, position.lng, z.lat, z.lng) <= z.radiusM,
    ) || null;

    if (zone && zoneRef.current?.code !== zone.code) {
      const t = Date.now();
      enteredRef.current = t;
      zoneRef.current = zone;
      setEnteredAt(t);
      setCurrentZone(zone);
    } else if (!zone && zoneRef.current) {
      // Sortie de zone : enregistre le cycle
      if (enteredRef.current) {
        const durationMin = Math.round((Date.now() - enteredRef.current) / 60000);
        if (durationMin >= 2) {
          const h = readHistory();
          h.push({
            code: zoneRef.current.code,
            enteredAt: enteredRef.current,
            exitedAt: Date.now(),
            durationMin,
          });
          saveHistory(h);
        }
      }
      enteredRef.current = null;
      zoneRef.current = null;
      setEnteredAt(null);
      setCurrentZone(null);
    }
  }, [position.lat, position.lng]);

  const elapsedMin = enteredAt ? Math.floor((now - enteredAt) / 60000) : 0;

  // Moyenne des attentes précédentes sur cette zone (7 derniers cycles)
  let avgWaitMin: number | null = null;
  if (currentZone) {
    const relevant = readHistory()
      .filter((h) => h.code === currentZone.code)
      .slice(-7);
    if (relevant.length >= 2) {
      avgWaitMin = Math.round(
        relevant.reduce((s, h) => s + h.durationMin, 0) / relevant.length,
      );
    }
  }

  return { currentZone, elapsedMin, avgWaitMin };
}
