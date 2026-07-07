/**
 * crmEngine.ts — Couche CRM Chauffeur (clientèle privée & partenariats)
 * ═════════════════════════════════════════════════════════════════════════════
 * Rapport §7 (Chaîne de valeur clients), §14.1 (Bourse d'échange courses),
 * §17.1/17.3/17.4 (Automatisation clientèle privée).
 *
 * Leviers couverts :
 *   7.1 Carnet clientèle privée           → private_clients, private_rides
 *   7.2 Blacklist personnelle              → client_blacklist
 *   7.3 Notation client visible            → ratingLookup (démo, pas d'API tierce dispo)
 *   7.4 Suivi VIP/pourboires               → vipAnalytics
 *   7.5 Courses récurrentes                → recurring_rides
 *   7.6 Partenariats hôtels/restos/salles  → partnerships
 *   7.7 Facturation privée + factures       → private_invoices
 *   14.1 Bourse d'échange courses          → ride_exchange (démo + seed)
 *   17.1 Réponses auto SMS/WhatsApp        → auto_reply_templates
 *   17.3 Génération PDF facture (HTML)     → generateInvoiceHtml
 *   17.4 Relances impayés                  → invoiceReminders
 *
 * ZÉRO nouvelle dépendance npm — utilise better-sqlite3 déjà présent (comme
 * mlPersonal.ts, fatigueCoach.ts). Tables créées en CREATE TABLE IF NOT EXISTS,
 * complètement additionnelles (aucune modification de tables existantes).
 * ═════════════════════════════════════════════════════════════════════════════
 */

import Database from "better-sqlite3";

// Connexion séparée au même fichier data.db (WAL supporte le multi-connexion),
// même pattern que fatigueCoach.ts / mlPersonal.ts.
const db = new Database("data.db");
db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");

const DEFAULT_USER = "root"; // app single-tenant

// ─────────────────────────────────────────────────────────────────────────────
// Schéma
// ─────────────────────────────────────────────────────────────────────────────
db.exec(`
  -- 7.1 Carnet clientèle privée --------------------------------------------
  CREATE TABLE IF NOT EXISTS private_clients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL DEFAULT 'root',
    nom TEXT NOT NULL,
    tel TEXT,
    email TEXT,
    notes TEXT,
    tags TEXT NOT NULL DEFAULT '[]',
    vip INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_ride_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_private_clients_user ON private_clients(user_id);

  CREATE TABLE IF NOT EXISTS private_rides (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER NOT NULL REFERENCES private_clients(id) ON DELETE CASCADE,
    date TEXT NOT NULL DEFAULT (datetime('now')),
    montant REAL NOT NULL DEFAULT 0,
    distance REAL NOT NULL DEFAULT 0,
    pourboire REAL NOT NULL DEFAULT 0,
    note TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_private_rides_client ON private_rides(client_id);

  -- 7.2 Blacklist personnelle -----------------------------------------------
  CREATE TABLE IF NOT EXISTS client_blacklist (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL DEFAULT 'root',
    plate_or_id TEXT NOT NULL,
    motif TEXT NOT NULL,
    date TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_client_blacklist_user ON client_blacklist(user_id);

  -- 7.5 Courses récurrentes -------------------------------------------------
  CREATE TABLE IF NOT EXISTS recurring_rides (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER NOT NULL REFERENCES private_clients(id) ON DELETE CASCADE,
    jour_semaine INTEGER NOT NULL DEFAULT 1, -- 0=dimanche ... 6=samedi
    heure TEXT NOT NULL DEFAULT '08:00',
    depart TEXT NOT NULL DEFAULT '',
    arrivee TEXT NOT NULL DEFAULT '',
    montant REAL NOT NULL DEFAULT 0,
    next_occurrence TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_recurring_rides_client ON recurring_rides(client_id);

  -- 7.6 Partenariats hôtels/restos/salles ------------------------------------
  CREATE TABLE IF NOT EXISTS partnerships (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL DEFAULT 'root',
    nom TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'hotel', -- hotel | restaurant | salle | conciergerie | autre
    address TEXT,
    contact TEXT,
    commission_pct REAL NOT NULL DEFAULT 0,
    notes TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_partnerships_user ON partnerships(user_id);

  -- 7.7 Facturation privée ---------------------------------------------------
  CREATE TABLE IF NOT EXISTS private_invoices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL DEFAULT 'root',
    client_id INTEGER NOT NULL REFERENCES private_clients(id) ON DELETE CASCADE,
    ride_ids TEXT NOT NULL DEFAULT '[]', -- JSON array de private_rides.id
    montant_ht REAL NOT NULL DEFAULT 0,
    tva REAL NOT NULL DEFAULT 0,
    montant_ttc REAL NOT NULL DEFAULT 0,
    date_emission TEXT NOT NULL DEFAULT (datetime('now')),
    statut TEXT NOT NULL DEFAULT 'envoyee', -- brouillon | envoyee | payee | en_retard
    paid_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_private_invoices_client ON private_invoices(client_id);

  -- 14.1 Bourse d'échange de courses (démo communautaire) --------------------
  CREATE TABLE IF NOT EXISTS ride_exchange (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_user TEXT NOT NULL,
    from_ride TEXT NOT NULL, -- description libre de la course proposée
    to_zone TEXT NOT NULL,
    price REAL NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'ouverte', -- ouverte | reservee | terminee | annulee
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- 17.1 Réponses automatiques SMS/WhatsApp -----------------------------------
  CREATE TABLE IF NOT EXISTS auto_reply_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL DEFAULT 'root',
    trigger_type TEXT NOT NULL DEFAULT 'en_conduite', -- en_conduite | en_course | disponible | fin_course | remerciement
    message TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1
  );
`);

