/**
 * decision.ts — Router Express : Couche Décision Avancée (Itération 3)
 * ─────────────────────────────────────────────────────────────────────────────
 * Expose en HTTP la logique pure de server/decisionEngine.ts (trip-chaining,
 * simulateur What-If, alerte contre-intuition) et server/coachTemplates.ts
 * (coach VTC textuel, sans LLM). Monté sur /api/decision et /api/coach dans
 * routes.ts via `app.use(decisionRouter)`.
 *
 * rapport.md §3.2 (trip-chaining), §3.3 (What-If), §3.6 (contre-intuition),
 * §12.2/§12.4 (coach conversationnel + assistant fiscal).
 *
 * Toutes les routes personnelles sont protégées par requireAuth (cf. contrainte
 * dure du projet). ZÉRO nouvelle dépendance npm — Express (déjà présent) uniquement.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { Router, Request, Response } from "express";
import { requireAuth } from "./auth";
import {
  computeTripChains,
  computeWhatIf,
  computeCounterIntuition,
  answerCoachQuestion,
  answerTaxQuestion,
  computeProactiveTips,
  type WhatIfScenario,
} from "./decisionEngine";
import { COACH_TEMPLATES } from "./coachTemplates";

export const decisionRouter = Router();

// ═════════════════════════════════════════════════════════════════════════════
// 1. TRIP-CHAINING — rapport.md §3.2
// ═════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/decision/trip-chain
 * Query : origin_zone="lat,lng" (requis), hour (optionnel, override), horizon_min (optionnel, def 90)
 * Alias : GET /api/decision/trip-chain-suggestions (même contrat, nommage rapport.md)
 */
function handleTripChain(req: Request, res: Response) {
  try {
    const originZoneRaw = (req.query.origin_zone as string) || "";
    let lat = 48.8566;
    let lng = 2.3522;
    if (originZoneRaw.includes(",")) {
      const [latStr, lngStr] = originZoneRaw.split(",");
      const parsedLat = parseFloat(latStr);
      const parsedLng = parseFloat(lngStr);
      if (!Number.isNaN(parsedLat) && !Number.isNaN(parsedLng)) {
        lat = parsedLat;
        lng = parsedLng;
      }
    } else {
      const qLat = parseFloat(req.query.lat as string);
      const qLng = parseFloat(req.query.lng as string);
      if (!Number.isNaN(qLat) && !Number.isNaN(qLng)) {
        lat = qLat;
        lng = qLng;
      }
    }
    const hourRaw = req.query.hour as string;
    const hour = hourRaw != null && hourRaw !== "" ? parseInt(hourRaw, 10) : undefined;
    const horizonRaw = req.query.horizon_min as string;
    const horizonMin = horizonRaw != null && horizonRaw !== "" ? parseInt(horizonRaw, 10) : 90;

    const result = computeTripChains(lat, lng, hour, horizonMin);
    res.json(result);
  } catch (e: any) {
    console.error("[decision/trip-chain] error:", e);
    res.status(500).json({ error: "trip_chain_error", message: e?.message || "unknown" });
  }
}
decisionRouter.get("/api/decision/trip-chain", requireAuth, handleTripChain);
decisionRouter.get("/api/decision/trip-chain-suggestions", requireAuth, handleTripChain);

// ═════════════════════════════════════════════════════════════════════════════
// 2. SIMULATEUR WHAT-IF — rapport.md §3.3
// ═════════════════════════════════════════════════════════════════════════════

/**
 * POST /api/decision/what-if
 * Body : { scenarios: WhatIfScenario[] (max 3), hour?: number }
 */
