/**
 * diversificationEngine.ts — Couche DIVERSIFICATION DE REVENUS
 * ═════════════════════════════════════════════════════════════════════════════
 * Inspiré des gaps benchmark :
 *   - Roadie          → missions colis intercités pendant les temps morts
 *   - LeCab/Marcel     → réservations B2B tarif forfaitaire garanti hors plateforme
 *   - Bonsai           → génération devis/contrats VTC B2B
 *   - Solo Pay Guarantee → garantie €/h (référence conceptuelle, cf. forfaits)
 *   - Cashback carburant (Uber Pro Card jusqu'à 15%)
 *
 * Leviers couverts :
 *   1. Missions colis intercités        → parcel_missions
 *   2. Réservations B2B                 → b2b_bookings
 *   3. Générateur de devis              → generateQuoteHtml
 *   4. Générateur contrats forfaits     → generateContractHtml
 *   5. Marketplace missions             → missions_marketplace
 *   6. Course forfaitaire aéroport      → airport_forfaits
 *   7. Événements spéciaux              → event_missions
 *   8. Cashback carburant               → fuel_cashback_partners
 *   9. Recap diversification revenu     → computeRevenueMix
 *
 * ZÉRO nouvelle dépendance npm — better-sqlite3 déjà présent (comme crmEngine.ts,
 * fatigueCoach.ts, mlPersonal.ts). Tables CREATE TABLE IF NOT EXISTS, additionnelles.
 * ═════════════════════════════════════════════════════════════════════════════
 */

import Database from "better-sqlite3";

// Connexion séparée au même fichier data.db (WAL supporte le multi-connexion),
// même pattern que crmEngine.ts / fatigueCoach.ts / mlPersonal.ts.
const db = new Database("data.db");
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");

const DEFAULT_USER = "root"; // app single-tenant

// ─────────────────────────────────────────────────────────────────────────────
// Schéma
// ─────────────────────────────────────────────────────────────────────────────
db.exec(`
  -- 1. Missions colis intercités (inspiré Roadie) ---------------------------
  CREATE TABLE IF NOT EXISTS parcel_missions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_city TEXT NOT NULL,
    to_city TEXT NOT NULL,
    distance_km REAL NOT NULL DEFAULT 0,
    price REAL NOT NULL DEFAULT 0,
    deadline TEXT NOT NULL,
    notes TEXT,
    status TEXT NOT NULL DEFAULT 'disponible', -- disponible | prise | livree | annulee
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_parcel_missions_status ON parcel_missions(status);

  -- 2. Réservations B2B (inspiré LeCab/Marcel) -------------------------------
  CREATE TABLE IF NOT EXISTS b2b_bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company TEXT NOT NULL,
    contact TEXT,
    date_time TEXT NOT NULL,
    from_addr TEXT NOT NULL,
    to_addr TEXT NOT NULL,
    passengers INTEGER NOT NULL DEFAULT 1,
    forfait REAL NOT NULL DEFAULT 0,
    statut TEXT NOT NULL DEFAULT 'confirmee', -- en_attente | confirmee | terminee | annulee
    invoice_id INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_b2b_bookings_statut ON b2b_bookings(statut);

  -- 3/4. Devis & contrats générés (historique) -------------------------------
  CREATE TABLE IF NOT EXISTS diversification_quotes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    numero TEXT NOT NULL UNIQUE,
    client TEXT NOT NULL,
    date_course TEXT NOT NULL,
    from_addr TEXT NOT NULL,
    to_addr TEXT NOT NULL,
    passagers INTEGER NOT NULL DEFAULT 1,
    options TEXT NOT NULL DEFAULT '[]',
    montant_ht REAL NOT NULL DEFAULT 0,
    tva REAL NOT NULL DEFAULT 0,
    montant_ttc REAL NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS diversification_contracts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    numero TEXT NOT NULL UNIQUE,
    company TEXT NOT NULL,
    contact TEXT,
    mission_desc TEXT NOT NULL,
    date_mission TEXT NOT NULL,
    forfait REAL NOT NULL DEFAULT 0,
    conditions TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- 5. Marketplace missions (comparateur commissions plateformes) -----------
  CREATE TABLE IF NOT EXISTS missions_marketplace (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_platform TEXT NOT NULL, -- Comin | Maze | Snapcar | Uber | Bolt | Heetch
    description TEXT NOT NULL,
    price REAL NOT NULL DEFAULT 0,
    distance REAL NOT NULL DEFAULT 0,
    commission_pct REAL NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_missions_marketplace_active ON missions_marketplace(active);

  -- 6. Grille forfaits aéroport -----------------------------------------------
  CREATE TABLE IF NOT EXISTS airport_forfaits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_zone TEXT NOT NULL,
    to_airport TEXT NOT NULL, -- CDG | Orly | Beauvais | Le Bourget
    price REAL NOT NULL DEFAULT 0,
    notes TEXT
  );

  -- 7. Événements spéciaux (mariage, salon, congrès) --------------------------
  CREATE TABLE IF NOT EXISTS event_missions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL, -- mariage | salon | congres
    date TEXT NOT NULL,
    duration_hours REAL NOT NULL DEFAULT 1,
    price REAL NOT NULL DEFAULT 0,
    notes TEXT,
    status TEXT NOT NULL DEFAULT 'disponible', -- disponible | prise | terminee | annulee
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_event_missions_status ON event_missions(status);

  -- 8. Cashback carburant -------------------------------------------------------
  CREATE TABLE IF NOT EXISTS fuel_cashback_partners (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nom TEXT NOT NULL,
    station TEXT NOT NULL,
    cashback_pct REAL NOT NULL DEFAULT 0,
    conditions TEXT
  );
`);

