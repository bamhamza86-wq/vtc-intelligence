/**
 * flightService.ts — Service d'intégration données de vols en temps réel
 * Sources : OpenSky Network (gratuit, sans clé) + fallback heuristique
 *
 * CDG ICAO : LFPG  (lat: 49.0097, lon: 2.5479)
 * Orly ICAO : LFPO  (lat: 48.7262, lon: 2.3652)
 */

import https from "https";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface Flight {
  icao24: string;
  callsign: string;
  origin_country: string;
  origin_airport?: string;
  destination?: string;
  departure_time?: number;   // epoch UTC
  arrival_time?: number;     // epoch UTC (estimée)
  estimated_arrival?: string; // ISO string local
  status: "arriving" | "departing" | "landed" | "scheduled";
  airport: "CDG" | "ORLY";
  terminal?: string;
  passengers_estimate?: number;
  vtc_demand_boost: number;  // multiplicateur score profitabilité
  distance_km_from_airport?: number;
}

export interface FlightStats {
  airport: "CDG" | "ORLY";
  arrivals_next_hour: number;
  departures_next_hour: number;
  total_active: number;
  peak_level: "low" | "medium" | "high" | "surge";
  vtc_demand_boost: number;
  next_wave_eta?: string;     // ISO string de la prochaine vague d'arrivées
  passenger_volume_estimate: number;
  last_updated: string;
}

export interface FlightData {
  cdg: FlightStats;
  orly: FlightStats;
  flights: Flight[];
  source: "opensky" | "heuristic";
  last_updated: string;
}

// ─── Cache (TTL 4 min pour OpenSky, 1 min pour heuristique) ──────────────────

let cache: { data: FlightData; fetchedAt: number } | null = null;
const CACHE_TTL_MS = 4 * 60 * 1000;

// ─── OpenSky Network — Arrivées CDG & Orly ──────────────────────────────────

function fetchOpenSkyArrivals(icao: string): Promise<any[]> {
  const now = Math.floor(Date.now() / 1000);
  const begin = now - 2 * 3600; // 2h passées
  const end = now;
  const url = `https://opensky-network.org/api/flights/arrival?airport=${icao}&begin=${begin}&end=${end}`;

  return new Promise((resolve) => {
    const req = https.get(url, {
      headers: { "User-Agent": "VTC-Intelligence/1.0" },
      timeout: 5000,
    }, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        try {
          if (res.statusCode === 200) {
            resolve(JSON.parse(body) || []);
          } else {
            resolve([]);
          }
        } catch {
          resolve([]);
        }
      });
    });
    req.on("error", () => resolve([]));
    req.on("timeout", () => { req.destroy(); resolve([]); });
  });
}

function fetchOpenSkyDepartures(icao: string): Promise<any[]> {
  const now = Math.floor(Date.now() / 1000);
  const begin = now - 3600;
  const end = now + 3600;
  const url = `https://opensky-network.org/api/flights/departure?airport=${icao}&begin=${begin}&end=${end}`;

  return new Promise((resolve) => {
    const req = https.get(url, {
      headers: { "User-Agent": "VTC-Intelligence/1.0" },
      timeout: 5000,
    }, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        try {
          if (res.statusCode === 200) {
            resolve(JSON.parse(body) || []);
          } else {
            resolve([]);
          }
        } catch {
          resolve([]);
        }
      });
    });
    req.on("error", () => resolve([]));
    req.on("timeout", () => { req.destroy(); resolve([]); });
  });
}

// ─── Heuristique réaliste CDG/Orly par heure ─────────────────────────────────
// Basé sur les données ADP (Aéroports de Paris) publiées
// CDG : ~600 mouvements/jour, ~50k passagers, 24h/24
// Orly : ~230 mouvements/jour, ~25k passagers, 6h-23h

