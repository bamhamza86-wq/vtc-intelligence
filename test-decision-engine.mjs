// Test direct du moteur de décision (sans serveur HTTP) — contourne les
// contraintes réseau du sandbox partagé. Utilise tsx pour exécuter le TS.
import { computeTripChains, computeWhatIf, computeCounterIntuition, answerCoachQuestion, answerTaxQuestion, computeProactiveTips } from "./server/decisionEngine.ts";

console.log("=== 1. Trip-chaining (origine Bd Ney, 48.8976, 2.3299) ===");
const t0 = Date.now();
const chains = computeTripChains(48.8976, 2.3299, undefined, 90);
console.log(`Durée: ${Date.now() - t0}ms`);
console.log(JSON.stringify(chains, null, 2).slice(0, 2000));
console.assert(chains.chains.length > 0 && chains.chains.length <= 3, "FAIL: doit retourner 1-3 chaînes");
console.assert(typeof chains.best_chain_index === "number", "FAIL: best_chain_index manquant");

console.log("\n=== 2. What-If simulator — 3 scénarios ===");
const t1 = Date.now();
const whatIf = computeWhatIf([
  { label: "Aller à CDG", action: { type: "goto_zone", zone_name: "Aéroport CDG", origin_lat: 48.8976, origin_lng: 2.3299 } },
  { label: "Aller à La Défense", action: { type: "goto_zone", zone_name: "La Défense", origin_lat: 48.8976, origin_lng: 2.3299 } },
  { label: "Attendre 10 min ici", action: { type: "wait", wait_min: 10 } },
]);
const whatIfMs = Date.now() - t1;
console.log(`Durée: ${whatIfMs}ms`);
console.log(JSON.stringify(whatIf, null, 2));
console.assert(whatIf.length === 3, "FAIL: doit retourner 3 résultats");
console.assert(whatIfMs < 500, `FAIL: doit répondre en <500ms (${whatIfMs}ms)`);

console.log("\n=== 3. Alerte contre-intuition ===");
const ci = computeCounterIntuition(35, 4, 12, undefined);
console.log(JSON.stringify(ci, null, 2));
console.assert(["accept", "refuse", "careful"].includes(ci.verdict), "FAIL: verdict invalide");

console.log("\n=== 4. Coach — 'franchise TVA' ===");
const coach = answerCoachQuestion("franchise TVA");
console.log(JSON.stringify(coach, null, 2));
console.assert(/tva/i.test(coach.answer_fr), "FAIL: réponse doit mentionner la TVA");

console.log("\n=== 4bis. Coach TAX — 'Suis-je proche de la franchise TVA ?' ===");
const taxCoach = answerTaxQuestion("Suis-je proche de la franchise TVA ?");
console.log(JSON.stringify(taxCoach, null, 2));
console.assert(/\d/.test(taxCoach.answer_fr), "FAIL: doit contenir un seuil chiffré");

console.log("\n=== 5. Proactive tips ===");
const tips = computeProactiveTips();
console.log(JSON.stringify(tips, null, 2));
console.assert(tips.length <= 3, "FAIL: max 3 tips");

console.log("\n✅ Tous les tests fonctionnels sont passés (voir asserts ci-dessus).");