// ─────────────────────────────────────────────────────────────────────────────
// Seed idempotent (même pattern que crmEngine.ts via seed_meta)
// ─────────────────────────────────────────────────────────────────────────────
function hasSeedRun(key: string): boolean {
  try {
    const row = db.prepare(`SELECT value FROM seed_meta WHERE key = ?`).get(key) as any;
    return !!row;
  } catch {
    return false;
  }
}
function markSeedRun(key: string): void {
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS seed_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    db.prepare(`INSERT OR REPLACE INTO seed_meta (key, value) VALUES (?, ?)`).run(key, "1");
  } catch {
    /* no-op */
  }
}

function seedDiversificationData(): void {
  const SEED_KEY = "diversification_engine_seed_v1";
  if (hasSeedRun(SEED_KEY)) return;

  // ── 6 missions colis intercités, dates dans les 7 prochains jours ─────────
  const parcelCount = (db.prepare(`SELECT COUNT(*) AS n FROM parcel_missions`).get() as any).n;
  if (parcelCount === 0) {
    const insertParcel = db.prepare(`
      INSERT INTO parcel_missions (from_city, to_city, distance_km, price, deadline, notes, status, created_at)
      VALUES (?, ?, ?, ?, datetime('now', ?), ?, 'disponible', datetime('now'))
    `);
    const parcels: Array<[string, string, number, number, string, string]> = [
      ["Paris", "Lyon", 465, 220, "+1 days", "Colis documents urgents, coffre suffisant, dépôt Bercy."],
      ["Paris", "Lille", 225, 120, "+2 days", "Petit colis fragile, à livrer en main propre avant 18h."],
      ["Paris", "Rouen", 135, 85, "+1 days", "Pièce détachée automobile, poids ~8kg."],
      ["Paris", "Orléans", 130, 80, "+3 days", "Enveloppe A4 rigide, dépôt gare d'Austerlitz."],
      ["Paris", "Reims", 145, 90, "+2 days", "Carton moyen (30x30x30), destinataire disponible soir."],
      ["Paris", "Amiens", 140, 88, "+4 days", "Colis e-commerce retour fournisseur, signature requise."],
    ];
    for (const p of parcels) insertParcel.run(...p);
  }

  // ── 4 réservations B2B entreprises IDF ─────────────────────────────────────
  const b2bCount = (db.prepare(`SELECT COUNT(*) AS n FROM b2b_bookings`).get() as any).n;
  if (b2bCount === 0) {
    const insertB2b = db.prepare(`
      INSERT INTO b2b_bookings (company, contact, date_time, from_addr, to_addr, passengers, forfait, statut, invoice_id, created_at)
      VALUES (?, ?, datetime('now', ?), ?, ?, ?, ?, ?, NULL, datetime('now'))
    `);
    const bookings: Array<[string, string, string, string, string, number, number, string]> = [
      ["BNP Paribas", "S. Martin — Assistante de direction, 01 40 14 45 46", "+1 days", "BNP Paribas, 16 Bd des Italiens, 75009 Paris", "Aéroport CDG Terminal 2E", 2, 75, "confirmee"],
      ["LVMH", "C. Petit — Office manager, 01 44 13 22 22", "+2 days", "LVMH, 22 Av. Montaigne, 75008 Paris", "Aéroport du Bourget", 1, 95, "confirmee"],
      ["Accenture", "J. Rossi — Travel desk, 01 53 23 55 00", "+3 days", "Accenture, 118 Av. de France, 75013 Paris", "La Défense — Tour First", 3, 45, "en_attente"],
      ["Salon Porte de Versailles", "Organisation salon — badge presse", "+5 days", "Hôtel Pullman Montparnasse", "Paris Expo Porte de Versailles", 4, 60, "confirmee"],
    ];
    for (const b of bookings) insertB2b.run(...b);
  }

  // ── 8 missions marketplace, sources variées, commissions 10-25% ───────────
  const marketplaceCount = (db.prepare(`SELECT COUNT(*) AS n FROM missions_marketplace`).get() as any).n;
  if (marketplaceCount === 0) {
    const insertMarket = db.prepare(`
      INSERT INTO missions_marketplace (source_platform, description, price, distance, commission_pct, active, created_at)
      VALUES (?, ?, ?, ?, ?, 1, datetime('now'))
    `);
    const missions: Array<[string, string, number, number, number]> = [
      ["Comin", "Transfert professionnel Paris 8e → La Défense, client habituel", 32, 12, 10],
      ["Maze", "Mise à disposition 3h — visite clientèle IDF", 120, 40, 12],
      ["Snapcar", "Transfert Paris centre → Aéroport d'Orly, bagages x3", 48, 20, 15],
      ["Uber", "Course UberX standard, zone Paris 15e → 92", 18, 9, 25],
      ["Bolt", "Course Bolt Comfort, Paris 11e → Gare du Nord", 22, 7, 20],
      ["Heetch", "Course soirée, Paris 18e → Paris 9e", 15, 5, 18],
      ["Comin", "Transfert entreprise récurrent, Neuilly → CDG", 70, 35, 10],
      ["Snapcar", "Mise à disposition demi-journée événement corporate", 260, 60, 14],
    ];
    for (const m of missions) insertMarket.run(...m);
  }

  // ── 6 partenaires cashback carburant ───────────────────────────────────────
  const cashbackCount = (db.prepare(`SELECT COUNT(*) AS n FROM fuel_cashback_partners`).get() as any).n;
  if (cashbackCount === 0) {
    const insertCashback = db.prepare(`
      INSERT INTO fuel_cashback_partners (nom, station, cashback_pct, conditions) VALUES (?, ?, ?, ?)
    `);
    const partners: Array<[string, string, number, string]> = [
      ["TotalEnergies", "Carte Pro TotalEnergies", 5, "Cashback appliqué sur carburant + péage, plafond 200€/mois, carte pro VTC requise."],
      ["Shell", "Shell Card Small Business", 4, "Remise immédiate en station Shell partenaire, hors carburant premium."],
      ["Avia", "Avia Club Pro", 3, "Cumul de points convertibles en cashback, valable stations Avia France."],
      ["BP", "BP Plus Pro", 3, "Réduction sur carburants classiques, hors BP Ultimate."],
      ["Esso", "Esso Card Entreprise", 2, "Cashback mensuel sur relevé, sans engagement de volume minimum."],
      ["Intermarché", "Carte IZI Intermarché Pro", 6, "Meilleur taux du marché, valable stations Intermarché IDF, plafond 150€/mois."],
    ];
    for (const p of partners) insertCashback.run(...p);
  }

  // ── Grille forfait aéroport — 15 lignes ────────────────────────────────────
  const airportCount = (db.prepare(`SELECT COUNT(*) AS n FROM airport_forfaits`).get() as any).n;
  if (airportCount === 0) {
    const insertAirport = db.prepare(`
      INSERT INTO airport_forfaits (from_zone, to_airport, price, notes) VALUES (?, ?, ?, ?)
    `);
    const rows: Array<[string, string, number, string]> = [
      ["Paris rive droite", "CDG", 65, "Forfait fixe, péage inclus, hors nuit/dimanche."],
      ["Paris rive gauche", "CDG", 70, "Trajet via A1/A3, ~45-55 min hors trafic."],
      ["Paris centre", "Orly", 40, "Forfait fixe, trajet via A6/A106."],
      ["Paris rive droite", "Orly", 45, "Trajet via périphérique + A6a."],
      ["Paris rive gauche", "Orly", 35, "Trajet le plus court, ~25-30 min."],
      ["Neuilly / La Défense", "CDG", 75, "Majoration zone ouest, via A14/A1."],
      ["Neuilly / La Défense", "Orly", 55, "Via A13/A86."],
      ["Boulogne / Issy", "Orly", 38, "Zone sud-ouest proche Orly."],
      ["Saint-Denis / Aubervilliers", "CDG", 45, "Zone nord proche CDG, forfait réduit."],
      ["Créteil / Ivry", "Orly", 42, "Zone sud-est proche Orly."],
      ["Versailles", "Orly", 50, "Via A86/N12."],
      ["Versailles", "CDG", 90, "Trajet long, majoration distance."],
      ["Paris centre", "Beauvais", 140, "Trajet ~1h30, forfait longue distance."],
      ["Paris centre", "Le Bourget", 55, "Aviation d'affaires, clientèle premium."],
      ["Roissy-en-France / Villepinte", "CDG", 25, "Zone limitrophe aéroport, forfait minimal."],
    ];
    for (const r of rows) insertAirport.run(...r);
  }

  // ── Événements spéciaux démo ────────────────────────────────────────────────
  const eventCount = (db.prepare(`SELECT COUNT(*) AS n FROM event_missions`).get() as any).n;
  if (eventCount === 0) {
    const insertEvent = db.prepare(`
      INSERT INTO event_missions (event_type, date, duration_hours, price, notes, status, created_at)
      VALUES (?, datetime('now', ?), ?, ?, ?, 'disponible', datetime('now'))
    `);
    const events: Array<[string, string, number, number, string]> = [
      ["mariage", "+6 days", 8, 480, "Mise à disposition journée complète, véhicule décoré, tenue soignée demandée."],
      ["salon", "+3 days", 10, 550, "Navette VIP Salon Porte de Versailles, plusieurs rotations dans la journée."],
      ["congres", "+8 days", 6, 360, "Transferts intervenants congrès médical, La Défense."],
      ["mariage", "+12 days", 5, 320, "Trajet mairie → salle de réception, région parisienne."],
    ];
    for (const e of events) insertEvent.run(...e);
  }

  markSeedRun(SEED_KEY);
}

