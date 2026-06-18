/**
 * platformDemand.ts
 * Connexions aux plateformes VTC externes (Uber Riders API + GigData)
 * pour estimer la demande/offre temps réel dans les zones 93/CDG/Orly
 */

// Node 18+ a fetch natif — pas de dépendance node-fetch
const fetch = globalThis.fetch;

// ─── UBER RIDERS API ───────────────────────────────────────────────────────────
// Utilise l'endpoint public /v1/products + /v1.2/estimates/time
// pour estimer le nombre de véhicules disponibles (proxy offre)
// Docs : https://developer.uber.com/docs/riders/references/api

const UBER_API_BASE = "https://api.uber.com";

// Centres approximatifs des zones 93 + CDG + Orly
const ZONE_COORDS: Record<string, { lat: number; lng: number; name: string }> = {
  z_cdg:               { lat: 49.0097, lng: 2.5479, name: "CDG" },
  z_orly:              { lat: 48.7262, lng: 2.3652, name: "Orly" },
  z_saint_denis_gare:  { lat: 48.9362, lng: 2.3560, name: "Saint-Denis Gare" },
  z_bobigny_gare:      { lat: 48.9011, lng: 2.4400, name: "Bobigny" },
  z_aubervilliers:     { lat: 48.9144, lng: 2.3831, name: "Aubervilliers" },
  z_plaine_commune:    { lat: 48.9221, lng: 2.3427, name: "Plaine Commune" },
  z_le_bourget:        { lat: 48.9411, lng: 2.4256, name: "Le Bourget" },
  z_villepinte:        { lat: 48.9668, lng: 2.5311, name: "Villepinte" },
  z_tremblay:          { lat: 48.9578, lng: 2.5756, name: "Tremblay" },
  z_epinay_gennevilliers: { lat: 48.9510, lng: 2.3120, name: "Épinay/Gennevilliers" },
  z_montreuil:         { lat: 48.8636, lng: 2.4432, name: "Montreuil" },
  z_aulnay:            { lat: 48.9395, lng: 2.4978, name: "Aulnay" },
  z_93_centre:         { lat: 48.9200, lng: 2.3900, name: "93 Centre" },
  z_stade_france:      { lat: 48.9244, lng: 2.3600, name: "Stade de France" },
};

export interface ZoneDemandData {
  zone_id: string;
  zone_name: string;
  // Uber
  uber_eta_min: number | null;       // ETA Uber (proxy offre — bas = beaucoup de chauffeurs)
  uber_surge: number | null;         // Surge multiplier (proxy demande)
  uber_products_count: number | null; // Nombre de produits disponibles
  uber_status: "ok" | "no_data" | "error";
  // GigData
  gigdata_demand_index: number | null;  // Indice demande 0-100
  gigdata_supply_index: number | null;  // Indice offre 0-100
  gigdata_platforms: string[];          // Plateformes actives dans la zone
  gigdata_status: "ok" | "no_data" | "error";
  // Méta
  fetched_at: string;
}

// ─── UBER ────────────────────────────────────────────────────────────────────

