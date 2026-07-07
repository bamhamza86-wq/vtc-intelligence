/**
 * trustEngine.ts — Couche TRUST & TRANSPARENCE (gaps benchmark)
 * ═════════════════════════════════════════════════════════════════════════════
 * Inspiré des gaps identifiés chez la concurrence :
 *   - Para        : révélation du pourboire probable avant/pendant la course, flags client
 *   - Mystro      : historique complet des offres reçues, y compris refusées/expirées,
 *                   avec analyse a posteriori "quelles auraient été les meilleures"
 *   - Everlance   : garantie / bouclier d'audit fiscal (inventaire justificatifs, score conformité)
 *   - Stride      : marketplace de transparence assurance/plateformes (ici : comparateur
 *                   commissions Uber/Bolt/Heetch/FreeNow)
 *
 * Honnêteté technique : le "pourboire prédit" est une ESTIMATION statistique basée
 * sur l'historique local (zone/heure/jour), jamais présentée comme une certitude.
 * Le "score de conformité fiscale" est indicatif, pas un avis fiscal officiel.
 *
 * ZÉRO nouvelle dépendance npm — pattern identique à fatigueCoach.ts : connexion
 * SQLite dédiée sur le même fichier data.db (WAL, multi-connexion supportée).
 * Toutes les tables sont additives (CREATE TABLE IF NOT EXISTS).
 * ═════════════════════════════════════════════════════════════════════════════
 */

import Database from "better-sqlite3";

const db = new Database("data.db");
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");

export const DEFAULT_USER = "root";

// ─────────────────────────────────────────────────────────────────────────────
// Schéma
// ─────────────────────────────────────────────────────────────────────────────
db.exec(`
  -- 1. Flags clients (positifs/négatifs) — inspiré Para
  CREATE TABLE IF NOT EXISTS client_flags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL DEFAULT 'root',
    client_ref TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('positif','negatif')),
    tag TEXT NOT NULL CHECK(tag IN ('ponctuel','pourboire','agressif','malpoli','généreux','prof')),
    note TEXT,
    ts TEXT NOT NULL DEFAULT (datetime('now')),
    source TEXT NOT NULL DEFAULT 'user' CHECK(source IN ('user','community'))
  );
  CREATE INDEX IF NOT EXISTS idx_client_flags_user ON client_flags(user_id);
  CREATE INDEX IF NOT EXISTS idx_client_flags_ref ON client_flags(client_ref);

  -- 2. Tags de lieu (hotspot/safe/dangereux/zone morte/contrôle police)
  CREATE TABLE IF NOT EXISTS location_flags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL DEFAULT 'root',
    address TEXT NOT NULL,
    lat REAL,
    lng REAL,
    type TEXT NOT NULL CHECK(type IN ('hotspot','safe','dangereux','zone_morte','contrôle_police')),
    note TEXT,
    votes INTEGER NOT NULL DEFAULT 1,
    ts TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_location_flags_user ON location_flags(user_id);

  -- 3. Historique COMPLET des offres reçues (acceptées + refusées + expirées) — inspiré Mystro
  CREATE TABLE IF NOT EXISTS offers_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL DEFAULT 'root',
    ts TEXT NOT NULL DEFAULT (datetime('now')),
    platform TEXT NOT NULL,
    zone_pickup TEXT,
    zone_dropoff TEXT,
    fare REAL NOT NULL,
    distance_km REAL,
    duration_min REAL,
    status TEXT NOT NULL CHECK(status IN ('acceptée','refusée','expirée')),
    reason TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_offers_history_user ON offers_history(user_id, ts);

  -- 4. Journal d'incidents
  CREATE TABLE IF NOT EXISTS incidents_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL DEFAULT 'root',
    ts TEXT NOT NULL DEFAULT (datetime('now')),
    type TEXT NOT NULL CHECK(type IN ('agression','arnaque','impayé','dispute','autre')),
    description TEXT,
    plateforme TEXT,
    montant REAL,
    resolu INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_incidents_log_user ON incidents_log(user_id, ts);

  -- 5. Preuves géolocalisées (litiges)
  CREATE TABLE IF NOT EXISTS geo_proofs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL DEFAULT 'root',
    ts TEXT NOT NULL DEFAULT (datetime('now')),
    lat REAL NOT NULL,
    lng REAL NOT NULL,
    context TEXT,
    signature TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_geo_proofs_user ON geo_proofs(user_id, ts);

  -- 6. Pourboires observés (historique pour prédiction statistique)
  CREATE TABLE IF NOT EXISTS tip_observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL DEFAULT 'root',
    ts TEXT NOT NULL DEFAULT (datetime('now')),
    zone_pickup TEXT NOT NULL,
    zone_dropoff TEXT NOT NULL,
    hour INTEGER NOT NULL,
    day TEXT NOT NULL,
    fare REAL NOT NULL,
    tip_amount REAL NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_tip_observations_zone ON tip_observations(zone_pickup, zone_dropoff);
`);

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
function nowIso(): string {
  return new Date().toISOString();
}

