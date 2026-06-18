/**
 * platformDemand.ts
 * Connexions aux plateformes externes pour estimer la demande/offre VTC
 *
 * - TomTom Traffic Flow API : congestion temps réel par zone (proxy demande)
 *   Clé gratuite : https://developer.tomtom.com — 2500 req/jour, sans CB
 *   1 seul champ : la clé API (format alphanumérique TomTom)
 *
 * - GigData : agrégateur Uber + Bolt + Heetch + FreeNow
 *   Clé : https://gigdata.fr — format sk_live_xxxx
 *   1 seul champ : la clé API
 */

const fetch = globalThis.fetch;

// ─── Coordonnées centres de zone ─────────────────────────────────────────────
// Point de référence : axe principal de la zone (autoroute ou boulevard majeur)
const ZONE_COORDS: Record<string, { lat: number; lng: number; name: string; road_point: string }> = {
  z_cdg:                  { lat: 49.0097, lng: 2.5479,  name: "CDG",                  road_point: "A1 CDG" },
  z_orly:                 { lat: 48.7262, lng: 2.3652,  name: "Orly",                 road_point: "A6 Orly" },
  z_saint_denis_gare:     { lat: 48.9362, lng: 2.3560,  name: "Saint-Denis Gare",     road_point: "D30 St-Denis" },
  z_bobigny_gare:         { lat: 48.9011, lng: 2.4400,  name: "Bobigny",              road_point: "A3 Bobigny" },
  z_aubervilliers:        { lat: 48.9144, lng: 2.3831,  name: "Aubervilliers",        road_point: "A1 Aubervilliers" },
  z_plaine_commune:       { lat: 48.9221, lng: 2.3427,  name: "Plaine Commune",       road_point: "D14 Plaine" },
  z_le_bourget:           { lat: 48.9411, lng: 2.4256,  name: "Le Bourget",           road_point: "A104 Bourget" },
  z_villepinte:           { lat: 48.9668, lng: 2.5311,  name: "Villepinte",           road_point: "A104 Villepinte" },
  z_tremblay:             { lat: 48.9578, lng: 2.5756,  name: "Tremblay",             road_point: "A104 Tremblay" },
  z_epinay_gennevilliers: { lat: 48.9510, lng: 2.3120,  name: "Épinay/Gennevilliers", road_point: "A15 Gennevilliers" },
  z_montreuil:            { lat: 48.8636, lng: 2.4432,  name: "Montreuil",            road_point: "A3 Montreuil" },
  z_aulnay:               { lat: 48.9395, lng: 2.4978,  name: "Aulnay",               road_point: "A3 Aulnay" },
  z_93_centre:            { lat: 48.9200, lng: 2.3900,  name: "93 Centre",            road_point: "N3 93 Centre" },
  z_stade_france:         { lat: 48.9244, lng: 2.3600,  name: "Stade de France",      road_point: "A1 Stade France" },
};

// ─── Interfaces ───────────────────────────────────────────────────────────────
export interface ZoneDemandData {
  zone_id:   string;
  zone_name: string;

  // TomTom Traffic Flow
  tomtom_current_speed:   number | null;  // km/h vitesse actuelle
  tomtom_freeflow_speed:  number | null;  // km/h vitesse fluide de référence
  tomtom_congestion_pct:  number | null;  // % congestion (0=fluide, 100=bloqué)
  tomtom_demand_signal:   number | null;  // signal demande 0-100 calculé depuis congestion
  tomtom_status: "ok" | "no_data" | "error";

  // GigData
  gigdata_demand_index:  number | null;
  gigdata_supply_index:  number | null;
  gigdata_platforms:     string[];
  gigdata_status: "ok" | "no_data" | "error";

  fetched_at: string;
}

// ─── TOMTOM TRAFFIC FLOW ─────────────────────────────────────────────────────
// Docs : https://developer.tomtom.com/traffic-api/documentation/traffic-flow/flow-segment-data
// Endpoint : GET /traffic/services/4/flowSegmentData/absolute/10/json
//   ?point={lat},{lng}&key={API_KEY}
// Retourne : currentSpeed, freeFlowSpeed, currentTravelTime, freeFlowTravelTime

const TOMTOM_BASE = "https://api.tomtom.com";

export async function testTomTomConnection(apiKey: string): Promise<{ ok: boolean; error?: string }> {
  if (!apiKey || apiKey.length < 10) return { ok: false, error: "Clé API invalide (trop courte)" };
  try {
    // Test sur l'axe A1 CDG — point fiable
    const url = `${TOMTOM_BASE}/traffic/services/4/flowSegmentData/absolute/10/json?point=49.0097,2.5479&key=${apiKey}`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (resp.ok) return { ok: true };
    if (resp.status === 403) return { ok: false, error: "Clé API invalide ou service non activé" };
    if (resp.status === 429) return { ok: false, error: "Quota journalier dépassé (2500 req/jour)" };
    return { ok: false, error: `HTTP ${resp.status}` };
  } catch (e: any) {
    return { ok: false, error: e.message ?? "Erreur réseau" };
  }
}