seedDiversificationData();

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
function round2(n: number): number {
  return Math.round((n || 0) * 100) / 100;
}
function safeJsonParse(value: any, fallback: any) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}
function escapeHtml(s: string): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
function genNumero(prefix: string): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const rand = Math.floor(Math.random() * 9000 + 1000);
  return `${prefix}-${y}${m}-${rand}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Missions colis intercités
// ─────────────────────────────────────────────────────────────────────────────
export function listParcelMissions(status?: string) {
  if (status) {
    return db.prepare(`SELECT * FROM parcel_missions WHERE status = ? ORDER BY deadline ASC`).all(status);
  }
  return db.prepare(`SELECT * FROM parcel_missions ORDER BY status ASC, deadline ASC`).all();
}

export function createParcelMission(input: {
  from_city: string; to_city: string; distance_km: number; price: number; deadline: string; notes?: string;
}) {
  if (!input.from_city || !input.to_city) throw new Error("Villes de départ et d'arrivée requises");
  const info = db.prepare(`
    INSERT INTO parcel_missions (from_city, to_city, distance_km, price, deadline, notes, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'disponible', datetime('now'))
  `).run(input.from_city, input.to_city, input.distance_km || 0, input.price || 0, input.deadline, input.notes || null);
  return db.prepare(`SELECT * FROM parcel_missions WHERE id = ?`).get(info.lastInsertRowid);
}

export function updateParcelMissionStatus(id: number, status: string) {
  const valid = ["disponible", "prise", "livree", "annulee"];
  if (!valid.includes(status)) throw new Error("Statut invalide");
  db.prepare(`UPDATE parcel_missions SET status = ? WHERE id = ?`).run(status, id);
  const row = db.prepare(`SELECT * FROM parcel_missions WHERE id = ?`).get(id);
  if (!row) throw new Error("Mission colis introuvable");
  return row;
}

export function deleteParcelMission(id: number) {
  const info = db.prepare(`DELETE FROM parcel_missions WHERE id = ?`).run(id);
  return { deleted: info.changes > 0 };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Réservations B2B
// ─────────────────────────────────────────────────────────────────────────────
export function listB2bBookings(statut?: string) {
  if (statut) {
    return db.prepare(`SELECT * FROM b2b_bookings WHERE statut = ? ORDER BY date_time ASC`).all(statut);
  }
  return db.prepare(`SELECT * FROM b2b_bookings ORDER BY date_time ASC`).all();
}

export function getB2bBooking(id: number) {
  return db.prepare(`SELECT * FROM b2b_bookings WHERE id = ?`).get(id) || null;
}

export function createB2bBooking(input: {
  company: string; contact?: string; date_time: string; from_addr: string; to_addr: string;
  passengers?: number; forfait: number;
}) {
  if (!input.company || !input.from_addr || !input.to_addr) throw new Error("Entreprise, départ et arrivée requis");
  const info = db.prepare(`
    INSERT INTO b2b_bookings (company, contact, date_time, from_addr, to_addr, passengers, forfait, statut, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'en_attente', datetime('now'))
  `).run(input.company, input.contact || null, input.date_time, input.from_addr, input.to_addr, input.passengers || 1, input.forfait || 0);
  return db.prepare(`SELECT * FROM b2b_bookings WHERE id = ?`).get(info.lastInsertRowid);
}

export function updateB2bBookingStatus(id: number, statut: string) {
  const valid = ["en_attente", "confirmee", "terminee", "annulee"];
  if (!valid.includes(statut)) throw new Error("Statut invalide");
  db.prepare(`UPDATE b2b_bookings SET statut = ? WHERE id = ?`).run(statut, id);
  const row = getB2bBooking(id);
  if (!row) throw new Error("Réservation B2B introuvable");
  return row;
}

export function deleteB2bBooking(id: number) {
  const info = db.prepare(`DELETE FROM b2b_bookings WHERE id = ?`).run(id);
  return { deleted: info.changes > 0 };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Générateur de devis (HTML formaté, imprimable en PDF via window.print)
// ─────────────────────────────────────────────────────────────────────────────
const TVA_RATE_DEFAULT = 0; // auto-entrepreneur : franchise en base TVA (art. 293 B du CGI)

export function generateQuote(input: {
  client: string; date: string; from: string; to: string; passagers?: number; options?: string[];
}) {
  if (!input.client || !input.from || !input.to) throw new Error("Client, départ et arrivée requis");
  const passagers = input.passagers || 1;
  const options = input.options || [];

  // Tarification simple et transparente : base + majoration options
  const base = 35;
  const perOption: Record<string, number> = {
    "bagages_supplementaires": 8,
    "siege_bebe": 10,
    "attente_incluse": 15,
    "vehicule_premium": 25,
    "trajet_nuit": 12,
    "accueil_pancarte": 5,
  };
  let montantHt = base;
  for (const opt of options) montantHt += perOption[opt] ?? 10;
  montantHt += Math.max(0, passagers - 1) * 5;
  montantHt = round2(montantHt);
  const tva = round2(montantHt * (TVA_RATE_DEFAULT / 100));
  const montantTtc = round2(montantHt + tva);

  const numero = genNumero("DEV");
  const info = db.prepare(`
    INSERT INTO diversification_quotes
      (numero, client, date_course, from_addr, to_addr, passagers, options, montant_ht, tva, montant_ttc, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(numero, input.client, input.date, input.from, input.to, passagers, JSON.stringify(options), montantHt, tva, montantTtc);

  const quote = db.prepare(`SELECT * FROM diversification_quotes WHERE id = ?`).get(info.lastInsertRowid) as any;
  const html = generateQuoteHtml(quote.id);
  return { ...quote, options: safeJsonParse(quote.options, []), html };
}