function simpleHash(input: string): string {
  // Signature simple (non-cryptographique forte, mais déterministe et vérifiable)
  // pour horodater/scellerune preuve géolocalisée sans dépendance npm supplémentaire.
  let h1 = 0xdeadbeef ^ input.length;
  let h2 = 0x41c6ce57 ^ input.length;
  for (let i = 0; i < input.length; i++) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const combined = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return combined.toString(36).toUpperCase();
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Prévision de pourboire probable — POST /api/trust/tip-forecast
// ─────────────────────────────────────────────────────────────────────────────
export interface TipForecastInput {
  zone_pickup: string;
  zone_dropoff: string;
  hour: number;
  day: string;
  fare: number;
}

export interface TipForecastResult {
  probable_tip_eur: number;
  probable_tip_pct: number;
  confidence: number;
  sample_size: number;
  basis_fr: string;
}

export function forecastTip(userId: string, input: TipForecastInput): TipForecastResult {
  const { zone_pickup, zone_dropoff, hour, day, fare } = input;

  // Recherche des observations similaires (même paire de zones en priorité, sinon zone pickup seule)
  const exact = db
    .prepare(
      `SELECT tip_amount, fare FROM tip_observations
       WHERE user_id = ? AND zone_pickup = ? AND zone_dropoff = ?`
    )
    .all(userId, zone_pickup, zone_dropoff) as { tip_amount: number; fare: number }[];

  const byPickup = db
    .prepare(`SELECT tip_amount, fare FROM tip_observations WHERE user_id = ? AND zone_pickup = ?`)
    .all(userId, zone_pickup) as { tip_amount: number; fare: number }[];

  const all = db
    .prepare(`SELECT tip_amount, fare FROM tip_observations WHERE user_id = ?`)
    .all(userId) as { tip_amount: number; fare: number }[];

  let pool = exact;
  let basis = `historique exact ${zone_pickup} → ${zone_dropoff}`;
  if (pool.length < 3) {
    pool = byPickup;
    basis = `historique zone de prise en charge "${zone_pickup}"`;
  }
  if (pool.length < 3) {
    pool = all;
    basis = "historique global (données insuffisantes sur cette zone précise)";
  }

  // Facteur heure de pointe / soirée (les pourboires tendent à être plus généreux le soir/weekend)
  const isEvening = hour >= 20 || hour < 2;
  const isWeekend = ["samedi", "dimanche"].includes(day.toLowerCase());
  let hourBoost = 1;
  if (isEvening) hourBoost += 0.15;
  if (isWeekend) hourBoost += 0.1;

  if (pool.length === 0) {
    // Cold start : estimation générique IDF ~ 5-8% de la course
    const pct = 6 * hourBoost;
    const eur = Math.round(((fare * pct) / 100) * 100) / 100;
    return {
      probable_tip_eur: eur,
      probable_tip_pct: Math.round(pct * 10) / 10,
      confidence: 0.2,
      sample_size: 0,
      basis_fr: "estimation générique (pas encore de données locales sur cette zone) — se précisera avec l'usage",
    };
  }

  const avgPct = pool.reduce((acc, r) => acc + (r.fare > 0 ? (r.tip_amount / r.fare) * 100 : 0), 0) / pool.length;
  const adjustedPct = avgPct * hourBoost;
  const eur = Math.round(((fare * adjustedPct) / 100) * 100) / 100;
  const confidence = Math.min(0.95, 0.3 + pool.length * 0.05);

  return {
    probable_tip_eur: eur,
    probable_tip_pct: Math.round(adjustedPct * 10) / 10,
    confidence: Math.round(confidence * 100) / 100,
    sample_size: pool.length,
    basis_fr: `${basis}${isEvening ? ", créneau soirée (+15%)" : ""}${isWeekend ? ", weekend (+10%)" : ""}`,
  };
}

export function recordTipObservation(
  userId: string,
  data: { zone_pickup: string; zone_dropoff: string; hour: number; day: string; fare: number; tip_amount: number }
) {
  const info = db
    .prepare(
      `INSERT INTO tip_observations (user_id, ts, zone_pickup, zone_dropoff, hour, day, fare, tip_amount)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(userId, nowIso(), data.zone_pickup, data.zone_dropoff, data.hour, data.day, data.fare, data.tip_amount);
  return { id: Number(info.lastInsertRowid) };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Flags clients — CRUD /api/trust/flags
// ─────────────────────────────────────────────────────────────────────────────
export interface ClientFlag {
  id?: number;
  client_ref: string;
  type: "positif" | "negatif";
  tag: "ponctuel" | "pourboire" | "agressif" | "malpoli" | "généreux" | "prof";
  note?: string;
  source?: "user" | "community";
}

export function listClientFlags(userId: string) {
  return db
    .prepare(`SELECT * FROM client_flags WHERE user_id = ? ORDER BY ts DESC`)
    .all(userId);
}

export function createClientFlag(userId: string, flag: ClientFlag) {
  const info = db
    .prepare(
      `INSERT INTO client_flags (user_id, client_ref, type, tag, note, ts, source)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(userId, flag.client_ref, flag.type, flag.tag, flag.note ?? null, nowIso(), flag.source ?? "user");
  return { id: Number(info.lastInsertRowid) };
}

export function updateClientFlag(userId: string, id: number, flag: Partial<ClientFlag>) {
  const existing = db.prepare(`SELECT * FROM client_flags WHERE id = ? AND user_id = ?`).get(id, userId);
  if (!existing) return null;
  const merged = { ...(existing as any), ...flag };
  db.prepare(
    `UPDATE client_flags SET client_ref=?, type=?, tag=?, note=? WHERE id=? AND user_id=?`
  ).run(merged.client_ref, merged.type, merged.tag, merged.note ?? null, id, userId);
  return db.prepare(`SELECT * FROM client_flags WHERE id = ?`).get(id);
}

export function deleteClientFlag(userId: string, id: number) {
  const info = db.prepare(`DELETE FROM client_flags WHERE id = ? AND user_id = ?`).run(id, userId);
  return { deleted: info.changes > 0 };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Tags de lieu — CRUD /api/trust/locations
// ─────────────────────────────────────────────────────────────────────────────
export interface LocationFlag {
  id?: number;
  address: string;
  lat?: number;
  lng?: number;
  type: "hotspot" | "safe" | "dangereux" | "zone_morte" | "contrôle_police";
  note?: string;
  votes?: number;
}

export function listLocationFlags(userId: string) {
  return db
    .prepare(`SELECT * FROM location_flags WHERE user_id = ? ORDER BY ts DESC`)
    .all(userId);
}

export function createLocationFlag(userId: string, loc: LocationFlag) {
  const info = db
    .prepare(
      `INSERT INTO location_flags (user_id, address, lat, lng, type, note, votes, ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(userId, loc.address, loc.lat ?? null, loc.lng ?? null, loc.type, loc.note ?? null, loc.votes ?? 1, nowIso());
  return { id: Number(info.lastInsertRowid) };
}

export function voteLocationFlag(userId: string, id: number, delta: number) {
  db.prepare(`UPDATE location_flags SET votes = votes + ? WHERE id = ? AND user_id = ?`).run(delta, id, userId);
  return db.prepare(`SELECT * FROM location_flags WHERE id = ?`).get(id);
}

export function deleteLocationFlag(userId: string, id: number) {
  const info = db.prepare(`DELETE FROM location_flags WHERE id = ? AND user_id = ?`).run(id, userId);
  return { deleted: info.changes > 0 };
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Historique offres complet — GET /api/trust/all-offers
// ─────────────────────────────────────────────────────────────────────────────
export function recordOffer(
  userId: string,
  offer: {
    platform: string;
    zone_pickup?: string;
    zone_dropoff?: string;
    fare: number;
    distance_km?: number;
    duration_min?: number;
    status: "acceptée" | "refusée" | "expirée";
    reason?: string;
  }
) {
  const info = db
    .prepare(
      `INSERT INTO offers_history (user_id, ts, platform, zone_pickup, zone_dropoff, fare, distance_km, duration_min, status, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      userId,
      nowIso(),
      offer.platform,
      offer.zone_pickup ?? null,
      offer.zone_dropoff ?? null,
      offer.fare,
      offer.distance_km ?? null,
      offer.duration_min ?? null,
      offer.status,
      offer.reason ?? null
    );
  return { id: Number(info.lastInsertRowid) };
}

export interface AllOffersResult {
  offers: any[];
  stats: {
    total: number;
    acceptées: number;
    refusées: number;
    expirées: number;
    ca_total_accepte: number;
    ca_manque_estime_refuse: number;
    meilleur_taux_horaire_zone: string | null;
  };
  analyse_fr: string;
}

export function getAllOffers(userId: string, statusFilter?: string, limit = 200): AllOffersResult {
  let query = `SELECT * FROM offers_history WHERE user_id = ?`;
  const params: any[] = [userId];
  if (statusFilter && ["acceptée", "refusée", "expirée"].includes(statusFilter)) {
    query += ` AND status = ?`;
    params.push(statusFilter);
  }
  query += ` ORDER BY ts DESC LIMIT ?`;
  params.push(limit);

  const offers = db.prepare(query).all(...params) as any[];

  const all = db.prepare(`SELECT * FROM offers_history WHERE user_id = ?`).all(userId) as any[];
  const accepted = all.filter((o) => o.status === "acceptée");
  const refused = all.filter((o) => o.status === "refusée");
  const expired = all.filter((o) => o.status === "expirée");

  const ca_total_accepte = Math.round(accepted.reduce((a, o) => a + o.fare, 0) * 100) / 100;
  const ca_manque_estime_refuse = Math.round(refused.reduce((a, o) => a + o.fare, 0) * 100) / 100;

  // "Quelles auraient été les meilleures" : taux €/km parmi les offres refusées avec distance connue
  const withRate = all
    .filter((o) => o.distance_km && o.distance_km > 0)
    .map((o) => ({ ...o, rate: o.fare / o.distance_km }));
  let bestZone: string | null = null;
  if (withRate.length > 0) {
    const best = withRate.reduce((a, b) => (b.rate > a.rate ? b : a));
    bestZone = best.zone_pickup ? `${best.zone_pickup} (${best.rate.toFixed(2)} €/km, ${best.status})` : null;
  }

  let analyse = `${all.length} offres enregistrées : ${accepted.length} acceptées, ${refused.length} refusées, ${expired.length} expirées. `;
  if (refused.length > 0) {
    analyse += `Le manque à gagner potentiel des courses refusées est estimé à ${ca_manque_estime_refuse.toFixed(2)} € (hors contexte de refus, parfois justifié). `;
  }
  if (bestZone) {
    analyse += `La meilleure offre en €/km observée provient de : ${bestZone}.`;
  }

  return {
    offers,
    stats: {
      total: all.length,
      acceptées: accepted.length,
      refusées: refused.length,
      expirées: expired.length,
      ca_total_accepte,
      ca_manque_estime_refuse,
      meilleur_taux_horaire_zone: bestZone,
    },
    analyse_fr: analyse,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Bouclier fiscal / audit shield — GET /api/trust/audit-shield
// ─────────────────────────────────────────────────────────────────────────────
export interface AuditShieldResult {
  score_conformite: number; // 0-100
  statut: "protégé" | "vigilance" | "risque";
  inventaire: { categorie: string; ok: boolean; detail_fr: string }[];
  actions_recommandees_fr: string[];
}

export function getAuditShield(userId: string): AuditShieldResult {
  // Vérifie l'existence de données dans les tables fiscales existantes du repo
  // (tax_journal / fuel_receipts si présentes) pour construire un inventaire réaliste.
  const inventaire: { categorie: string; ok: boolean; detail_fr: string }[] = [];

  function tableExists(name: string): boolean {
    const row = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
      .get(name) as { name: string } | undefined;
    return !!row;
  }

  function countRows(table: string, userCol = "user_id"): number {
    try {
      const row = db.prepare(`SELECT COUNT(*) as n FROM ${table} WHERE ${userCol} = ?`).get(userId) as { n: number };
      return row?.n ?? 0;
    } catch {
      return 0;
    }
  }

  // Kilométrage
  let kmCount = 0;
  if (tableExists("mileage_log")) kmCount = countRows("mileage_log");
  else if (tableExists("trips")) kmCount = countRows("trips");
  inventaire.push({
    categorie: "Kilométrage",
    ok: kmCount > 0,
    detail_fr: kmCount > 0 ? `${kmCount} trajets journalisés` : "Aucun relevé kilométrique détecté — tiens un carnet de bord pour justifier le barème IK",
  });

  // Frais / dépenses
  let fraisCount = 0;
  if (tableExists("fuel_receipts")) fraisCount = countRows("fuel_receipts");
  inventaire.push({
    categorie: "Frais (carburant, entretien)",
    ok: fraisCount > 0,
    detail_fr: fraisCount > 0 ? `${fraisCount} justificatifs de frais enregistrés` : "Aucun justificatif de frais retrouvé — conserve toutes tes factures (carburant, entretien, péage)",
  });

  // Factures / revenus plateformes
  let revenuCount = 0;
  if (tableExists("platform_stats")) revenuCount = countRows("platform_stats");
  inventaire.push({
    categorie: "Factures / relevés plateformes",
    ok: revenuCount > 0,
    detail_fr: revenuCount > 0 ? `${revenuCount} relevés de revenus plateformes disponibles` : "Télécharge tes relevés mensuels Uber/Bolt/Heetch/FreeNow chaque mois",
  });

  // Incidents / litiges documentés (pertinent en cas de contrôle)
  const incidentCount = countRows("incidents_log");
  inventaire.push({
    categorie: "Incidents documentés",
    ok: true, // informatif, pas bloquant
    detail_fr: incidentCount > 0 ? `${incidentCount} incidents journalisés (utile en cas de litige/contrôle)` : "Aucun incident journalisé pour le moment",
  });

  // Preuves géolocalisées
  const geoCount = countRows("geo_proofs");
  inventaire.push({
    categorie: "Preuves géolocalisées",
    ok: geoCount > 0,
    detail_fr: geoCount > 0 ? `${geoCount} preuves horodatées enregistrées` : "Aucune preuve géolocalisée enregistrée — utile en cas de contestation de course",
  });

  const okCount = inventaire.filter((i) => i.ok).length;
  const score = Math.round((okCount / inventaire.length) * 100);

  const statut: AuditShieldResult["statut"] = score >= 80 ? "protégé" : score >= 50 ? "vigilance" : "risque";

  const actions: string[] = [];
  for (const item of inventaire) {
    if (!item.ok) actions.push(item.detail_fr);
  }
  if (actions.length === 0) {
    actions.push("Ta documentation est complète — continue à archiver tes justificatifs chaque mois.");
  }

  return {
    score_conformite: score,
    statut,
    inventaire,
    actions_recommandees_fr: actions,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Vérification passager instantanée — GET /api/trust/passenger-lookup
// ─────────────────────────────────────────────────────────────────────────────
export function lookupPassenger(userId: string, phone: string) {
  const flags = db
    .prepare(`SELECT * FROM client_flags WHERE user_id = ? AND client_ref = ? ORDER BY ts DESC`)
    .all(userId, phone) as any[];

  if (flags.length === 0) {
    return {
      found: false,
      client_ref: phone,
      verdict_fr: "Aucun historique connu pour ce numéro — première course probable ou non renseigné.",
      flags: [],
    };
  }

  const positives = flags.filter((f) => f.type === "positif");
  const negatives = flags.filter((f) => f.type === "negatif");

  let verdict = "";
  if (negatives.length > positives.length) {
    verdict = `⚠️ ${negatives.length} signalement(s) négatif(s) enregistré(s) (${negatives.map((f) => f.tag).join(", ")}). Reste vigilant.`;
  } else if (positives.length > 0) {
    verdict = `✅ Client bien noté : ${positives.length} signalement(s) positif(s) (${positives.map((f) => f.tag).join(", ")}).`;
  } else {
    verdict = "Historique mixte, pas de tendance nette.";
  }

  return {
    found: true,
    client_ref: phone,
    verdict_fr: verdict,
    flags,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. Comparateur commissions plateformes — GET /api/trust/commission-comparator
// ─────────────────────────────────────────────────────────────────────────────
export interface CommissionRow {
  plateforme: string;
  commission_pct_normale: number;
  commission_pct_creneau_actuel: number;
  creneau_fr: string;
  net_pour_100e_course: number;
  note_fr: string;
}

export function getCommissionComparator(hour?: number): { creneau_analyse: string; tableau: CommissionRow[]; conseil_fr: string } {
  const h = hour ?? new Date().getUTCHours() + 2;
  const isPeak = (h >= 7 && h <= 9) || (h >= 17 && h <= 20) || h >= 22 || h < 2;
  const creneau_fr = isPeak ? "heure de pointe / soirée" : "heure creuse";

  // Valeurs de référence indicatives (documentées publiquement, variables selon zones/périodes réelles)
  const base: { plateforme: string; normale: number; peakDelta: number; note: string }[] = [
    { plateforme: "Uber", normale: 25, peakDelta: -2, note: "Commission variable selon programme fidélité chauffeur" },
    { plateforme: "Bolt", normale: 20, peakDelta: -1.5, note: "Commission parmi les plus basses du marché IDF" },
    { plateforme: "Heetch", normale: 15, peakDelta: -1, note: "Modèle plus favorable sur courses courtes" },
    { plateforme: "FreeNow", normale: 18, peakDelta: -1, note: "Commission stable, peu de variation horaire" },
  ];

  const tableau: CommissionRow[] = base.map((p) => {
    const pctCreneau = Math.max(5, p.normale + (isPeak ? p.peakDelta : 0));
    return {
      plateforme: p.plateforme,
      commission_pct_normale: p.normale,
      commission_pct_creneau_actuel: Math.round(pctCreneau * 10) / 10,
      creneau_fr,
      net_pour_100e_course: Math.round((100 - pctCreneau) * 100) / 100,
      note_fr: p.note,
    };
  });

  const best = tableau.reduce((a, b) => (b.net_pour_100e_course > a.net_pour_100e_course ? b : a));
  const conseil = `Sur ce créneau (${creneau_fr}), ${best.plateforme} laisse le plus net au chauffeur (${best.net_pour_100e_course.toFixed(2)} € pour 100 € de course). Ces chiffres sont indicatifs — vérifie tes relevés réels pour confirmer.`;

  return { creneau_analyse: creneau_fr, tableau, conseil_fr: conseil };
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. Journal d'incidents — CRUD /api/trust/incidents
// ─────────────────────────────────────────────────────────────────────────────
export interface IncidentEntry {
  id?: number;
  type: "agression" | "arnaque" | "impayé" | "dispute" | "autre";
  description?: string;
  plateforme?: string;
  montant?: number;
  resolu?: boolean;
}

export function listIncidents(userId: string) {
  return db.prepare(`SELECT * FROM incidents_log WHERE user_id = ? ORDER BY ts DESC`).all(userId);
}

export function createIncident(userId: string, entry: IncidentEntry) {
  const info = db
    .prepare(
      `INSERT INTO incidents_log (user_id, ts, type, description, plateforme, montant, resolu)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      userId,
      nowIso(),
      entry.type,
      entry.description ?? null,
      entry.plateforme ?? null,
      entry.montant ?? null,
      entry.resolu ? 1 : 0
    );
  return { id: Number(info.lastInsertRowid) };
}

export function updateIncident(userId: string, id: number, entry: Partial<IncidentEntry>) {
  const existing = db.prepare(`SELECT * FROM incidents_log WHERE id = ? AND user_id = ?`).get(id, userId) as any;
  if (!existing) return null;
  const merged = { ...existing, ...entry };
  db.prepare(
    `UPDATE incidents_log SET type=?, description=?, plateforme=?, montant=?, resolu=? WHERE id=? AND user_id=?`
  ).run(
    merged.type,
    merged.description ?? null,
    merged.plateforme ?? null,
    merged.montant ?? null,
    merged.resolu ? 1 : 0,
    id,
    userId
  );
  return db.prepare(`SELECT * FROM incidents_log WHERE id = ?`).get(id);
}

export function deleteIncident(userId: string, id: number) {
  const info = db.prepare(`DELETE FROM incidents_log WHERE id = ? AND user_id = ?`).run(id, userId);
  return { deleted: info.changes > 0 };
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. Preuve géolocalisée — POST /api/trust/geo-proof
// ─────────────────────────────────────────────────────────────────────────────
export function createGeoProof(userId: string, data: { lat: number; lng: number; context?: string }) {
  const ts = nowIso();
  const payload = `${userId}|${ts}|${data.lat}|${data.lng}|${data.context ?? ""}`;
  const signature = simpleHash(payload);
  const info = db
    .prepare(
      `INSERT INTO geo_proofs (user_id, ts, lat, lng, context, signature) VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(userId, ts, data.lat, data.lng, data.context ?? null, signature);
  return {
    id: Number(info.lastInsertRowid),
    ts,
    lat: data.lat,
    lng: data.lng,
    context: data.context ?? null,
    signature,
    verification_note_fr:
      "Signature générée localement à partir de l'horodatage et de la position — à joindre à un dossier de litige comme preuve de bonne foi.",
  };
}

export function listGeoProofs(userId: string, limit = 50) {
  return db
    .prepare(`SELECT * FROM geo_proofs WHERE user_id = ? ORDER BY ts DESC LIMIT ?`)
    .all(userId, limit);
}

// ─────────────────────────────────────────────────────────────────────────────
// SEED DATA — données de démonstration (idempotent : ne s'exécute qu'une fois)
// ─────────────────────────────────────────────────────────────────────────────
export function seedDemoData(userId: string = DEFAULT_USER) {
  const existing = db.prepare(`SELECT COUNT(*) as n FROM client_flags WHERE user_id = ?`).get(userId) as { n: number };
  if (existing.n > 0) return { seeded: false, reason: "already_seeded" };

  const tx = db.transaction(() => {
    // 3 flags démo (2 positifs, 1 négatif)
    createClientFlag(userId, { client_ref: "+33612345678", type: "positif", tag: "généreux", note: "Toujours un pourboire, très sympa", source: "user" });
    createClientFlag(userId, { client_ref: "+33698765432", type: "positif", tag: "ponctuel", note: "Toujours à l'heure au point de RDV", source: "user" });
    createClientFlag(userId, { client_ref: "+33655511122", type: "negatif", tag: "agressif", note: "Ton agressif, a claqué la porte", source: "community" });

    // 4 zones flaggées démo
    createLocationFlag(userId, { address: "Gare du Nord, Paris", lat: 48.8809, lng: 2.3553, type: "hotspot", note: "Forte demande matin/soir, arrivées TGV/Eurostar", votes: 12 });
    createLocationFlag(userId, { address: "Aéroport CDG Terminal 2E", lat: 49.0042, lng: 2.5700, type: "hotspot", note: "File organisée, bonne rotation en journée", votes: 18 });
    createLocationFlag(userId, { address: "Porte de la Chapelle, Paris", lat: 48.8977, lng: 2.3606, type: "dangereux", note: "Signalements de tensions la nuit", votes: 7 });
    createLocationFlag(userId, { address: "Zone industrielle Rungis nuit", lat: 48.7539, lng: 2.3567, type: "zone_morte", note: "Aucune demande après 22h", votes: 4 });

    // 5 incidents historiques mixtes
    createIncident(userId, { type: "impayé", description: "Client parti sans payer le supplément bagages", plateforme: "Uber", montant: 12.5, resolu: true });
    createIncident(userId, { type: "dispute", description: "Contestation itinéraire jugé trop long par le client", plateforme: "Bolt", montant: 8, resolu: true });
    createIncident(userId, { type: "agression", description: "Insultes verbales suite à un refus de fumer dans le véhicule", plateforme: "Heetch", montant: 0, resolu: false });
    createIncident(userId, { type: "arnaque", description: "Fausse réclamation objet perdu pour obtenir un remboursement", plateforme: "Uber", montant: 15, resolu: true });
    createIncident(userId, { type: "autre", description: "Client malade dans le véhicule, nettoyage nécessaire", plateforme: "FreeNow", montant: 40, resolu: false });

    // 20 offres historiques factices (10 acceptées, 8 refusées, 2 expirées)
    const zones = ["Châtelet", "Gare de Lyon", "La Défense", "Bastille", "Montparnasse", "République", "Opéra", "Nation"];
    const platforms = ["Uber", "Bolt", "Heetch", "FreeNow"];
    let seq = 0;
    for (let i = 0; i < 10; i++) {
      const zp = zones[i % zones.length];
      const zd = zones[(i + 3) % zones.length];
      recordOffer(userId, {
        platform: platforms[i % platforms.length],
        zone_pickup: zp,
        zone_dropoff: zd,
        fare: 12 + (i % 5) * 4.5,
        distance_km: 3 + (i % 6),
        duration_min: 10 + (i % 6) * 3,
        status: "acceptée",
        reason: "Course rentable acceptée",
      });
      seq++;
    }
    for (let i = 0; i < 8; i++) {
      const zp = zones[(i + 1) % zones.length];
      const zd = zones[(i + 5) % zones.length];
      recordOffer(userId, {
        platform: platforms[i % platforms.length],
        zone_pickup: zp,
        zone_dropoff: zd,
        fare: 6 + (i % 4) * 2,
        distance_km: 8 + (i % 5) * 2,
        duration_min: 20 + (i % 5) * 4,
        status: "refusée",
        reason: i % 2 === 0 ? "Tarif trop bas pour la distance" : "Zone d'arrivée peu rentable",
      });
      seq++;
    }
    for (let i = 0; i < 2; i++) {
      const zp = zones[(i + 2) % zones.length];
      const zd = zones[(i + 6) % zones.length];
      recordOffer(userId, {
        platform: platforms[i % platforms.length],
        zone_pickup: zp,
        zone_dropoff: zd,
        fare: 14 + i * 3,
        distance_km: 5 + i,
        duration_min: 15 + i * 2,
        status: "expirée",
        reason: "Non traitée à temps",
      });
      seq++;
    }

    // Quelques observations de pourboire pour amorcer la prévision
    recordTipObservation(userId, { zone_pickup: "Gare de Lyon", zone_dropoff: "La Défense", hour: 21, day: "vendredi", fare: 28, tip_amount: 3 });
    recordTipObservation(userId, { zone_pickup: "Gare de Lyon", zone_dropoff: "La Défense", hour: 22, day: "samedi", fare: 32, tip_amount: 4.5 });
    recordTipObservation(userId, { zone_pickup: "Châtelet", zone_dropoff: "Bastille", hour: 13, day: "mardi", fare: 10, tip_amount: 0.5 });
    recordTipObservation(userId, { zone_pickup: "Opéra", zone_dropoff: "Nation", hour: 23, day: "samedi", fare: 18, tip_amount: 3 });

    return seq;
  });

  const offersCount = tx();
  return { seeded: true, offers_created: offersCount };
}