export async function fetchTomTomDemand(
  apiKey: string,
  zones: string[]
): Promise<Map<string, Partial<ZoneDemandData>>> {
  const results = new Map<string, Partial<ZoneDemandData>>();
  if (!apiKey) return results;

  // Appels en parallèle par batch de 5 (respecter rate-limit TomTom)
  const BATCH = 5;
  for (let i = 0; i < zones.length; i += BATCH) {
    const batch = zones.slice(i, i + BATCH);
    await Promise.all(batch.map(async (zoneId) => {
      const coords = ZONE_COORDS[zoneId];
      if (!coords) return;
      try {
        const url = `${TOMTOM_BASE}/traffic/services/4/flowSegmentData/absolute/10/json?point=${coords.lat},${coords.lng}&key=${apiKey}`;
        const resp = await fetch(url, { signal: AbortSignal.timeout(6000) });
        if (!resp.ok) {
          results.set(zoneId, { tomtom_status: resp.status === 429 ? "no_data" : "error" });
          return;
        }
        const data = await resp.json() as any;
        const flow = data.flowSegmentData;
        if (!flow) {
          results.set(zoneId, { tomtom_status: "no_data" });
          return;
        }
        const currentSpeed  = flow.currentSpeed   ?? null;  // km/h
        const freeflowSpeed = flow.freeFlowSpeed   ?? null;  // km/h
        // Congestion : 0% = fluide, 100% = bloqué
        const congestion = (currentSpeed && freeflowSpeed && freeflowSpeed > 0)
          ? Math.max(0, Math.min(100, Math.round((1 - currentSpeed / freeflowSpeed) * 100)))
          : null;
        // Signal demande : plus la congestion est élevée, plus il y a de demande VTC
        // Formule : demande = 20 + congestion × 0.8  (base 20, max 100)
        const demandSignal = congestion !== null
          ? Math.min(100, Math.round(20 + congestion * 0.8))
          : null;

        results.set(zoneId, {
          tomtom_current_speed:  currentSpeed,
          tomtom_freeflow_speed: freeflowSpeed,
          tomtom_congestion_pct: congestion,
          tomtom_demand_signal:  demandSignal,
          tomtom_status: "ok",
        });
      } catch {
        results.set(zoneId, { tomtom_status: "error" });
      }
    }));
    // Pause entre batches
    if (i + BATCH < zones.length) await new Promise(r => setTimeout(r, 300));
  }
  return results;
}

// ─── GIGDATA ─────────────────────────────────────────────────────────────────
const GIGDATA_BASE = "https://api.gigdata.fr/v1";

export async function testGigDataConnection(apiKey: string): Promise<{ ok: boolean; error?: string }> {
  if (!apiKey || apiKey.length < 8) return { ok: false, error: "Clé API invalide" };
  try {
    const resp = await fetch(`${GIGDATA_BASE}/status`, {
      headers: { "Authorization": `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(8000),
    });
    if (resp.ok) return { ok: true };
    if (resp.status === 401) return { ok: false, error: "Clé API invalide ou expirée" };
    return { ok: false, error: `HTTP ${resp.status}` };
  } catch (e: any) {
    return { ok: false, error: e.message ?? "Erreur réseau" };
  }
}

export async function fetchGigDataDemand(
  apiKey: string,
  zones: string[]
): Promise<Map<string, Partial<ZoneDemandData>>> {
  const results = new Map<string, Partial<ZoneDemandData>>();
  if (!apiKey) return results;
  try {
    const payload = {
      locations: zones.map(zoneId => {
        const c = ZONE_COORDS[zoneId];
        return { zone_id: zoneId, lat: c?.lat, lng: c?.lng };
      }).filter(l => l.lat),
      time: new Date().toISOString(),
    };
    const resp = await fetch(`${GIGDATA_BASE}/demand/realtime`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) { zones.forEach(z => results.set(z, { gigdata_status: "error" })); return results; }
    const data = await resp.json() as any;
    const locations: any[] = data.locations || data.data || [];
    for (const loc of locations) {
      const zoneId = loc.zone_id;
      if (!zoneId) continue;
      results.set(zoneId, {
        gigdata_demand_index: loc.demand_index ?? loc.demand ?? null,
        gigdata_supply_index: loc.supply_index ?? loc.supply ?? null,
        gigdata_platforms:    loc.platforms || [],
        gigdata_status: "ok",
      });
    }
    zones.forEach(z => { if (!results.has(z)) results.set(z, { gigdata_status: "no_data", gigdata_platforms: [] }); });
  } catch {
    zones.forEach(z => results.set(z, { gigdata_status: "error", gigdata_platforms: [] }));
  }
  return results;
}

// ─── AGRÉGATEUR ──────────────────────────────────────────────────────────────
export async function fetchAllPlatformDemand(
  tomtomKey: string | null,
  gigdataKey: string | null,
  zones: string[] = Object.keys(ZONE_COORDS)
): Promise<ZoneDemandData[]> {
  const now = new Date().toISOString();
  const [tomtomData, gigData] = await Promise.all([
    tomtomKey  ? fetchTomTomDemand(tomtomKey, zones)  : Promise.resolve(new Map<string, Partial<ZoneDemandData>>()),
    gigdataKey ? fetchGigDataDemand(gigdataKey, zones) : Promise.resolve(new Map<string, Partial<ZoneDemandData>>()),
  ]);
  return zones.map(zoneId => {
    const coords = ZONE_COORDS[zoneId];
    const tt  = tomtomData.get(zoneId) || {};
    const gig = gigData.get(zoneId)    || {};
    return {
      zone_id:   zoneId,
      zone_name: coords?.name ?? zoneId,
      tomtom_current_speed:  tt.tomtom_current_speed  ?? null,
      tomtom_freeflow_speed: tt.tomtom_freeflow_speed ?? null,
      tomtom_congestion_pct: tt.tomtom_congestion_pct ?? null,
      tomtom_demand_signal:  tt.tomtom_demand_signal  ?? null,
      tomtom_status:         tt.tomtom_status         ?? "no_data",
      gigdata_demand_index:  gig.gigdata_demand_index ?? null,
      gigdata_supply_index:  gig.gigdata_supply_index ?? null,
      gigdata_platforms:     gig.gigdata_platforms    ?? [],
      gigdata_status:        gig.gigdata_status       ?? "no_data",
      fetched_at: now,
    };
  });
}