const CDG_HOURLY_PATTERN: Record<number, { arrivals: number; departures: number }> = {
  0:  { arrivals: 3,  departures: 1  },
  1:  { arrivals: 2,  departures: 1  },
  2:  { arrivals: 2,  departures: 1  },
  3:  { arrivals: 3,  departures: 4  },
  4:  { arrivals: 6,  departures: 8  },
  5:  { arrivals: 8,  departures: 14 },
  6:  { arrivals: 12, departures: 18 },
  7:  { arrivals: 18, departures: 22 },
  8:  { arrivals: 22, departures: 26 },
  9:  { arrivals: 24, departures: 24 },
  10: { arrivals: 26, departures: 22 },
  11: { arrivals: 24, departures: 20 },
  12: { arrivals: 22, departures: 20 },
  13: { arrivals: 24, departures: 22 },
  14: { arrivals: 26, departures: 22 },
  15: { arrivals: 28, departures: 24 },
  16: { arrivals: 30, departures: 26 },
  17: { arrivals: 28, departures: 24 },
  18: { arrivals: 26, departures: 20 },
  19: { arrivals: 24, departures: 18 },
  20: { arrivals: 22, departures: 16 },
  21: { arrivals: 18, departures: 12 },
  22: { arrivals: 12, departures: 8  },
  23: { arrivals: 6,  departures: 3  },
};

const ORLY_HOURLY_PATTERN: Record<number, { arrivals: number; departures: number }> = {
  0:  { arrivals: 0,  departures: 0  },
  1:  { arrivals: 0,  departures: 0  },
  2:  { arrivals: 0,  departures: 0  },
  3:  { arrivals: 0,  departures: 0  },
  4:  { arrivals: 0,  departures: 0  },
  5:  { arrivals: 0,  departures: 0  },
  6:  { arrivals: 2,  departures: 4  },
  7:  { arrivals: 6,  departures: 10 },
  8:  { arrivals: 10, departures: 14 },
  9:  { arrivals: 12, departures: 12 },
  10: { arrivals: 10, departures: 10 },
  11: { arrivals: 8,  departures: 8  },
  12: { arrivals: 8,  departures: 8  },
  13: { arrivals: 10, departures: 10 },
  14: { arrivals: 12, departures: 10 },
  15: { arrivals: 14, departures: 12 },
  16: { arrivals: 16, departures: 14 },
  17: { arrivals: 14, departures: 12 },
  18: { arrivals: 12, departures: 10 },
  19: { arrivals: 10, departures: 8  },
  20: { arrivals: 8,  departures: 6  },
  21: { arrivals: 6,  departures: 4  },
  22: { arrivals: 4,  departures: 2  },
  23: { arrivals: 2,  departures: 0  },
};

// Passagers moyen par vol (mix court/long courrier)
const CDG_PAX_PER_FLIGHT = 165;
const ORLY_PAX_PER_FLIGHT = 140;

// Taux passagers qui prennent un VTC (environ 12% CDG, 9% Orly)
const CDG_VTC_RATE = 0.12;
const ORLY_VTC_RATE = 0.09;

function computePeakLevel(arrivalsPerHour: number, airport: "CDG" | "ORLY"): FlightStats["peak_level"] {
  const threshold = airport === "CDG" ? { low: 8, medium: 18, high: 26 } : { low: 4, medium: 9, high: 14 };
  if (arrivalsPerHour >= threshold.high) return "surge";
  if (arrivalsPerHour >= threshold.medium) return "high";
  if (arrivalsPerHour >= threshold.low) return "medium";
  return "low";
}

function computeVtcBoost(peakLevel: FlightStats["peak_level"]): number {
  return { low: 1.0, medium: 1.25, high: 1.55, surge: 1.90 }[peakLevel];
}

// Prochaine vague d'arrivées (dans les 2h suivantes)
function computeNextWave(currentHour: number, pattern: Record<number, { arrivals: number; departures: number }>, airport: "CDG" | "ORLY"): string | undefined {
  const peakThreshold = airport === "CDG" ? 22 : 12;
  for (let delta = 1; delta <= 3; delta++) {
    const h = (currentHour + delta) % 24;
    if ((pattern[h]?.arrivals || 0) >= peakThreshold) {
      const waveDate = new Date();
      waveDate.setHours(h, 0, 0, 0);
      if (h <= currentHour) waveDate.setDate(waveDate.getDate() + 1);
      return waveDate.toISOString();
    }
  }
  return undefined;
}

// ─── Mapping callsign → aéroport d'origine (simplifié) ───────────────────────
const INTERCONTINENTAL_CARRIERS = ["DAL","UAL","AAL","AFR","BAW","KLM","DLH","AZA","EID","QTR","UAE","SIA","CPA","JAL","ANA","KAL","THA","QFA","EKQ"];

function guessPassengersFromCallsign(callsign: string): number {
  const prefix = callsign.replace(/\d+/g, "").toUpperCase().trim();
  const isIntercontinental = INTERCONTINENTAL_CARRIERS.includes(prefix);
  return isIntercontinental ? 240 : 145;
}

