/* eslint-disable */
// ════════════════════════════════════════════════════════════════════════════
// PATCH (DOCUMENTATION) — endpoints économiques dédiés
// ────────────────────────────────────────────────────────────────────────────
// CE FICHIER N'EST PAS UN MODULE DE ROUTES ACTIF.
// C'est une documentation décrivant 2 endpoints OPTIONNELS à ajouter
// manuellement dans `registerRoutes()` de `server/routes.ts` si l'on souhaite
// que l'agrégation économique soit calculée côté serveur plutôt que côté client.
//
// Aujourd'hui, `client/src/pages/EconomicsDashboard.tsx` calcule TOUT côté
// client à partir de :
//     GET /api/rides            (courses récentes)
//     GET /api/rides/stats      (stats agrégées)
//     GET /api/driver-profile   (paramètres économiques)
//     GET /api/profitability    (scores par zone / heure)
//     GET /api/gmaps-distances  (cache routier OSRM)
//
// Les endpoints ci-dessous ne sont nécessaires QUE pour décharger ce calcul
// vers le serveur (ex. mobile, widgets externes, exports). Copier-coller le
// corps des handlers dans routes.ts puis adapter aux helpers `storage`.
// ════════════════════════════════════════════════════════════════════════════

// ────────────────────────────────────────────────────────────────────────────
// GET /api/economics/daily
// ────────────────────────────────────────────────────────────────────────────
// Agrège les données du jour : KPIs journaliers, coûts, insights.
// → calcule tout depuis /api/rides + /api/driver-profile.
//
// Réponse attendue :
// {
//   dailyRealized:      number,   // SUM(net_profit) des courses du jour
//   dailyTarget:        number,   // hourly_target_income × 8h
//   avgHourlyRate:      number,   // moyenne pondérée des hourly_rate
//   profitableCount:    number,
//   totalRides:         number,
//   efficiencyRatio:    number,   // profitable / total × 100
//   commissionLeakage:  number,   // SUM(commission) / SUM(fare) × 100
//   avgFuelPerRide:     number,   // SUM(fuel_cost) / COUNT(rides)
//   avgWearPerRide:     number,
//   insights: { level: "good"|"warning"|"critical"; title: string; detail: string }[]
// }
//
// Implémentation suggérée :
//
//   app.get("/api/economics/daily", (_req, res) => {
//     const p: any = storage.getDriverProfile();
//     if (!p) return res.status(400).json({ error: "Profile manquant" });
//     const today = new Date().toISOString().slice(0, 10);
//     const rides: any[] = storage.getRecentRides(500)
//       .filter((r: any) => String(r.timestamp).slice(0, 10) === today);
//
//     const commPct  = p.platform_commission_pct ?? 25;
//     const fuelP100 = p.fuel_consumption_per100km ?? 7.5;
//     const fuelEUR  = p.fuel_price_per_liter ?? 1.92;
//     const wearKm   = p.wear_cost_per_km ?? 0.08;
//     const targetH  = p.hourly_target_income ?? 35;
//
//     let sumNet = 0, sumFare = 0, sumComm = 0, sumFuel = 0, sumWear = 0, profitable = 0;
//     for (const r of rides) {
//       const comm = r.fare * (commPct / 100);
//       const fuel = (r.distance_km / 100) * fuelP100 * fuelEUR;
//       const wear = r.distance_km * wearKm;
//       const net  = r.fare - comm - fuel - wear;
//       sumNet += net; sumFare += r.fare; sumComm += comm; sumFuel += fuel; sumWear += wear;
//       if (r.distance_km > 0 && r.fare >= r.distance_km && r.duration_min <= r.distance_km) profitable++;
//     }
//     const total = rides.length;
//     res.json({
//       dailyRealized:     Math.round(sumNet * 100) / 100,
//       dailyTarget:       targetH * 8,
//       avgHourlyRate:     total ? Math.round((rides.reduce((s, r) => s + r.hourly_rate, 0) / total) * 100) / 100 : 0,
//       profitableCount:   profitable,
//       totalRides:        total,
//       efficiencyRatio:   total ? Math.round((profitable / total) * 1000) / 10 : 0,
//       commissionLeakage: sumFare ? Math.round((sumComm / sumFare) * 1000) / 10 : 0,
//       avgFuelPerRide:    total ? Math.round((sumFuel / total) * 100) / 100 : 0,
//       avgWearPerRide:    total ? Math.round((sumWear / total) * 100) / 100 : 0,
//       insights:          [], // calculer côté serveur si besoin (cf. buildInsights front)
//     });
//   });

// ────────────────────────────────────────────────────────────────────────────
// GET /api/economics/zone-breakdown
// ────────────────────────────────────────────────────────────────────────────
// Pour chaque zone : avg_fare_per_km, avg_hourly_net, profitable_pct, nb_rides.
// → depuis profitability_scores + données calibrées (cache routier).
//
// Réponse attendue : tableau d'objets
// [
//   {
//     zoneId:        string,
//     zoneName:      string,
//     avgFarePerKm:  number,   // avg_fare / avg_distance_km
//     avgHourlyNet:  number,   // (avg_fare - comm - fuel - wear) / avg_duration_min × 60
//     profitablePct: number,   // % des heures où la zone passe le seuil 1€/km & 1min/km
//     nbRides:       number,    // nombre de courses observées (si disponible)
//     roadKm:        number     // distance routière OSRM (cache)
//   }, ...
// ]
//
// Implémentation suggérée :
//
//   app.get("/api/economics/zone-breakdown", (req, res) => {
//     const p: any = storage.getDriverProfile();
//     if (!p) return res.status(400).json({ error: "Profile manquant" });
//     const hour    = parseInt(req.query.hour as string) || new Date().getHours();
//     const dayType = (req.query.dayType as string)
//       || ([0, 6].includes(new Date().getDay()) ? "weekend" : "weekday");
//     const scores: any[] = storage.getProfitabilityByHour(hour, dayType);
//     const routes        = getAllCachedRoutes(); // import depuis ./routingCache
//
//     const commPct  = p.platform_commission_pct ?? 25;
//     const fuelP100 = p.fuel_consumption_per100km ?? 7.5;
//     const fuelEUR  = p.fuel_price_per_liter ?? 1.92;
//     const wearKm   = p.wear_cost_per_km ?? 0.08;
//
//     res.json(scores.map((s: any) => {
//       const dist = s.avg_distance_km;
//       const net  = s.avg_fare - s.avg_fare * (commPct / 100)
//                  - (dist / 100) * fuelP100 * fuelEUR - dist * wearKm;
//       const profitable = dist > 0 && s.avg_fare >= dist && s.avg_duration_min <= dist;
//       return {
//         zoneId:        s.zone_id,
//         zoneName:      s.zone_name,
//         avgFarePerKm:  dist > 0 ? Math.round((s.avg_fare / dist) * 100) / 100 : 0,
//         avgHourlyNet:  s.avg_duration_min > 0 ? Math.round((net / s.avg_duration_min) * 60 * 10) / 10 : 0,
//         profitablePct: profitable ? 100 : 0,
//         nbRides:       0,
//         roadKm:        routes[s.zone_id]?.roadKm ?? dist,
//       };
//     }));
//   });

export {}; // garde ce fichier comme module ESM valide (aucune route active)
