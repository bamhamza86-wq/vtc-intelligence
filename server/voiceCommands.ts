/**
 * voiceCommands.ts — Parsing serveur des commandes vocales (rapport.md §10.3)
 * ─────────────────────────────────────────────────────────────────────────────
 * Complète le Web Speech API natif côté client (webkitSpeechRecognition,
 * useVoiceCommand / VoiceCommandButton) par une route backend qui interprète
 * la transcription et exécute les actions "avec effet de bord serveur" —
 * notamment le signalement communautaire vocal :
 *   "signale surge à Bercy" / "signale un bouchon à Roissy" / "zone morte à Orly"
 *
 * Le matching de zone est tolérant : recherche par nom exact, alias courants
 * (Bercy, Défense, CDG, Roissy, Orly...) et distance de Levenshtein légère
 * pour absorber les fautes de reconnaissance vocale (accents, coupures).
 *
 * ZÉRO dépendance npm — tout le NLP est un matcher de règles simple en TS.
 * requireAuth obligatoire (le signalement écrit en base au nom de l'utilisateur).
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { storage } from "./storage";
import { recordEnrichedSignal, type SignalContext } from "./communityEngine";
import { answerQuickVoiceQuery } from "./coachEngine";

export interface VoiceCommandResult {
  ok: boolean;
  intent: string;
  message: string; // message à restituer vocalement (fr) au chauffeur
  navigate?: string; // route client à ouvrir, le cas échéant
  matched_zone?: { id: string; name: string } | null;
  signal?: { type: "positive" | "negative"; context: SignalContext } | null;
}

// ─── Alias courants de lieux IDF non présents littéralement dans le nom de zone ───
// (ex : "Bercy" n'est pas un nom de zone exact dans le dataset 93+aéroports —
// on le rapproche de la zone la plus pertinente disponible plutôt que d'échouer.)
const ZONE_ALIASES: Record<string, string[]> = {
  z_cdg: ["cdg", "roissy", "charles de gaulle", "aeroport roissy"],
  z_orly: ["orly", "aeroport orly"],
  z_stade_france: ["stade de france", "bercy", "saint denis stade", "accor arena"],
  z_saint_denis_gare: ["gare saint denis", "saint denis gare"],
  z_bobigny_gare: ["bobigny", "pablo picasso"],
  z_aubervilliers: ["aubervilliers", "pantin"],
  z_epinay_gennevilliers: ["epinay", "gennevilliers"],
  z_plaine_commune: ["plaine commune", "defense", "la defense"],
  z_le_bourget: ["le bourget", "bourget", "parc expo"],
  z_villepinte: ["villepinte", "paris nord"],
  z_tremblay: ["tremblay"],
  z_93_centre: ["saint denis centre", "saint denis"],
  z_montreuil: ["montreuil"],
  z_aulnay: ["aulnay", "aulnay sous bois"],
};

function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Distance de Levenshtein simple (courtes chaînes uniquement — pas d'optimisation nécessaire). */
function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n];
}

interface ZoneRow { id: string; name: string; lat: number; lng: number; type: string }

/** Cherche la zone la plus proche du texte donné (nom exact, alias, ou fuzzy). */
function findZoneByText(rawText: string): ZoneRow | null {
  const text = normalize(rawText);
  if (!text) return null;
  const zones = (storage.getAllZones() as ZoneRow[]) || [];

  // 1. Alias explicite (le plus fiable pour les lieux hors-dataset comme "Bercy")
  for (const [zoneId, aliases] of Object.entries(ZONE_ALIASES)) {
    if (aliases.some((alias) => text.includes(alias))) {
      const z = zones.find((zz) => zz.id === zoneId);
      if (z) return z;
    }
  }

  // 2. Nom de zone exact (substring, insensible accents/casse)
  for (const z of zones) {
    const zn = normalize(z.name);
    if (text.includes(zn) || zn.includes(text)) return z;
  }

  // 3. Fuzzy — distance de Levenshtein tolérante sur chaque mot du texte vs nom de zone
  let best: { z: ZoneRow; dist: number } | null = null;
  for (const z of zones) {
    const zn = normalize(z.name);
    const dist = levenshtein(text, zn);
    const threshold = Math.max(2, Math.floor(zn.length * 0.35));
    if (dist <= threshold && (!best || dist < best.dist)) {
      best = { z, dist };
    }
  }
  return best ? best.z : null;
}