// ─── Construction des stats depuis OpenSky ───────────────────────────────────

function buildStatsFromOpenSky(
  arrivals: any[],
  departures: any[],
  airport: "CDG" | "ORLY",
  icao: string
): { stats: FlightStats; flights: Flight[] } {
  const now = Date.now() / 1000;
  const oneHourLater = now + 3600;

  // Arrivées dans la prochaine heure (lastSeen proche de now)
  const arrivingNow = arrivals.filter(f => {
    const eta = f.lastSeen || f.firstSeen || 0;
    return eta > now - 1800 && eta < oneHourLater;
  });

  const departingNow = departures.filter(f => {
    const etd = f.firstSeen || 0;
    return etd > now && etd < oneHourLater;
  });

  const peakLevel = computePeakLevel(arrivingNow.length, airport);
  const vtcBoost = computeVtcBoost(peakLevel);
  const paxRate = airport === "CDG" ? CDG_VTC_RATE : ORLY_VTC_RATE;
  const paxPerFlight = airport === "CDG" ? CDG_PAX_PER_FLIGHT : ORLY_PAX_PER_FLIGHT;

  const passengerVol = Math.round(arrivingNow.length * paxPerFlight * paxRate);

  const flights: Flight[] = arrivingNow.slice(0, 20).map(f => {
    const cs = (f.callsign || "").trim() || `UNKN-${airport}`;
    const pax = guessPassengersFromCallsign(cs);
    const arrivalEpoch = f.lastSeen || now + Math.random() * 3600;
    return {
      icao24: f.icao24 || "",
      callsign: cs,
      origin_country: f.estDepartureAirport?.slice(0, 2) || "??",
      origin_airport: f.estDepartureAirport || undefined,
      arrival_time: arrivalEpoch,
      estimated_arrival: new Date(arrivalEpoch * 1000).toISOString(),
      status: "arriving",
      airport,
      passengers_estimate: pax,
      vtc_demand_boost: vtcBoost,
    };
  });

  const stats: FlightStats = {
    airport,
    arrivals_next_hour: arrivingNow.length,
    departures_next_hour: departingNow.length,
    total_active: arrivals.length + departures.length,
    peak_level: peakLevel,
    vtc_demand_boost: vtcBoost,
    passenger_volume_estimate: passengerVol,
    last_updated: new Date().toISOString(),
  };

  return { stats, flights };
}

// ─── Construction des stats heuristiques ─────────────────────────────────────

function buildHeuristicStats(airport: "CDG" | "ORLY"): { stats: FlightStats; flights: Flight[] } {
  const now = new Date();
  const h = now.getHours();
  const pattern = airport === "CDG" ? CDG_HOURLY_PATTERN : ORLY_HOURLY_PATTERN;
  const pat = pattern[h] || { arrivals: 0, departures: 0 };

  // Variance ±15% réaliste
  const variance = () => 1 + (Math.random() * 0.3 - 0.15);
  const arrivalsRaw = Math.round(pat.arrivals * variance());
  const departuresRaw = Math.round(pat.departures * variance());

  const peakLevel = computePeakLevel(arrivalsRaw, airport);
  const vtcBoost = computeVtcBoost(peakLevel);
  const paxRate = airport === "CDG" ? CDG_VTC_RATE : ORLY_VTC_RATE;
  const paxPerFlight = airport === "CDG" ? CDG_PAX_PER_FLIGHT : ORLY_PAX_PER_FLIGHT;

  const passengerVol = Math.round(arrivalsRaw * paxPerFlight * paxRate);
  const nextWave = computeNextWave(h, pattern, airport);

  // Génération de vols simulés réalistes
  const CARRIERS_CDG = ["AF","BA","KL","LH","EK","QR","TK","IB","SK","AY","FR","U2","W6","DY","VY","TO"];
  const CARRIERS_ORLY = ["AF","BJ","TO","TU","HV","PC","V7","UX","VY","I2","XK","SS"];
  const carriers = airport === "CDG" ? CARRIERS_CDG : CARRIERS_ORLY;
  const ORIGINS_CDG = ["JFK","LAX","DXB","LHR","AMS","FRA","MAD","FCO","JNB","SIN","HKG","NRT","YUL","GRU"];
  const ORIGINS_ORLY = ["OPO","BCN","MAD","LIS","TUN","CMN","ALG","ORN","TLM","AGA","RAK","MRS","NTE","BOD","TLS"];
  const origins = airport === "CDG" ? ORIGINS_CDG : ORIGINS_ORLY;

  const flights: Flight[] = Array.from({ length: Math.min(arrivalsRaw, 15) }, (_, i) => {
    const carrier = carriers[i % carriers.length];
    const flightNum = 100 + Math.floor(Math.random() * 899);
    const origin = origins[i % origins.length];
    const minutesOffset = Math.floor(Math.random() * 55) + 2;
    const arrivalTime = new Date(now.getTime() + minutesOffset * 60000);
    const pax = airport === "CDG"
      ? (INTERCONTINENTAL_CARRIERS.includes(carrier.padEnd(3).toUpperCase()) ? 240 : 155)
      : 140;
    return {
      icao24: `${carrier}${flightNum}`.toLowerCase(),
      callsign: `${carrier}${flightNum}`,
      origin_country: origin.slice(0, 2),
      origin_airport: origin,
      arrival_time: arrivalTime.getTime() / 1000,
      estimated_arrival: arrivalTime.toISOString(),
      status: "arriving",
      airport,
      passengers_estimate: pax,
      vtc_demand_boost: vtcBoost,
    };
  });

  const stats: FlightStats = {
    airport,
    arrivals_next_hour: arrivalsRaw,
    departures_next_hour: departuresRaw,
    total_active: arrivalsRaw + departuresRaw,
    peak_level: peakLevel,
    vtc_demand_boost: vtcBoost,
    next_wave_eta: nextWave,
    passenger_volume_estimate: passengerVol,
    last_updated: now.toISOString(),
  };

  return { stats, flights };
}