decisionRouter.post("/api/decision/what-if", requireAuth, (req: Request, res: Response) => {
  try {
    const { scenarios, hour } = req.body as { scenarios?: WhatIfScenario[]; hour?: number };
    if (!Array.isArray(scenarios) || scenarios.length === 0) {
      return res.status(400).json({ error: "scenarios requis (array non vide)" });
    }
    const results = computeWhatIf(scenarios, hour);
    res.json(results);
  } catch (e: any) {
    console.error("[decision/what-if] error:", e);
    res.status(500).json({ error: "what_if_error", message: e?.message || "unknown" });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. ALERTE CONTRE-INTUITION — rapport.md §3.6
// ═════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/decision/counter-intuition
 * Query : fare, distance, duration (requis, numériques), dropoff_zone (optionnel, id de zone)
 * Alias : GET /api/decision/counter-intuitions (nommage rapport.md, pluriel)
 */
function handleCounterIntuition(req: Request, res: Response) {
  try {
    const fare = parseFloat(req.query.fare as string);
    const distance = parseFloat(req.query.distance as string);
    const duration = parseFloat(req.query.duration as string);
    const dropoffZone = (req.query.dropoff_zone as string) || undefined;

    if ([fare, distance, duration].some((n) => Number.isNaN(n))) {
      return res.status(400).json({ error: "fare, distance et duration sont requis (nombres)" });
    }

    const result = computeCounterIntuition(fare, distance, duration, dropoffZone);
    res.json(result);
  } catch (e: any) {
    console.error("[decision/counter-intuition] error:", e);
    res.status(500).json({ error: "counter_intuition_error", message: e?.message || "unknown" });
  }
}
decisionRouter.get("/api/decision/counter-intuition", requireAuth, handleCounterIntuition);
decisionRouter.get("/api/decision/counter-intuitions", requireAuth, handleCounterIntuition);

// ═════════════════════════════════════════════════════════════════════════════
// 4. COACH CONVERSATIONNEL — rapport.md §12.2 / §12.4
// ═════════════════════════════════════════════════════════════════════════════

/** POST /api/coach/ask — body { question: string } */
decisionRouter.post("/api/coach/ask", requireAuth, (req: Request, res: Response) => {
  try {
    const { question } = req.body as { question?: string };
    if (!question || !question.trim()) {
      return res.status(400).json({ error: "question requise" });
    }
    res.json(answerCoachQuestion(question));
  } catch (e: any) {
    console.error("[coach/ask] error:", e);
    res.status(500).json({ error: "coach_ask_error", message: e?.message || "unknown" });
  }
});

/** POST /api/coach/tax — body { question: string, context?: { ca_annuel?, activite_debut? } } */
decisionRouter.post("/api/coach/tax", requireAuth, (req: Request, res: Response) => {
  try {
    const { question, context } = req.body as { question?: string; context?: { ca_annuel?: number; activite_debut?: string } };
    if (!question || !question.trim()) {
      return res.status(400).json({ error: "question requise" });
    }
    res.json(answerTaxQuestion(question, context));
  } catch (e: any) {
    console.error("[coach/tax] error:", e);
    res.status(500).json({ error: "coach_tax_error", message: e?.message || "unknown" });
  }
});

/**
 * GET /api/coach/faq — liste complète de la FAQ VTC (URSSAF, TVA, IK, statut,
 * droit du travail...) pour affichage statique côté client (accordéon FAQ),
 * sans passer par le matching de question.
 */
decisionRouter.get("/api/coach/faq", requireAuth, (_req: Request, res: Response) => {
  try {
    const faq = COACH_TEMPLATES.map((t) => ({
      id: t.id,
      category: t.category,
      question_hint_fr: t.question_pattern[0],
      answer_fr: t.render(),
      sources: t.sources,
    }));
    res.json({ faq });
  } catch (e: any) {
    console.error("[coach/faq] error:", e);
    res.status(500).json({ error: "coach_faq_error", message: e?.message || "unknown" });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. TIPS PROACTIFS
// ═════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/coach/proactive-tips — jusqu'à 3 tips contextuels (historique, météo/événements, économie)
 * Alias : GET /api/coach/proactive-tip (singulier, nommage rapport.md) — retourne le 1er tip uniquement.
 */
decisionRouter.get("/api/coach/proactive-tips", requireAuth, (_req: Request, res: Response) => {
  try {
    const tips = computeProactiveTips();
    res.json({ tips });
  } catch (e: any) {
    console.error("[coach/proactive-tips] error:", e);
    res.status(500).json({ error: "proactive_tips_error", message: e?.message || "unknown" });
  }
});

decisionRouter.get("/api/coach/proactive-tip", requireAuth, (_req: Request, res: Response) => {
  try {
    const tips = computeProactiveTips();
    res.json(tips[0] ?? null);
  } catch (e: any) {
    console.error("[coach/proactive-tip] error:", e);
    res.status(500).json({ error: "proactive_tip_error", message: e?.message || "unknown" });
  }
});

export default decisionRouter;