// ─── Détection du contexte de signalement (surge, bouchon, zone morte...) ───
const CONTEXT_KEYWORDS: Array<{ keywords: string[]; context: SignalContext; type: "positive" | "negative" }> = [
  { keywords: ["surge", "pic de prix", "prix eleve", "forte demande"], context: "surge", type: "positive" },
  { keywords: ["bouchon", "trafic", "circulation", "embouteillage"], context: "traffic", type: "negative" },
  { keywords: ["zone morte", "mort", "calme", "aucune course", "rien"], context: "dead", type: "negative" },
  { keywords: ["evenement", "concert", "match", "spectacle"], context: "event", type: "positive" },
  { keywords: ["danger", "insecurite", "attention"], context: "safety", type: "negative" },
  { keywords: ["borne", "recharge", "charging"], context: "charging", type: "positive" },
];

function detectSignalContext(text: string): { context: SignalContext; type: "positive" | "negative" } | null {
  for (const entry of CONTEXT_KEYWORDS) {
    if (entry.keywords.some((k) => text.includes(k))) {
      return { context: entry.context, type: entry.type };
    }
  }
  return null;
}

/**
 * Parse et exécute une commande vocale transcrite. Le champ `intent` renvoyé
 * permet au client de savoir quelle action locale déclencher en complément
 * (navigation, toast...) — le serveur gère uniquement les effets de bord
 * nécessitant une écriture DB (signalement communautaire).
 */
export function handleVoiceCommand(rawTranscript: string, userId: string): VoiceCommandResult {
  const text = normalize(rawTranscript);

  if (!text) {
    return { ok: false, intent: "unknown", message: "Je n'ai rien entendu, réessayez." };
  }

  // Intent : signalement communautaire vocal — "signale [surge/bouchon/...] à <zone>"
  const isSignalIntent = text.includes("signale") || text.includes("signaler") || text.includes("alerte");
  if (isSignalIntent) {
    const zone = findZoneByText(text);
    const ctx = detectSignalContext(text);

    if (!zone) {
      return {
        ok: false,
        intent: "signal_zone",
        message: "Zone non reconnue. Essayez par exemple : signale surge à Roissy.",
        matched_zone: null,
      };
    }

    const signalType = ctx?.type ?? "positive";
    const signalContext: SignalContext = ctx?.context ?? "surge";

    const result = recordEnrichedSignal({
      zoneId: zone.id,
      userId,
      type: signalType,
      intensity: 2,
      context: signalContext,
      commentShort: "signalement vocal",
    });

    if (!result.ok) {
      return {
        ok: false,
        intent: "signal_zone",
        message: `Signalement déjà enregistré récemment pour ${zone.name}, réessayez plus tard.`,
        matched_zone: { id: zone.id, name: zone.name },
      };
    }

    const contextLabel: Record<SignalContext, string> = {
      surge: "un pic de demande",
      traffic: "du trafic",
      dead: "une zone calme",
      event: "un événement",
      safety: "un problème de sécurité",
      wc: "des toilettes",
      charging: "une borne de recharge",
    };

    return {
      ok: true,
      intent: "signal_zone",
      message: `Signalement enregistré : ${contextLabel[signalContext] ?? signalContext} à ${zone.name}. Merci !`,
      matched_zone: { id: zone.id, name: zone.name },
      signal: { type: signalType, context: signalContext },
    };
  }

  // Intents "question rapide" (rapport.md §13.1) — délégués à coachEngine.answerQuickVoiceQuery
  // pour une réponse parlée riche (chiffres réels) plutôt qu'une simple navigation.
  // On tente ces intents AVANT les stubs de navigation génériques ci-dessous.
  const quick = answerQuickVoiceQuery(rawTranscript);
  if (quick.ok && quick.intent !== "unknown") {
    const navigateMap: Record<string, string> = {
      how_much_today: "/economics",
      where_to_go: "/focus",
    };
    return {
      ok: true,
      intent: quick.intent,
      message: quick.spoken_text,
      navigate: navigateMap[quick.intent],
    };
  }

  // Intents de navigation simple (miroir des intents déjà gérés côté client
  // useVoiceCommand/VoiceCommandButton — le serveur les reconnaît aussi pour
  // les clients qui appellent uniquement l'API sans logique locale).
  if (text.includes("ou aller") || text === "ou" || text.includes("focus")) {
    return { ok: true, intent: "navigate_focus", message: "Direction Focus.", navigate: "/focus" };
  }
  if (text.includes("pause")) {
    return { ok: true, intent: "pause", message: "Pause enregistrée." };
  }
  if (text.includes("combien") || text.includes("bilan") || text.includes("gains")) {
    return { ok: true, intent: "navigate_economics", message: "Voici votre bilan.", navigate: "/economics" };
  }
  if (text.includes("rentrer")) {
    return { ok: true, intent: "navigate_return", message: "Calcul du retour.", navigate: "/return-journey" };
  }
  if (text.includes("carte")) {
    return { ok: true, intent: "navigate_map", message: "Ouverture de la carte.", navigate: "/" };
  }

  return { ok: false, intent: "unknown", message: "Commande non reconnue." };
}