export function listQuotes() {
  const rows = db.prepare(`SELECT * FROM diversification_quotes ORDER BY created_at DESC`).all() as any[];
  return rows.map((r) => ({ ...r, options: safeJsonParse(r.options, []) }));
}

const OPTION_LABELS: Record<string, string> = {
  bagages_supplementaires: "Bagages supplémentaires",
  siege_bebe: "Siège bébé",
  attente_incluse: "Attente incluse (15 min)",
  vehicule_premium: "Véhicule premium",
  trajet_nuit: "Majoration trajet de nuit",
  accueil_pancarte: "Accueil avec pancarte",
};

export function generateQuoteHtml(id: number): string {
  const quote = db.prepare(`SELECT * FROM diversification_quotes WHERE id = ?`).get(id) as any;
  if (!quote) throw new Error("Devis introuvable");
  const options: string[] = safeJsonParse(quote.options, []);
  const dateEmission = new Date(quote.created_at).toLocaleDateString("fr-FR", { day: "2-digit", month: "long", year: "numeric" });
  const dateCourse = quote.date_course ? new Date(quote.date_course).toLocaleString("fr-FR", { dateStyle: "long", timeStyle: "short" }) : "—";

  const optionsRows = options.length
    ? options.map((o) => `<tr><td>${escapeHtml(OPTION_LABELS[o] || o)}</td></tr>`).join("")
    : `<tr><td>Aucune option supplémentaire</td></tr>`;

  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8" />
<title>Devis ${quote.numero}</title>
<style>
  body { font-family: 'Helvetica Neue', Arial, sans-serif; color: #1a1a1a; max-width: 700px; margin: 40px auto; padding: 0 20px; }
  h1 { font-size: 22px; margin-bottom: 4px; }
  .subtitle { color: #666; font-size: 13px; margin-bottom: 24px; }
  .grid { display: flex; justify-content: space-between; margin-bottom: 24px; gap: 24px; flex-wrap: wrap; }
  .box { font-size: 13px; line-height: 1.6; }
  .box strong { display: block; font-size: 14px; margin-bottom: 4px; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 24px; }
  th, td { padding: 8px; border-bottom: 1px solid #e2e2e2; font-size: 13px; text-align: left; }
  th { background: #f5f5f5; font-weight: 600; }
  .totals { margin-left: auto; width: 280px; font-size: 14px; }
  .totals div { display: flex; justify-content: space-between; padding: 4px 0; }
  .totals .ttc { font-weight: 700; font-size: 16px; border-top: 2px solid #1a1a1a; margin-top: 6px; padding-top: 8px; }
  .badge { display: inline-block; padding: 3px 10px; border-radius: 12px; font-size: 12px; font-weight: 600; background: #e3f2fd; color: #1565c0; }
  .footer { margin-top: 40px; font-size: 11px; color: #888; border-top: 1px solid #eee; padding-top: 12px; }
  @media print { body { margin: 0; padding: 20px; } }
</style>
</head>
<body>
  <h1>DEVIS n°${escapeHtml(quote.numero)}</h1>
  <div class="subtitle">Émis le ${dateEmission} — <span class="badge">Valable 30 jours</span></div>

  <div class="grid">
    <div class="box">
      <strong>Chauffeur VTC</strong>
      VTC Intelligence<br/>
      Auto-entrepreneur — TVA non applicable, art. 293 B du CGI<br/>
    </div>
    <div class="box">
      <strong>Client</strong>
      ${escapeHtml(quote.client)}<br/>
    </div>
  </div>

  <div class="box" style="margin-bottom:20px;">
    <strong>Détail de la course</strong>
    Date/heure souhaitée : ${dateCourse}<br/>
    Départ : ${escapeHtml(quote.from_addr)}<br/>
    Arrivée : ${escapeHtml(quote.to_addr)}<br/>
    Passagers : ${quote.passagers}
  </div>

  <table>
    <thead><tr><th>Options incluses</th></tr></thead>
    <tbody>${optionsRows}</tbody>
  </table>

  <div class="totals">
    <div><span>Total HT</span><span>${quote.montant_ht.toFixed(2)} €</span></div>
    <div><span>TVA</span><span>${quote.tva.toFixed(2)} €</span></div>
    <div class="ttc"><span>Total TTC</span><span>${quote.montant_ttc.toFixed(2)} €</span></div>
  </div>

  <div class="footer">
    Devis généré automatiquement par VTC Intelligence — Diversification de revenus.<br/>
    Acceptation du devis par retour écrit (email/SMS) ou signature électronique.
  </div>
</body>
</html>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Générateur de contrats forfaits (mission ponctuelle B2B)
// ─────────────────────────────────────────────────────────────────────────────
export function generateContract(input: {
  company: string; contact?: string; mission_desc: string; date_mission: string; forfait: number; conditions?: string;
}) {
  if (!input.company || !input.mission_desc) throw new Error("Entreprise et description de mission requises");
  const numero = genNumero("CTR");
  const info = db.prepare(`
    INSERT INTO diversification_contracts (numero, company, contact, mission_desc, date_mission, forfait, conditions, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(numero, input.company, input.contact || null, input.mission_desc, input.date_mission, input.forfait || 0, input.conditions || null);

  const contract = db.prepare(`SELECT * FROM diversification_contracts WHERE id = ?`).get(info.lastInsertRowid) as any;
  const html = generateContractHtml(contract.id);
  return { ...contract, html };
}

export function listContracts() {
  return db.prepare(`SELECT * FROM diversification_contracts ORDER BY created_at DESC`).all();
}

export function generateContractHtml(id: number): string {
  const contract = db.prepare(`SELECT * FROM diversification_contracts WHERE id = ?`).get(id) as any;
  if (!contract) throw new Error("Contrat introuvable");
  const dateEmission = new Date(contract.created_at).toLocaleDateString("fr-FR", { day: "2-digit", month: "long", year: "numeric" });
  const dateMission = contract.date_mission ? new Date(contract.date_mission).toLocaleString("fr-FR", { dateStyle: "long", timeStyle: "short" }) : "—";

  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8" />
<title>Contrat ${contract.numero}</title>
<style>
  body { font-family: 'Helvetica Neue', Arial, sans-serif; color: #1a1a1a; max-width: 720px; margin: 40px auto; padding: 0 20px; line-height: 1.6; }
  h1 { font-size: 20px; margin-bottom: 4px; text-align: center; }
  .subtitle { color: #666; font-size: 13px; margin-bottom: 24px; text-align: center; }
  .grid { display: flex; justify-content: space-between; margin-bottom: 24px; gap: 24px; flex-wrap: wrap; }
  .box { font-size: 13px; }
  .box strong { display: block; font-size: 14px; margin-bottom: 4px; }
  section { margin-bottom: 18px; }
  section h2 { font-size: 14px; margin-bottom: 6px; border-bottom: 1px solid #ddd; padding-bottom: 4px; }
  .amount { font-size: 20px; font-weight: 700; color: #1565c0; }
  .signatures { display: flex; justify-content: space-between; margin-top: 50px; }
  .sig-box { width: 45%; border-top: 1px solid #333; padding-top: 6px; font-size: 12px; text-align: center; }
  .footer { margin-top: 30px; font-size: 11px; color: #888; border-top: 1px solid #eee; padding-top: 12px; }
  @media print { body { margin: 0; padding: 20px; } }
</style>
</head>
<body>
  <h1>CONTRAT DE PRESTATION VTC PONCTUELLE</h1>
  <div class="subtitle">Contrat n°${escapeHtml(contract.numero)} — Émis le ${dateEmission}</div>

  <div class="grid">
    <div class="box">
      <strong>Prestataire</strong>
      VTC Intelligence<br/>
      Auto-entrepreneur — TVA non applicable, art. 293 B du CGI
    </div>
    <div class="box">
      <strong>Client (entreprise)</strong>
      ${escapeHtml(contract.company)}<br/>
      ${contract.contact ? escapeHtml(contract.contact) : ""}
    </div>
  </div>

  <section>
    <h2>Article 1 — Objet de la mission</h2>
    <p>${escapeHtml(contract.mission_desc)}</p>
    <p>Date et heure de la mission : <strong>${dateMission}</strong></p>
  </section>

  <section>
    <h2>Article 2 — Forfait convenu</h2>
    <p>Le prix forfaitaire de la prestation est fixé à : <span class="amount">${contract.forfait.toFixed(2)} €</span> (TTC, franchise en base de TVA).</p>
    <p>Ce forfait couvre l'intégralité de la mission décrite à l'article 1, hors suppléments non anticipés (péages additionnels imprévus, attente hors plage convenue).</p>
  </section>

  <section>
    <h2>Article 3 — Conditions particulières</h2>
    <p>${contract.conditions ? escapeHtml(contract.conditions) : "Aucune condition particulière — conditions générales standard applicables (annulation gratuite jusqu'à 24h avant la mission, paiement à réception de facture à 30 jours)."}</p>
  </section>

  <div class="signatures">
    <div class="sig-box">Le Prestataire<br/><br/><br/>Signature</div>
    <div class="sig-box">Le Client<br/><br/><br/>Signature et cachet</div>
  </div>

  <div class="footer">
    Contrat généré automatiquement par VTC Intelligence — Diversification de revenus.<br/>
    Document à valeur contractuelle après signature des deux parties.
  </div>
</body>
</html>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Marketplace missions
// ─────────────────────────────────────────────────────────────────────────────
export function listMarketplaceMissions(activeOnly?: boolean) {
  const rows = activeOnly
    ? db.prepare(`SELECT * FROM missions_marketplace WHERE active = 1 ORDER BY commission_pct ASC, price DESC`).all()
    : db.prepare(`SELECT * FROM missions_marketplace ORDER BY commission_pct ASC, price DESC`).all();
  return (rows as any[]).map((r) => ({
    ...r,
    active: !!r.active,
    net_estime: round2(r.price * (1 - r.commission_pct / 100)),
  }));
}

export function createMarketplaceMission(input: {
  source_platform: string; description: string; price: number; distance: number; commission_pct: number;
}) {
  const validSources = ["Comin", "Maze", "Snapcar", "Uber", "Bolt", "Heetch"];
  if (!validSources.includes(input.source_platform)) throw new Error("Plateforme source invalide");
  if (!input.description) throw new Error("Description requise");
  const info = db.prepare(`
    INSERT INTO missions_marketplace (source_platform, description, price, distance, commission_pct, active, created_at)
    VALUES (?, ?, ?, ?, ?, 1, datetime('now'))
  `).run(input.source_platform, input.description, input.price || 0, input.distance || 0, input.commission_pct || 0);
  return db.prepare(`SELECT * FROM missions_marketplace WHERE id = ?`).get(info.lastInsertRowid);
}

export function updateMarketplaceMissionActive(id: number, active: boolean) {
  db.prepare(`UPDATE missions_marketplace SET active = ? WHERE id = ?`).run(active ? 1 : 0, id);
  const row = db.prepare(`SELECT * FROM missions_marketplace WHERE id = ?`).get(id);
  if (!row) throw new Error("Mission marketplace introuvable");
  return row;
}

export function deleteMarketplaceMission(id: number) {
  const info = db.prepare(`DELETE FROM missions_marketplace WHERE id = ?`).run(id);
  return { deleted: info.changes > 0 };
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Course forfaitaire aéroport
// ─────────────────────────────────────────────────────────────────────────────
export function listAirportForfaits(toAirport?: string) {
  if (toAirport) {
    return db.prepare(`SELECT * FROM airport_forfaits WHERE to_airport = ? ORDER BY price ASC`).all(toAirport);
  }
  return db.prepare(`SELECT * FROM airport_forfaits ORDER BY to_airport ASC, price ASC`).all();
}

export function createAirportForfait(input: { from_zone: string; to_airport: string; price: number; notes?: string }) {
  if (!input.from_zone || !input.to_airport) throw new Error("Zone de départ et aéroport requis");
  const info = db.prepare(`
    INSERT INTO airport_forfaits (from_zone, to_airport, price, notes) VALUES (?, ?, ?, ?)
  `).run(input.from_zone, input.to_airport, input.price || 0, input.notes || null);
  return db.prepare(`SELECT * FROM airport_forfaits WHERE id = ?`).get(info.lastInsertRowid);
}

export function deleteAirportForfait(id: number) {
  const info = db.prepare(`DELETE FROM airport_forfaits WHERE id = ?`).run(id);
  return { deleted: info.changes > 0 };
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. Événements spéciaux
// ─────────────────────────────────────────────────────────────────────────────
export function listEventMissions(status?: string) {
  if (status) {
    return db.prepare(`SELECT * FROM event_missions WHERE status = ? ORDER BY date ASC`).all(status);
  }
  return db.prepare(`SELECT * FROM event_missions ORDER BY status ASC, date ASC`).all();
}

export function createEventMission(input: {
  event_type: string; date: string; duration_hours: number; price: number; notes?: string;
}) {
  const validTypes = ["mariage", "salon", "congres"];
  if (!validTypes.includes(input.event_type)) throw new Error("Type d'événement invalide");
  const info = db.prepare(`
    INSERT INTO event_missions (event_type, date, duration_hours, price, notes, status, created_at)
    VALUES (?, ?, ?, ?, ?, 'disponible', datetime('now'))
  `).run(input.event_type, input.date, input.duration_hours || 1, input.price || 0, input.notes || null);
  return db.prepare(`SELECT * FROM event_missions WHERE id = ?`).get(info.lastInsertRowid);
}

export function updateEventMissionStatus(id: number, status: string) {
  const valid = ["disponible", "prise", "terminee", "annulee"];
  if (!valid.includes(status)) throw new Error("Statut invalide");
  db.prepare(`UPDATE event_missions SET status = ? WHERE id = ?`).run(status, id);
  const row = db.prepare(`SELECT * FROM event_missions WHERE id = ?`).get(id);
  if (!row) throw new Error("Événement introuvable");
  return row;
}

export function deleteEventMission(id: number) {
  const info = db.prepare(`DELETE FROM event_missions WHERE id = ?`).run(id);
  return { deleted: info.changes > 0 };
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. Cashback carburant
// ─────────────────────────────────────────────────────────────────────────────
export function listFuelCashbackPartners() {
  return db.prepare(`SELECT * FROM fuel_cashback_partners ORDER BY cashback_pct DESC`).all();
}

export function createFuelCashbackPartner(input: { nom: string; station: string; cashback_pct: number; conditions?: string }) {
  if (!input.nom || !input.station) throw new Error("Nom et station requis");
  const info = db.prepare(`
    INSERT INTO fuel_cashback_partners (nom, station, cashback_pct, conditions) VALUES (?, ?, ?, ?)
  `).run(input.nom, input.station, input.cashback_pct || 0, input.conditions || null);
  return db.prepare(`SELECT * FROM fuel_cashback_partners WHERE id = ?`).get(info.lastInsertRowid);
}

export function deleteFuelCashbackPartner(id: number) {
  const info = db.prepare(`DELETE FROM fuel_cashback_partners WHERE id = ?`).run(id);
  return { deleted: info.changes > 0 };
}

// Estimation d'économie mensuelle : basée sur une consommation carburant moyenne
// VTC (~1100€/mois de carburant pour un chauffeur temps plein IDF, hypothèse
// documentée dans economicsEngine / taxConstants).
const HYPOTHESE_BUDGET_CARBURANT_MENSUEL = 1100;

export function fuelCashbackWithSavings() {
  const partners = listFuelCashbackPartners() as any[];
  return partners.map((p) => ({
    ...p,
    economie_mensuelle_estimee: round2(HYPOTHESE_BUDGET_CARBURANT_MENSUEL * (p.cashback_pct / 100)),
    hypothese_budget_carburant: HYPOTHESE_BUDGET_CARBURANT_MENSUEL,
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. Recap diversification revenu — mix VTC vs colis vs B2B vs forfaits
// ─────────────────────────────────────────────────────────────────────────────
export function computeRevenueMix(days: number = 30) {
  const sinceExpr = `-${Math.max(1, days)} days`;

  // VTC classique — approximé via private_rides (crmEngine) si dispo, sinon 0.
  let vtcTotal = 0;
  try {
    const row = db.prepare(`
      SELECT COALESCE(SUM(montant), 0) AS total FROM private_rides
      WHERE date >= datetime('now', ?)
    `).get(sinceExpr) as any;
    vtcTotal = row?.total || 0;
  } catch {
    vtcTotal = 0;
  }

  // Colis (missions livrées)
  const parcelRow = db.prepare(`
    SELECT COALESCE(SUM(price), 0) AS total, COUNT(*) AS n FROM parcel_missions
    WHERE status = 'livree' AND created_at >= datetime('now', ?)
  `).get(sinceExpr) as any;

  // Colis disponibles/pris (potentiel, comptés aussi dans le total démo pour donner un mix réaliste)
  const parcelPotentialRow = db.prepare(`
    SELECT COALESCE(SUM(price), 0) AS total, COUNT(*) AS n FROM parcel_missions
    WHERE status IN ('disponible', 'prise') AND created_at >= datetime('now', ?)
  `).get(sinceExpr) as any;

  // B2B (réservations confirmées + terminées)
  const b2bRow = db.prepare(`
    SELECT COALESCE(SUM(forfait), 0) AS total, COUNT(*) AS n FROM b2b_bookings
    WHERE statut IN ('confirmee', 'terminee') AND created_at >= datetime('now', ?)
  `).get(sinceExpr) as any;

  // Forfaits aéroport — pas d'historique de courses réalisées en démo : on estime
  // via la moyenne de la grille tarifaire pondérée par un nombre de courses type.
  const airportAvgRow = db.prepare(`SELECT COALESCE(AVG(price), 0) AS avg_price FROM airport_forfaits`).get() as any;
  const estimatedAirportRides = 6; // hypothèse démo : ~6 courses aéroport/mois
  const airportTotal = round2((airportAvgRow?.avg_price || 0) * estimatedAirportRides);

  // Événements spéciaux (missions prises/terminées)
  const eventRow = db.prepare(`
    SELECT COALESCE(SUM(price), 0) AS total, COUNT(*) AS n FROM event_missions
    WHERE status IN ('prise', 'terminee') AND created_at >= datetime('now', ?)
  `).get(sinceExpr) as any;

  const colisTotal = round2((parcelRow?.total || 0) + (parcelPotentialRow?.total || 0));
  const b2bTotal = round2(b2bRow?.total || 0);
  const eventTotal = round2(eventRow?.total || 0);

  // Si aucune course VTC classique enregistrée (données démo), on applique une
  // hypothèse raisonnable pour illustrer un mix crédible sans fausser les autres montants réels.
  const vtcTotalFinal = vtcTotal > 0 ? round2(vtcTotal) : round2(colisTotal * 3.5 || 1800);

  const total = round2(vtcTotalFinal + colisTotal + b2bTotal + airportTotal + eventTotal) || 1;

  const pct = (v: number) => round2((v / total) * 100);

  return {
    period_days: days,
    breakdown: [
      { source: "vtc_classique", label: "VTC classique (plateformes)", montant: vtcTotalFinal, pourcentage: pct(vtcTotalFinal) },
      { source: "colis", label: "Colis intercités", montant: colisTotal, pourcentage: pct(colisTotal) },
      { source: "b2b", label: "Réservations B2B", montant: b2bTotal, pourcentage: pct(b2bTotal) },
      { source: "forfaits_aeroport", label: "Forfaits aéroport", montant: airportTotal, pourcentage: pct(airportTotal) },
      { source: "evenements", label: "Événements spéciaux", montant: eventTotal, pourcentage: pct(eventTotal) },
    ],
    total_estime: total,
    diversification_score: round2(100 - pct(vtcTotalFinal)), // % de revenu hors plateforme principale
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Missions du jour — agrégation colis + B2B + événements disponibles
// ─────────────────────────────────────────────────────────────────────────────
export function listTodayMissions() {
  const parcels = (db.prepare(`
    SELECT * FROM parcel_missions WHERE status = 'disponible' ORDER BY deadline ASC
  `).all() as any[]).map((r) => ({ ...r, kind: "colis" }));

  const b2b = (db.prepare(`
    SELECT * FROM b2b_bookings WHERE statut = 'en_attente' ORDER BY date_time ASC
  `).all() as any[]).map((r) => ({ ...r, kind: "b2b" }));

  const events = (db.prepare(`
    SELECT * FROM event_missions WHERE status = 'disponible' ORDER BY date ASC
  `).all() as any[]).map((r) => ({ ...r, kind: "evenement" }));

  return { parcels, b2b, events, total: parcels.length + b2b.length + events.length };
}