// ─────────────────────────────────────────────────────────────────────────────
// Seed data — 3-5 clients démo, 2 partenariats démo, 5 templates SMS FR,
// quelques courses en bourse d'échange (démo communauté sans backend réel).
// Idempotent via seed_meta (même pattern que storage.ts).
// ─────────────────────────────────────────────────────────────────────────────
function hasSeedRun(key: string): boolean {
  try {
    const row = db.prepare(`SELECT value FROM seed_meta WHERE key = ?`).get(key) as any;
    return !!row;
  } catch {
    return false; // seed_meta peut ne pas exister encore côté storage.ts init order
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

function seedCrmData(): void {
  const SEED_KEY = "crm_engine_seed_v1";
  if (hasSeedRun(SEED_KEY)) return;

  const clientCount = (db.prepare(`SELECT COUNT(*) AS n FROM private_clients`).get() as any).n;
  if (clientCount === 0) {
    const insertClient = db.prepare(`
      INSERT INTO private_clients (user_id, nom, tel, email, notes, tags, vip, created_at, last_ride_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)
    `);
    const demoClients = [
      {
        nom: "Mme Chantal Dubreuil",
        tel: "06 12 34 56 78",
        email: "c.dubreuil@gmail.com",
        notes: "Cliente régulière, préfère berline silencieuse, rendez-vous ponctuels.",
        tags: JSON.stringify(["fidèle", "aéroport"]),
        vip: 1,
        last_ride_at: "-2 days",
      },
      {
        nom: "M. Karim Belhadj",
        tel: "07 45 12 89 33",
        email: "karim.belhadj@outlook.fr",
        notes: "Dirigeant PME, courses pro régulières vers La Défense.",
        tags: JSON.stringify(["business", "récurrent"]),
        vip: 1,
        last_ride_at: "-1 days",
      },
      {
        nom: "Mme Aïcha Ndiaye",
        tel: "06 98 77 22 10",
        email: "",
        notes: "Rendez-vous médicaux hebdomadaires, ponctualité appréciée.",
        tags: JSON.stringify(["médical"]),
        vip: 0,
        last_ride_at: "-5 days",
      },
      {
        nom: "M. Thomas Lefèvre",
        tel: "06 33 44 55 66",
        email: "t.lefevre@entreprise.fr",
        notes: "Contact conciergerie hôtel partenaire, courses aéroport CDG/Orly.",
        tags: JSON.stringify(["hôtel", "aéroport", "VIP"]),
        vip: 1,
        last_ride_at: "-10 days",
      },
      {
        nom: "Mme Julie Moreau",
        tel: "06 21 98 76 54",
        email: "julie.moreau@gmail.com",
        notes: "Cliente occasionnelle, sorties soirée le week-end.",
        tags: JSON.stringify(["soirée"]),
        vip: 0,
        last_ride_at: "-15 days",
      },
    ];
    const clientIds: number[] = [];
    for (const c of demoClients) {
      const info = insertClient.run(
        DEFAULT_USER, c.nom, c.tel, c.email, c.notes, c.tags, c.vip,
        `datetime('now', '${c.last_ride_at}')` as any
      );
      clientIds.push(Number(info.lastInsertRowid));
    }
    // Correction : SQLite ne substitue pas datetime('now','...') passé en paramètre lié
    // → on met à jour last_ride_at séparément avec une expression SQL réelle.
    const updateLast = db.prepare(`UPDATE private_clients SET last_ride_at = datetime('now', ?) WHERE id = ?`);
    demoClients.forEach((c, i) => updateLast.run(c.last_ride_at, clientIds[i]));

    // Quelques courses privées historiques pour alimenter les analytics VIP
    const insertRide = db.prepare(`
      INSERT INTO private_rides (client_id, date, montant, distance, pourboire, note)
      VALUES (?, datetime('now', ?), ?, ?, ?, ?)
    `);
    const rideSeeds: Array<[number, string, number, number, number, string]> = [
      [clientIds[0], "-2 days", 45.0, 18.5, 5.0, "Aéroport CDG"],
      [clientIds[0], "-9 days", 38.0, 15.0, 3.0, "Retour domicile"],
      [clientIds[1], "-1 days", 22.0, 9.0, 2.0, "La Défense"],
      [clientIds[1], "-4 days", 22.0, 9.0, 0.0, "La Défense"],
      [clientIds[1], "-8 days", 65.0, 32.0, 8.0, "RDV client Roissy"],
      [clientIds[2], "-5 days", 18.0, 6.5, 0.0, "RDV médical"],
      [clientIds[3], "-10 days", 80.0, 40.0, 10.0, "Transfert hôtel-Orly"],
      [clientIds[4], "-15 days", 30.0, 12.0, 4.0, "Sortie soirée"],
    ];
    for (const r of rideSeeds) insertRide.run(...r);
  }

  const partnershipCount = (db.prepare(`SELECT COUNT(*) AS n FROM partnerships`).get() as any).n;
  if (partnershipCount === 0) {
    const insertPartnership = db.prepare(`
      INSERT INTO partnerships (user_id, nom, type, address, contact, commission_pct, notes, active, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `);
    insertPartnership.run(
      DEFAULT_USER, "Hôtel Le Meurice", "hotel", "228 Rue de Rivoli, 75001 Paris",
      "concierge@lemeurice.com — 01 44 58 10 10", 10,
      "Conciergerie transmet les demandes de transferts clientèle premium.", 1
    );
    insertPartnership.run(
      DEFAULT_USER, "Restaurant Le Chalet des Iles", "restaurant", "Bois de Boulogne, 75016 Paris",
      "resa@chaletdesiles.fr — 01 42 88 04 04", 5,
      "Clients réguliers en fin de service, demande de VTC pour retour tardif.", 1
    );
  }

  const templateCount = (db.prepare(`SELECT COUNT(*) AS n FROM auto_reply_templates`).get() as any).n;
  if (templateCount === 0) {
    const insertTpl = db.prepare(`
      INSERT INTO auto_reply_templates (user_id, trigger_type, message, active)
      VALUES (?, ?, ?, 1)
    `);
    insertTpl.run(DEFAULT_USER, "en_conduite", "Je conduis actuellement, je vous rappelle dès que je peux.");
    insertTpl.run(DEFAULT_USER, "en_course", "Je suis en course. Réservation pour quelle date/heure ?");
    insertTpl.run(DEFAULT_USER, "disponible", "Bonjour, je peux vous prendre en charge à [ADRESSE] à [HEURE]. Confirmez-vous ?");
    insertTpl.run(DEFAULT_USER, "fin_course", "Ma course est terminée dans ~15 min. Vous êtes toujours dispo ?");
    insertTpl.run(DEFAULT_USER, "remerciement", "Merci pour votre confiance ! Prochaine course quand vous voulez.");
  }

  const exchangeCount = (db.prepare(`SELECT COUNT(*) AS n FROM ride_exchange`).get() as any).n;
  if (exchangeCount === 0) {
    const insertExchange = db.prepare(`
      INSERT INTO ride_exchange (from_user, from_ride, to_zone, price, status, created_at)
      VALUES (?, ?, ?, ?, ?, datetime('now', ?))
    `);
    insertExchange.run("antoine", "Course Paris 8e → Roissy CDG, bagages x2, client pro", "Roissy CDG", 55.0, "ouverte", "-2 hours");
    insertExchange.run("vtc-one", "Course La Défense → Orly, départ 18h30", "Orly", 42.0, "ouverte", "-1 hours");
    insertExchange.run("antoine", "Course Neuilly → Gare de Lyon, client VIP ponctuel", "Gare de Lyon", 28.0, "reservee", "-5 hours");
    insertExchange.run("vtc-one", "Transfert Versailles → Paris centre, groupe 3 pers", "Paris centre", 65.0, "ouverte", "-30 minutes");
  }

  markSeedRun(SEED_KEY);
}

seedCrmData();

// ─────────────────────────────────────────────────────────────────────────────
// 7.1 Clients — CRUD
// ─────────────────────────────────────────────────────────────────────────────
export function listClients(search?: string) {
  let rows: any[];
  if (search && search.trim()) {
    const q = `%${search.trim().toLowerCase()}%`;
    rows = db.prepare(`
      SELECT * FROM private_clients
      WHERE user_id = ? AND (LOWER(nom) LIKE ? OR LOWER(tel) LIKE ? OR LOWER(email) LIKE ?)
      ORDER BY vip DESC, last_ride_at DESC NULLS LAST, created_at DESC
    `).all(DEFAULT_USER, q, q, q) as any[];
  } else {
    rows = db.prepare(`
      SELECT * FROM private_clients WHERE user_id = ?
      ORDER BY vip DESC, last_ride_at DESC NULLS LAST, created_at DESC
    `).all(DEFAULT_USER) as any[];
  }
  return rows.map((r) => ({ ...r, tags: safeJsonParse(r.tags, []), vip: !!r.vip }));
}

export function getClient(id: number) {
  const row = db.prepare(`SELECT * FROM private_clients WHERE id = ? AND user_id = ?`).get(id, DEFAULT_USER) as any;
  if (!row) return null;
  const rides = db.prepare(`SELECT * FROM private_rides WHERE client_id = ? ORDER BY date DESC`).all(id);
  const recurring = db.prepare(`SELECT * FROM recurring_rides WHERE client_id = ? ORDER BY created_at DESC`).all(id);
  const invoices = db.prepare(`SELECT * FROM private_invoices WHERE client_id = ? ORDER BY date_emission DESC`).all(id);
  return { ...row, tags: safeJsonParse(row.tags, []), vip: !!row.vip, rides, recurring, invoices };
}

export function createClient(input: {
  nom: string; tel?: string; email?: string; notes?: string; tags?: string[]; vip?: boolean;
}) {
  if (!input.nom || !input.nom.trim()) throw new Error("Le nom du client est requis");
  const info = db.prepare(`
    INSERT INTO private_clients (user_id, nom, tel, email, notes, tags, vip, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(
    DEFAULT_USER, input.nom.trim(), input.tel || null, input.email || null,
    input.notes || null, JSON.stringify(input.tags || []), input.vip ? 1 : 0
  );
  return getClient(Number(info.lastInsertRowid));
}

export function updateClient(id: number, input: Partial<{
  nom: string; tel: string; email: string; notes: string; tags: string[]; vip: boolean;
}>) {
  const existing = db.prepare(`SELECT * FROM private_clients WHERE id = ? AND user_id = ?`).get(id, DEFAULT_USER);
  if (!existing) throw new Error("Client introuvable");
  const fields: string[] = [];
  const values: any[] = [];
  if (input.nom !== undefined) { fields.push("nom = ?"); values.push(input.nom); }
  if (input.tel !== undefined) { fields.push("tel = ?"); values.push(input.tel); }
  if (input.email !== undefined) { fields.push("email = ?"); values.push(input.email); }
  if (input.notes !== undefined) { fields.push("notes = ?"); values.push(input.notes); }
  if (input.tags !== undefined) { fields.push("tags = ?"); values.push(JSON.stringify(input.tags)); }
  if (input.vip !== undefined) { fields.push("vip = ?"); values.push(input.vip ? 1 : 0); }
  if (fields.length === 0) return getClient(id);
  values.push(id, DEFAULT_USER);
  db.prepare(`UPDATE private_clients SET ${fields.join(", ")} WHERE id = ? AND user_id = ?`).run(...values);
  return getClient(id);
}

export function deleteClient(id: number) {
  const info = db.prepare(`DELETE FROM private_clients WHERE id = ? AND user_id = ?`).run(id, DEFAULT_USER);
  return { deleted: info.changes > 0 };
}

// ─────────────────────────────────────────────────────────────────────────────
// 7.1 Courses privées (private_rides) — CRUD simple
// ─────────────────────────────────────────────────────────────────────────────
export function listRides(clientId?: number) {
  if (clientId) {
    return db.prepare(`SELECT * FROM private_rides WHERE client_id = ? ORDER BY date DESC`).all(clientId);
  }
  return db.prepare(`
    SELECT pr.*, pc.nom AS client_nom FROM private_rides pr
    JOIN private_clients pc ON pc.id = pr.client_id
    WHERE pc.user_id = ?
    ORDER BY pr.date DESC LIMIT 200
  `).all(DEFAULT_USER);
}

export function createRide(input: { client_id: number; date?: string; montant: number; distance: number; pourboire?: number; note?: string }) {
  const client = db.prepare(`SELECT * FROM private_clients WHERE id = ? AND user_id = ?`).get(input.client_id, DEFAULT_USER);
  if (!client) throw new Error("Client introuvable");
  const info = db.prepare(`
    INSERT INTO private_rides (client_id, date, montant, distance, pourboire, note)
    VALUES (?, COALESCE(?, datetime('now')), ?, ?, ?, ?)
  `).run(input.client_id, input.date || null, input.montant || 0, input.distance || 0, input.pourboire || 0, input.note || null);
  db.prepare(`UPDATE private_clients SET last_ride_at = datetime('now') WHERE id = ?`).run(input.client_id);
  return db.prepare(`SELECT * FROM private_rides WHERE id = ?`).get(info.lastInsertRowid);
}

export function deleteRide(id: number) {
  const info = db.prepare(`DELETE FROM private_rides WHERE id = ?`).run(id);
  return { deleted: info.changes > 0 };
}

// ─────────────────────────────────────────────────────────────────────────────
// 7.2 Blacklist personnelle
// ─────────────────────────────────────────────────────────────────────────────
export function listBlacklist() {
  return db.prepare(`SELECT * FROM client_blacklist WHERE user_id = ? ORDER BY date DESC`).all(DEFAULT_USER);
}

export function addBlacklistEntry(input: { plate_or_id: string; motif: string }) {
  if (!input.plate_or_id || !input.motif) throw new Error("Plaque/identifiant et motif requis");
  const info = db.prepare(`
    INSERT INTO client_blacklist (user_id, plate_or_id, motif, date) VALUES (?, ?, ?, datetime('now'))
  `).run(DEFAULT_USER, input.plate_or_id.trim(), input.motif.trim());
  return db.prepare(`SELECT * FROM client_blacklist WHERE id = ?`).get(info.lastInsertRowid);
}

export function removeBlacklistEntry(id: number) {
  const info = db.prepare(`DELETE FROM client_blacklist WHERE id = ? AND user_id = ?`).run(id, DEFAULT_USER);
  return { deleted: info.changes > 0 };
}

export function checkBlacklist(ref: string) {
  const row = db.prepare(`
    SELECT * FROM client_blacklist WHERE user_id = ? AND LOWER(plate_or_id) = LOWER(?)
  `).get(DEFAULT_USER, ref) as { id: number; plate_or_id: string; motif: string; date: string } | undefined;
  return { blacklisted: !!row, entry: row || null };
}

// ─────────────────────────────────────────────────────────────────────────────
// 7.3 Notation client visible avant acceptation
// ─────────────────────────────────────────────────────────────────────────────
// Aucune API tierce n'expose la note passager pour l'instant (Uber/Bolt/Heetch
// ne le permettent pas côté chauffeur) — mode démo : croise blacklist locale +
// historique privé + heuristique déterministe basée sur la référence fournie,
// pour donner un signal utile sans jamais prétendre à une vraie donnée plateforme.
export function ratingLookup(ref: string) {
  if (!ref || !ref.trim()) throw new Error("Référence (téléphone/plaque/id) requise");
  const bl = checkBlacklist(ref);
  if (bl.blacklisted) {
    return {
      ref, source: "blacklist_locale", blacklisted: true,
      rating: null, note: `⚠️ Client dans votre liste noire — motif : ${bl.entry?.motif}`,
      history_rides: 0, history_total: 0,
    };
  }

  const client = db.prepare(`
    SELECT * FROM private_clients WHERE user_id = ? AND (tel = ? OR LOWER(nom) = LOWER(?))
  `).get(DEFAULT_USER, ref, ref) as any;

  if (client) {
    const rides = db.prepare(`SELECT * FROM private_rides WHERE client_id = ?`).all(client.id) as any[];
    const total = rides.reduce((s, r) => s + (r.montant || 0), 0);
    const avgTip = rides.length ? rides.reduce((s, r) => s + (r.pourboire || 0), 0) / rides.length : 0;
    return {
      ref, source: "carnet_prive", blacklisted: false,
      client_nom: client.nom, vip: !!client.vip,
      rating: client.vip ? 5 : 4,
      note: client.vip ? "Client VIP connu — historique excellent." : "Client connu du carnet privé.",
      history_rides: rides.length, history_total: Math.round(total * 100) / 100,
      avg_tip: Math.round(avgTip * 100) / 100,
    };
  }

  // Aucune donnée disponible : signal neutre honnête (pas d'API plateforme dispo en démo)
  return {
    ref, source: "aucune_donnee", blacklisted: false, rating: null,
    note: "Aucune donnée disponible sur ce client (première course probable, ou plateforme sans API de notation exposée).",
    history_rides: 0, history_total: 0,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 7.4 VIP / pourboires — analytics
// ─────────────────────────────────────────────────────────────────────────────
export function vipAnalytics() {
  const rows = db.prepare(`
    SELECT pc.id, pc.nom, pc.vip,
           COUNT(pr.id) AS nb_courses,
           COALESCE(SUM(pr.montant), 0) AS ca_total,
           COALESCE(SUM(pr.pourboire), 0) AS pourboires_total,
           COALESCE(AVG(pr.pourboire), 0) AS pourboire_moyen
    FROM private_clients pc
    LEFT JOIN private_rides pr ON pr.client_id = pc.id
    WHERE pc.user_id = ?
    GROUP BY pc.id
  `).all(DEFAULT_USER) as any[];

  const topByCa = [...rows].sort((a, b) => b.ca_total - a.ca_total).slice(0, 10);
  const topByTips = [...rows].sort((a, b) => b.pourboires_total - a.pourboires_total).slice(0, 10);

  const totalCa = rows.reduce((s, r) => s + r.ca_total, 0);
  const totalTips = rows.reduce((s, r) => s + r.pourboires_total, 0);
  const vipCount = rows.filter((r) => r.vip).length;

  return {
    summary: {
      total_clients: rows.length,
      vip_count: vipCount,
      ca_total: Math.round(totalCa * 100) / 100,
      pourboires_total: Math.round(totalTips * 100) / 100,
    },
    top_by_ca: topByCa.map((r) => ({ ...r, vip: !!r.vip, ca_total: round2(r.ca_total), pourboires_total: round2(r.pourboires_total), pourboire_moyen: round2(r.pourboire_moyen) })),
    top_by_tips: topByTips.map((r) => ({ ...r, vip: !!r.vip, ca_total: round2(r.ca_total), pourboires_total: round2(r.pourboires_total), pourboire_moyen: round2(r.pourboire_moyen) })),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 7.5 Courses récurrentes
// ─────────────────────────────────────────────────────────────────────────────
const JOURS_FR = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];

function computeNextOccurrence(jourSemaine: number, heure: string): string {
  const now = new Date();
  const [h, m] = heure.split(":").map((x) => parseInt(x, 10) || 0);
  const result = new Date(now);
  const currentDay = now.getDay();
  let diff = (jourSemaine - currentDay + 7) % 7;
  result.setDate(now.getDate() + diff);
  result.setHours(h, m, 0, 0);
  if (diff === 0 && result.getTime() <= now.getTime()) {
    result.setDate(result.getDate() + 7);
  }
  return result.toISOString();
}

export function listRecurring() {
  const rows = db.prepare(`
    SELECT rr.*, pc.nom AS client_nom FROM recurring_rides rr
    JOIN private_clients pc ON pc.id = rr.client_id
    WHERE pc.user_id = ?
    ORDER BY rr.active DESC, rr.next_occurrence ASC
  `).all(DEFAULT_USER) as any[];
  return rows.map((r) => ({ ...r, active: !!r.active, jour_label: JOURS_FR[r.jour_semaine] || "?" }));
}

export function createRecurring(input: {
  client_id: number; jour_semaine: number; heure: string; depart: string; arrivee: string; montant: number;
}) {
  const client = db.prepare(`SELECT * FROM private_clients WHERE id = ? AND user_id = ?`).get(input.client_id, DEFAULT_USER);
  if (!client) throw new Error("Client introuvable");
  const next = computeNextOccurrence(input.jour_semaine, input.heure);
  const info = db.prepare(`
    INSERT INTO recurring_rides (client_id, jour_semaine, heure, depart, arrivee, montant, next_occurrence, active, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, datetime('now'))
  `).run(input.client_id, input.jour_semaine, input.heure, input.depart || "", input.arrivee || "", input.montant || 0, next);
  return db.prepare(`SELECT * FROM recurring_rides WHERE id = ?`).get(info.lastInsertRowid);
}

export function updateRecurring(id: number, input: Partial<{
  jour_semaine: number; heure: string; depart: string; arrivee: string; montant: number; active: boolean;
}>) {
  const existing = db.prepare(`SELECT * FROM recurring_rides WHERE id = ?`).get(id) as any;
  if (!existing) throw new Error("Course récurrente introuvable");
  const fields: string[] = [];
  const values: any[] = [];
  if (input.jour_semaine !== undefined) { fields.push("jour_semaine = ?"); values.push(input.jour_semaine); }
  if (input.heure !== undefined) { fields.push("heure = ?"); values.push(input.heure); }
  if (input.depart !== undefined) { fields.push("depart = ?"); values.push(input.depart); }
  if (input.arrivee !== undefined) { fields.push("arrivee = ?"); values.push(input.arrivee); }
  if (input.montant !== undefined) { fields.push("montant = ?"); values.push(input.montant); }
  if (input.active !== undefined) { fields.push("active = ?"); values.push(input.active ? 1 : 0); }
  const newJour = input.jour_semaine !== undefined ? input.jour_semaine : existing.jour_semaine;
  const newHeure = input.heure !== undefined ? input.heure : existing.heure;
  if (input.jour_semaine !== undefined || input.heure !== undefined) {
    fields.push("next_occurrence = ?");
    values.push(computeNextOccurrence(newJour, newHeure));
  }
  if (fields.length === 0) return existing;
  values.push(id);
  db.prepare(`UPDATE recurring_rides SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  return db.prepare(`SELECT * FROM recurring_rides WHERE id = ?`).get(id);
}

export function deleteRecurring(id: number) {
  const info = db.prepare(`DELETE FROM recurring_rides WHERE id = ?`).run(id);
  return { deleted: info.changes > 0 };
}

// ─────────────────────────────────────────────────────────────────────────────
// 7.6 Partenariats
// ─────────────────────────────────────────────────────────────────────────────
export function listPartnerships() {
  const rows = db.prepare(`SELECT * FROM partnerships WHERE user_id = ? ORDER BY active DESC, created_at DESC`).all(DEFAULT_USER) as any[];
  return rows.map((r) => ({ ...r, active: !!r.active }));
}

export function createPartnership(input: {
  nom: string; type: string; address?: string; contact?: string; commission_pct?: number; notes?: string;
}) {
  if (!input.nom || !input.nom.trim()) throw new Error("Le nom du partenaire est requis");
  const info = db.prepare(`
    INSERT INTO partnerships (user_id, nom, type, address, contact, commission_pct, notes, active, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, datetime('now'))
  `).run(
    DEFAULT_USER, input.nom.trim(), input.type || "autre", input.address || null,
    input.contact || null, input.commission_pct || 0, input.notes || null
  );
  return db.prepare(`SELECT * FROM partnerships WHERE id = ?`).get(info.lastInsertRowid);
}

export function updatePartnership(id: number, input: Partial<{
  nom: string; type: string; address: string; contact: string; commission_pct: number; notes: string; active: boolean;
}>) {
  const existing = db.prepare(`SELECT * FROM partnerships WHERE id = ? AND user_id = ?`).get(id, DEFAULT_USER);
  if (!existing) throw new Error("Partenariat introuvable");
  const fields: string[] = [];
  const values: any[] = [];
  if (input.nom !== undefined) { fields.push("nom = ?"); values.push(input.nom); }
  if (input.type !== undefined) { fields.push("type = ?"); values.push(input.type); }
  if (input.address !== undefined) { fields.push("address = ?"); values.push(input.address); }
  if (input.contact !== undefined) { fields.push("contact = ?"); values.push(input.contact); }
  if (input.commission_pct !== undefined) { fields.push("commission_pct = ?"); values.push(input.commission_pct); }
  if (input.notes !== undefined) { fields.push("notes = ?"); values.push(input.notes); }
  if (input.active !== undefined) { fields.push("active = ?"); values.push(input.active ? 1 : 0); }
  if (fields.length === 0) return existing;
  values.push(id, DEFAULT_USER);
  db.prepare(`UPDATE partnerships SET ${fields.join(", ")} WHERE id = ? AND user_id = ?`).run(...values);
  return db.prepare(`SELECT * FROM partnerships WHERE id = ?`).get(id);
}

export function deletePartnership(id: number) {
  const info = db.prepare(`DELETE FROM partnerships WHERE id = ? AND user_id = ?`).run(id, DEFAULT_USER);
  return { deleted: info.changes > 0 };
}

// ─────────────────────────────────────────────────────────────────────────────
// 7.7 Facturation privée
// ─────────────────────────────────────────────────────────────────────────────
const TVA_RATE_DEFAULT = 0; // auto-entrepreneur : franchise en base TVA par défaut (0%)

export function listInvoices() {
  const rows = db.prepare(`
    SELECT pi.*, pc.nom AS client_nom, pc.email AS client_email, pc.tel AS client_tel
    FROM private_invoices pi
    JOIN private_clients pc ON pc.id = pi.client_id
    WHERE pi.user_id = ?
    ORDER BY pi.date_emission DESC
  `).all(DEFAULT_USER) as any[];
  return rows.map((r) => ({ ...r, ride_ids: safeJsonParse(r.ride_ids, []) }));
}

export function getInvoice(id: number) {
  const row = db.prepare(`
    SELECT pi.*, pc.nom AS client_nom, pc.email AS client_email, pc.tel AS client_tel, pc.notes AS client_notes
    FROM private_invoices pi
    JOIN private_clients pc ON pc.id = pi.client_id
    WHERE pi.id = ? AND pi.user_id = ?
  `).get(id, DEFAULT_USER) as any;
  if (!row) return null;
  const rideIds = safeJsonParse(row.ride_ids, []) as number[];
  const rides = rideIds.length
    ? db.prepare(`SELECT * FROM private_rides WHERE id IN (${rideIds.map(() => "?").join(",")})`).all(...rideIds)
    : [];
  return { ...row, ride_ids: rideIds, rides };
}

export function createInvoice(input: { client_id: number; ride_ids: number[]; tva_pct?: number }) {
  const client = db.prepare(`SELECT * FROM private_clients WHERE id = ? AND user_id = ?`).get(input.client_id, DEFAULT_USER);
  if (!client) throw new Error("Client introuvable");
  if (!input.ride_ids || input.ride_ids.length === 0) throw new Error("Au moins une course est requise pour facturer");

  const rides = db.prepare(`SELECT * FROM private_rides WHERE id IN (${input.ride_ids.map(() => "?").join(",")}) AND client_id = ?`)
    .all(...input.ride_ids, input.client_id) as any[];
  if (rides.length === 0) throw new Error("Aucune course valide trouvée pour ce client");

  const montantHt = rides.reduce((s, r) => s + (r.montant || 0), 0);
  const tvaPct = input.tva_pct ?? TVA_RATE_DEFAULT;
  const tva = Math.round(montantHt * (tvaPct / 100) * 100) / 100;
  const montantTtc = Math.round((montantHt + tva) * 100) / 100;

  const info = db.prepare(`
    INSERT INTO private_invoices (user_id, client_id, ride_ids, montant_ht, tva, montant_ttc, date_emission, statut)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'), 'envoyee')
  `).run(DEFAULT_USER, input.client_id, JSON.stringify(input.ride_ids), round2(montantHt), tva, montantTtc);

  return getInvoice(Number(info.lastInsertRowid));
}

export function updateInvoiceStatus(id: number, statut: string) {
  const valid = ["brouillon", "envoyee", "payee", "en_retard"];
  if (!valid.includes(statut)) throw new Error("Statut invalide");
  const paidAt = statut === "payee" ? `datetime('now')` : "NULL";
  db.prepare(`UPDATE private_invoices SET statut = ?, paid_at = ${paidAt} WHERE id = ? AND user_id = ?`)
    .run(statut, id, DEFAULT_USER);
  return getInvoice(id);
}

export function deleteInvoice(id: number) {
  const info = db.prepare(`DELETE FROM private_invoices WHERE id = ? AND user_id = ?`).run(id, DEFAULT_USER);
  return { deleted: info.changes > 0 };
}

// 17.3 Génération PDF facture (rendue en HTML formaté, impression côté client via window.print)
export function generateInvoiceHtml(id: number): string {
  const invoice = getInvoice(id);
  if (!invoice) throw new Error("Facture introuvable");

  const dateEmission = new Date(invoice.date_emission).toLocaleDateString("fr-FR", {
    day: "2-digit", month: "long", year: "numeric",
  });
  const ridesRows = (invoice.rides as any[])
    .map(
      (r) => `
        <tr>
          <td>${new Date(r.date).toLocaleDateString("fr-FR")}</td>
          <td>${escapeHtml(r.note || "Course VTC")}</td>
          <td style="text-align:right">${r.distance ? r.distance.toFixed(1) + " km" : "—"}</td>
          <td style="text-align:right">${r.montant.toFixed(2)} €</td>
        </tr>`
    )
    .join("");

  const statutLabel: Record<string, string> = {
    brouillon: "Brouillon", envoyee: "Envoyée", payee: "Payée", en_retard: "En retard",
  };

  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8" />
<title>Facture n°${invoice.id}</title>
<style>
  body { font-family: 'Helvetica Neue', Arial, sans-serif; color: #1a1a1a; max-width: 700px; margin: 40px auto; padding: 0 20px; }
  h1 { font-size: 22px; margin-bottom: 4px; }
  .subtitle { color: #666; font-size: 13px; margin-bottom: 24px; }
  .grid { display: flex; justify-content: space-between; margin-bottom: 24px; }
  .box { font-size: 13px; line-height: 1.5; }
  .box strong { display: block; font-size: 14px; margin-bottom: 4px; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 24px; }
  th, td { padding: 8px; border-bottom: 1px solid #e2e2e2; font-size: 13px; text-align: left; }
  th { background: #f5f5f5; font-weight: 600; }
  .totals { margin-left: auto; width: 280px; font-size: 14px; }
  .totals div { display: flex; justify-content: space-between; padding: 4px 0; }
  .totals .ttc { font-weight: 700; font-size: 16px; border-top: 2px solid #1a1a1a; margin-top: 6px; padding-top: 8px; }
  .statut { display: inline-block; padding: 3px 10px; border-radius: 12px; font-size: 12px; font-weight: 600; background: #e8f5e9; color: #2e7d32; }
  .footer { margin-top: 40px; font-size: 11px; color: #888; border-top: 1px solid #eee; padding-top: 12px; }
  @media print { body { margin: 0; padding: 20px; } }
</style>
</head>
<body>
  <h1>FACTURE n°${String(invoice.id).padStart(5, "0")}</h1>
  <div class="subtitle">Émise le ${dateEmission} — <span class="statut">${statutLabel[invoice.statut] || invoice.statut}</span></div>

  <div class="grid">
    <div class="box">
      <strong>Chauffeur VTC</strong>
      VTC Intelligence<br/>
      Auto-entrepreneur — TVA non applicable, art. 293 B du CGI<br/>
    </div>
    <div class="box">
      <strong>Client</strong>
      ${escapeHtml(invoice.client_nom)}<br/>
      ${invoice.client_tel ? escapeHtml(invoice.client_tel) + "<br/>" : ""}
      ${invoice.client_email ? escapeHtml(invoice.client_email) : ""}
    </div>
  </div>

  <table>
    <thead>
      <tr><th>Date</th><th>Description</th><th style="text-align:right">Distance</th><th style="text-align:right">Montant</th></tr>
    </thead>
    <tbody>
      ${ridesRows}
    </tbody>
  </table>

  <div class="totals">
    <div><span>Total HT</span><span>${invoice.montant_ht.toFixed(2)} €</span></div>
    <div><span>TVA</span><span>${invoice.tva.toFixed(2)} €</span></div>
    <div class="ttc"><span>Total TTC</span><span>${invoice.montant_ttc.toFixed(2)} €</span></div>
  </div>

  <div class="footer">
    Facture générée automatiquement par VTC Intelligence — CRM Chauffeur.<br/>
    En cas de retard de paiement, des pénalités légales peuvent s'appliquer (art. L441-10 du Code de commerce).
  </div>
</body>
</html>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 17.4 Relances impayés — J+7 / J+15 / J+30
// ─────────────────────────────────────────────────────────────────────────────
export function invoiceReminders() {
  const rows = db.prepare(`
    SELECT pi.*, pc.nom AS client_nom, pc.tel AS client_tel, pc.email AS client_email
    FROM private_invoices pi
    JOIN private_clients pc ON pc.id = pi.client_id
    WHERE pi.user_id = ? AND pi.statut != 'payee'
    ORDER BY pi.date_emission ASC
  `).all(DEFAULT_USER) as any[];

  const now = Date.now();
  const buckets = { j7: [] as any[], j15: [] as any[], j30: [] as any[], a_jour: [] as any[] };

  for (const inv of rows) {
    const emisAt = new Date(inv.date_emission).getTime();
    const daysSince = Math.floor((now - emisAt) / (1000 * 60 * 60 * 24));
    const entry = { ...inv, days_since_emission: daysSince };
    if (daysSince >= 30) buckets.j30.push(entry);
    else if (daysSince >= 15) buckets.j15.push(entry);
    else if (daysSince >= 7) buckets.j7.push(entry);
    else buckets.a_jour.push(entry);
  }

  return {
    j7: buckets.j7,
    j15: buckets.j15,
    j30: buckets.j30,
    a_jour: buckets.a_jour,
    total_impaye: round2(rows.reduce((s, r) => s + (r.montant_ttc || 0), 0)),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 14.1 Bourse d'échange de courses (démo — sans vraie communauté)
// ─────────────────────────────────────────────────────────────────────────────
export function listRideExchange() {
  return db.prepare(`SELECT * FROM ride_exchange ORDER BY status ASC, created_at DESC`).all();
}

export function createRideExchange(input: { from_ride: string; to_zone: string; price: number }) {
  if (!input.from_ride || !input.to_zone) throw new Error("Description de la course et zone requises");
  const info = db.prepare(`
    INSERT INTO ride_exchange (from_user, from_ride, to_zone, price, status, created_at)
    VALUES (?, ?, ?, ?, 'ouverte', datetime('now'))
  `).run(DEFAULT_USER, input.from_ride.trim(), input.to_zone.trim(), input.price || 0);
  return db.prepare(`SELECT * FROM ride_exchange WHERE id = ?`).get(info.lastInsertRowid);
}

export function updateRideExchangeStatus(id: number, status: string) {
  const valid = ["ouverte", "reservee", "terminee", "annulee"];
  if (!valid.includes(status)) throw new Error("Statut invalide");
  db.prepare(`UPDATE ride_exchange SET status = ? WHERE id = ?`).run(status, id);
  return db.prepare(`SELECT * FROM ride_exchange WHERE id = ?`).get(id);
}

export function deleteRideExchange(id: number) {
  const info = db.prepare(`DELETE FROM ride_exchange WHERE id = ?`).run(id);
  return { deleted: info.changes > 0 };
}

// ─────────────────────────────────────────────────────────────────────────────
// 17.1 Templates réponses auto SMS/WhatsApp
// ─────────────────────────────────────────────────────────────────────────────
export function listAutoReplyTemplates() {
  const rows = db.prepare(`SELECT * FROM auto_reply_templates WHERE user_id = ? ORDER BY id ASC`).all(DEFAULT_USER) as any[];
  return rows.map((r) => ({ ...r, active: !!r.active }));
}

export function createAutoReplyTemplate(input: { trigger_type: string; message: string }) {
  if (!input.message || !input.message.trim()) throw new Error("Message requis");
  const info = db.prepare(`
    INSERT INTO auto_reply_templates (user_id, trigger_type, message, active) VALUES (?, ?, ?, 1)
  `).run(DEFAULT_USER, input.trigger_type || "en_conduite", input.message.trim());
  return db.prepare(`SELECT * FROM auto_reply_templates WHERE id = ?`).get(info.lastInsertRowid);
}

export function updateAutoReplyTemplate(id: number, input: Partial<{ trigger_type: string; message: string; active: boolean }>) {
  const existing = db.prepare(`SELECT * FROM auto_reply_templates WHERE id = ? AND user_id = ?`).get(id, DEFAULT_USER);
  if (!existing) throw new Error("Template introuvable");
  const fields: string[] = [];
  const values: any[] = [];
  if (input.trigger_type !== undefined) { fields.push("trigger_type = ?"); values.push(input.trigger_type); }
  if (input.message !== undefined) { fields.push("message = ?"); values.push(input.message); }
  if (input.active !== undefined) { fields.push("active = ?"); values.push(input.active ? 1 : 0); }
  if (fields.length === 0) return existing;
  values.push(id, DEFAULT_USER);
  db.prepare(`UPDATE auto_reply_templates SET ${fields.join(", ")} WHERE id = ? AND user_id = ?`).run(...values);
  return db.prepare(`SELECT * FROM auto_reply_templates WHERE id = ?`).get(id);
}

export function deleteAutoReplyTemplate(id: number) {
  const info = db.prepare(`DELETE FROM auto_reply_templates WHERE id = ? AND user_id = ?`).run(id, DEFAULT_USER);
  return { deleted: info.changes > 0 };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
function safeJsonParse(value: any, fallback: any) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function round2(n: number): number {
  return Math.round((n || 0) * 100) / 100;
}

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
