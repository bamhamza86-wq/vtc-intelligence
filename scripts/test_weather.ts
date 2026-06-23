import { getCurrentWeather, getWeatherBoost, refreshWeather, getCachedWeather } from "../server/weatherService";

async function main() {
  console.log("== Test 1: getCurrentWeather (fetch r\u00e9el Open-Meteo) ==");
  const w = await getCurrentWeather();
  console.log(JSON.stringify(w, null, 2));

  console.log("\n== Test 2: getWeatherBoost (sync depuis cache) ==");
  console.log("boost =", getWeatherBoost());

  console.log("\n== Test 3: getCachedWeather ==");
  console.log("cached code =", getCachedWeather()?.code);

  console.log("\n== Test 4: refreshWeather (force) ==");
  await refreshWeather();
  const w2 = getCachedWeather();
  console.log("apr\u00e8s refresh: code =", w2?.code, "desc =", w2?.description, "boost =", w2?.demand_boost);

  console.log("\n== Test 5: cache hit (2e appel ne refait pas de fetch) ==");
  const t0 = Date.now();
  await getCurrentWeather();
  console.log("dur\u00e9e 2e appel (cache) =", Date.now() - t0, "ms (doit \u00eatre ~0)");

  console.log("\nOK \u2014 weatherService fonctionnel");
}
main().catch((e) => { console.error("ERREUR test:", e); process.exit(1); });