async function getUberToken(clientId: string, clientSecret: string): Promise<string | null> {
  try {
    const creds = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
    const resp = await fetch(`${UBER_API_BASE}/oauth/v2/token`, {
      method: "POST",
      headers: {
        "Authorization": `Basic ${creds}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials&scope=ride_widgets",
    });
    if (!resp.ok) return null;
    const data = await resp.json() as any;
    return data.access_token || null;
  } catch {
    return null;
  }
}

export async function testUberConnection(apiKey: string): Promise<{ ok: boolean; error?: string }> {
  const [clientId, clientSecret] = apiKey.split(":");
  if (!clientId || !clientSecret) return { ok: false, error: "Format invalide — attendu clientId:clientSecret" };

  // Test avec l'endpoint public products (ne nécessite qu'un server token ou client_credentials)
  try {
    const token = await getUberToken(clientId, clientSecret);
    if (!token) {
      // Essai avec server token direct (ancien format)
      const resp = await fetch(
        `${UBER_API_BASE}/v1/products?latitude=48.9362&longitude=2.3560`,
        { headers: { "Authorization": `Token ${clientId}` } }
      );
      if (resp.ok) return { ok: true };
      return { ok: false, error: `Authentification échouée (HTTP ${resp.status})` };
    }
    const resp = await fetch(
      `${UBER_API_BASE}/v1.2/estimates/time?start_latitude=48.9362&start_longitude=2.3560`,
      { headers: { "Authorization": `Bearer ${token}` } }
    );
    if (resp.ok) return { ok: true };
    return { ok: false, error: `API inaccessible (HTTP ${resp.status})` };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}

export async function fetchUberDemand(
  apiKey: string,
  zones: string[]
): Promise<Map<string, Partial<ZoneDemandData>>> {
  const results = new Map<string, Partial<ZoneDemandData>>();
  const [clientId, clientSecret] = apiKey.split(":");
  if (!clientId) return results;

  let token: string | null = null;
  let useServerToken = false;

  token = await getUberToken(clientId, clientSecret || "");
  if (!token) {
    // Fallback : clientId est peut-être un server token direct
    useServerToken = true;
  }

  const authHeader = useServerToken
    ? `Token ${clientId}`
    : `Bearer ${token}`;

  for (const zoneId of zones) {
    const coords = ZONE_COORDS[zoneId];
    if (!coords) continue;

    try {
      // ETA estimation = proxy offre (temps d'attente bas = beaucoup de chauffeurs)
      const etaResp = await fetch(
        `${UBER_API_BASE}/v1.2/estimates/time?start_latitude=${coords.lat}&start_longitude=${coords.lng}`,
        { headers: { "Authorization": authHeader } }
      );

      if (etaResp.ok) {
        const etaData = await etaResp.json() as any;
        const times: any[] = etaData.times || [];
        // Prendre le produit uberX ou équivalent
        const uberX = times.find((t: any) =>
          t.display_name?.toLowerCase().includes("x") || t.display_name?.toLowerCase().includes("berline")
        ) || times[0];

        const etaMin = uberX ? Math.round(uberX.estimate / 60) : null;

        // Price estimate pour détecter le surge
        const priceResp = await fetch(
          `${UBER_API_BASE}/v1.2/estimates/price?start_latitude=${coords.lat}&start_longitude=${coords.lng}&end_latitude=${coords.lat + 0.05}&end_longitude=${coords.lng + 0.05}`,
          { headers: { "Authorization": authHeader } }
        );
        let surge = 1.0;
        if (priceResp.ok) {
          const priceData = await priceResp.json() as any;
          const prices: any[] = priceData.prices || [];
          const xPrice = prices.find((p: any) => p.display_name?.toLowerCase().includes("x")) || prices[0];
          surge = xPrice?.surge_multiplier ?? 1.0;
        }

        results.set(zoneId, {
          uber_eta_min: etaMin,
          uber_surge: surge,
          uber_products_count: times.length,
          uber_status: "ok",
        });
      } else {
        results.set(zoneId, { uber_status: "error" });
      }
    } catch {
      results.set(zoneId, { uber_status: "error" });
    }

    // Rate limit Uber : 1 req/s
    await new Promise(r => setTimeout(r, 1000));
  }

  return results;
}

// ─── GIGDATA ─────────────────────────────────────────────────────────────────

const GIGDATA_BASE = "https://api.gigdata.fr/v1";

export async function testGigDataConnection(apiKey: string): Promise<{ ok: boolean; error?: string }> {
  if (!apiKey || apiKey.length < 8) return { ok: false, error: "Clé API invalide" };
  try {
    const resp = await fetch(`${GIGDATA_BASE}/status`, {
      headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    });
    if (resp.ok) return { ok: true };
    if (resp.status === 401) return { ok: false, error: "Clé API invalide ou expirée" };
    return { ok: false, error: `HTTP ${resp.status}` };
  } catch (e: any) {
    return { ok: false, error: e.message };
  }
}

export async function fetchGigDataDemand(
  apiKey: string,
  zones: string[]
): Promise<Map<string, Partial<ZoneDemandData>>> {
  const results = new Map<string, Partial<ZoneDemandData>>();
  if (!apiKey) return results;

  try {
    // GigData endpoint : demand signals par coordonnées
    const payload = {
      locations: zones.map(zoneId => {
        const c = ZONE_COORDS[zoneId];
        return { zone_id: zoneId, lat: c?.lat, lng: c?.lng };
      }).filter(l => l.lat),
      time: new Date().toISOString(),
    };

    const resp = await fetch(`${GIGDATA_BASE}/demand/realtime`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!resp.ok) {
      zones.forEach(z => results.set(z, { gigdata_status: "error" }));
      return results;
    }

    const data = await resp.json() as any;
    const locations: any[] = data.locations || data.data || [];

    for (const loc of locations) {
      const zoneId = loc.zone_id;
      if (!zoneId) continue;
      results.set(zoneId, {
        gigdata_demand_index: loc.demand_index ?? loc.demand ?? null,
        gigdata_supply_index: loc.supply_index ?? loc.supply ?? null,
        gigdata_platforms: loc.platforms || [],
        gigdata_status: "ok",
      });
    }

    // Zones sans données
    zones.forEach(z => {
      if (!results.has(z)) results.set(z, { gigdata_status: "no_data", gigdata_platforms: [] });
    });
  } catch {
    zones.forEach(z => results.set(z, { gigdata_status: "error", gigdata_platforms: [] }));
  }

  return results;
}

// ─── AGRÉGATEUR ──────────────────────────────────────────────────────────────

export async function fetchAllPlatformDemand(
  uberKey: string | null,
  gigdataKey: string | null,
  zones: string[] = Object.keys(ZONE_COORDS)
): Promise<ZoneDemandData[]> {
  const now = new Date().toISOString();

  // Fetch en parallèle
  const [uberData, gigData] = await Promise.all([
    uberKey ? fetchUberDemand(uberKey, zones) : Promise.resolve(new Map<string, Partial<ZoneDemandData>>()),
    gigdataKey ? fetchGigDataDemand(gigdataKey, zones) : Promise.resolve(new Map<string, Partial<ZoneDemandData>>()),
  ]);

  return zones.map(zoneId => {
    const coords = ZONE_COORDS[zoneId];
    const uber = uberData.get(zoneId) || {};
    const gig  = gigData.get(zoneId)  || {};
    return {
      zone_id:    zoneId,
      zone_name:  coords?.name ?? zoneId,
      uber_eta_min:       uber.uber_eta_min       ?? null,
      uber_surge:         uber.uber_surge         ?? null,
      uber_products_count: uber.uber_products_count ?? null,
      uber_status:        uber.uber_status        ?? "no_data",
      gigdata_demand_index: gig.gigdata_demand_index ?? null,
      gigdata_supply_index: gig.gigdata_supply_index ?? null,
      gigdata_platforms:  gig.gigdata_platforms   ?? [],
      gigdata_status:     gig.gigdata_status      ?? "no_data",
      fetched_at: now,
    };
  });
}