// ─── Fonction principale ──────────────────────────────────────────────────────

export async function getFlightData(): Promise<FlightData> {
  // Retourne le cache si valide
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.data;
  }

  let source: "opensky" | "heuristic" = "heuristic";
  let cdgStats: FlightStats;
  let orlyStats: FlightStats;
  let allFlights: Flight[] = [];

  try {
    // Tentative OpenSky (timeout global 6s)
    const [cdgArr, orlyArr, cdgDep, orlyDep] = await Promise.all([
      fetchOpenSkyArrivals("LFPG"),
      fetchOpenSkyArrivals("LFPO"),
      fetchOpenSkyDepartures("LFPG"),
      fetchOpenSkyDepartures("LFPO"),
    ]);

    if (cdgArr.length > 0 || orlyArr.length > 0) {
      source = "opensky";
      const cdgResult = buildStatsFromOpenSky(cdgArr, cdgDep, "CDG", "LFPG");
      const orlyResult = buildStatsFromOpenSky(orlyArr, orlyDep, "ORLY", "LFPO");
      cdgStats = cdgResult.stats;
      orlyStats = orlyResult.stats;
      allFlights = [...cdgResult.flights, ...orlyResult.flights];
    } else {
      throw new Error("OpenSky returned empty data");
    }
  } catch {
    // Fallback heuristique
    const cdgResult = buildHeuristicStats("CDG");
    const orlyResult = buildHeuristicStats("ORLY");
    cdgStats = cdgResult.stats;
    orlyStats = orlyResult.stats;
    allFlights = [...cdgResult.flights, ...orlyResult.flights];
    source = "heuristic";
  }

  const data: FlightData = {
    cdg: cdgStats!,
    orly: orlyStats!,
    flights: allFlights,
    source,
    last_updated: new Date().toISOString(),
  };

  cache = { data, fetchedAt: Date.now() };
  return data;
}

// ─── Calcul du boost profitabilité pour une zone ──────────────────────────────

export function getFlightBoostForZone(zoneId: string, flightData: FlightData): number {
  if (zoneId === "z_cdg") return flightData.cdg.vtc_demand_boost;
  if (zoneId === "z_orly") return flightData.orly.vtc_demand_boost;

  // Zones proches des aéroports bénéficient d'un boost réduit
  const CDG_PROXIMITY_ZONES = ["z_villepinte", "z_tremblay", "z_le_bourget", "z_aulnay"];
  const ORLY_PROXIMITY_ZONES = ["z_montreuil"];

  if (CDG_PROXIMITY_ZONES.includes(zoneId)) {
    return 1.0 + (flightData.cdg.vtc_demand_boost - 1.0) * 0.3;
  }
  if (ORLY_PROXIMITY_ZONES.includes(zoneId)) {
    return 1.0 + (flightData.orly.vtc_demand_boost - 1.0) * 0.2;
  }
  return 1.0;
}
