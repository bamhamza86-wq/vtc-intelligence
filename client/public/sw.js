// ──────────────────────────────────────────────────────────────────────────────
// VTC Intelligence — Service Worker
// Stratégies :
//  - Cache-first      : tuiles Leaflet OpenStreetMap + assets Vite (/assets/*)
//  - Network-first     : lectures API critiques (zones/summary, alerts, predicthq)
//                        avec fallback cache + TTL 10 min
//  - Network-only      : auth + mutations communautaires (jamais de cache)
// Cache versionné (vtc-v1), nettoyage des anciens caches à l'activation.
// ──────────────────────────────────────────────────────────────────────────────

const CACHE_VERSION = "vtc-v1";
const STATIC_CACHE = `${CACHE_VERSION}-static`;
const TILES_CACHE = `${CACHE_VERSION}-tiles`;
const API_CACHE = `${CACHE_VERSION}-api`;

const ALL_CACHES = [STATIC_CACHE, TILES_CACHE, API_CACHE];

// TTL pour les réponses API mises en cache (network-first avec fallback)
const API_CACHE_TTL_MS = 10 * 60 * 1000; // 10 min

// Routes API en lecture -> network-first + fallback cache avec TTL
const NETWORK_FIRST_API_PATTERNS = [
  /\/api\/zones\/summary(\?.*)?$/,
  /\/api\/top-zones(\?.*)?$/,
  /\/api\/alerts(\?.*)?$/,
  /\/api\/predicthq\/.*$/,
];

// Routes API jamais mises en cache : auth + mutations communauté
const NETWORK_ONLY_API_PATTERNS = [
  /\/api\/auth\/.*$/,
  /\/api\/community\/signal(\?.*)?$/,
  /\/api\/zones\/.*\/signal(\?.*)?$/,
];

// ──────────────────────────────────────────────────────────────────────────────
// install — pré-cache rien de bloquant, on laisse le cache se remplir à l'usage
// ──────────────────────────────────────────────────────────────────────────────
self.addEventListener("install", (event) => {
  self.skipWaiting();
});

// ──────────────────────────────────────────────────────────────────────────────
// activate — nettoyage des anciens caches (versions précédentes) + clients.claim
// ──────────────────────────────────────────────────────────────────────────────
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key.startsWith("vtc-") && !ALL_CACHES.includes(key))
          .map((key) => caches.delete(key))
      );
      await self.clients.claim();
    })()
  );
});

// ──────────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────────
function isTileRequest(url) {
  return /^https:\/\/[a-z]\.tile\.openstreetmap\.org\//i.test(url.href) ||
    /tile\.openstreetmap\.org/i.test(url.hostname);
}

function isViteAsset(url) {
  return url.pathname.startsWith("/assets/");
}

function matchesAny(patterns, pathname) {
  return patterns.some((re) => re.test(pathname));
}

function isNetworkOnlyApi(url) {
  return matchesAny(NETWORK_ONLY_API_PATTERNS, url.pathname);
}

function isNetworkFirstApi(url) {
  return matchesAny(NETWORK_FIRST_API_PATTERNS, url.pathname);
}

// Enveloppe une réponse en cache avec un timestamp pour gérer le TTL
async function putWithTimestamp(cache, request, response) {
  const clone = response.clone();
  const headers = new Headers(clone.headers);
  headers.set("sw-cached-at", Date.now().toString());
  const body = await clone.blob();
  const timestamped = new Response(body, {
    status: clone.status,
    statusText: clone.statusText,
    headers,
  });
  await cache.put(request, timestamped);
}

function isFresh(response, ttlMs) {
  const cachedAt = response.headers.get("sw-cached-at");
  if (!cachedAt) return true; // pas de timestamp = on considère utilisable (fallback)
  return Date.now() - Number(cachedAt) < ttlMs;
}

// ──────────────────────────────────────────────────────────────────────────────
// Stratégie : Cache-first (tuiles Leaflet, assets Vite)
// ──────────────────────────────────────────────────────────────────────────────
async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response && response.ok) {
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    if (cached) return cached;
    throw err;
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Stratégie : Network-first avec fallback cache + TTL (API zones/alerts/predicthq)
// ──────────────────────────────────────────────────────────────────────────────
async function networkFirst(request, cacheName, ttlMs) {
  const cache = await caches.open(cacheName);
  try {
    const response = await fetch(request);
    if (response && response.ok) {
      await putWithTimestamp(cache, request, response.clone());
    }
    return response;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) {
      // Retourne le cache même si "périmé" (staleness gérée côté client via
      // offlineCache.ts) — mieux vaut une donnée un peu vieille que rien.
      return cached;
    }
    throw err;
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// fetch — routeur principal
// ──────────────────────────────────────────────────────────────────────────────
self.addEventListener("fetch", (event) => {
  const { request } = event;

  // On ne gère que GET ; les autres méthodes passent toujours par le réseau.
  if (request.method !== "GET") {
    return;
  }

  const url = new URL(request.url);

  // ── Network-only : auth + mutations communauté (jamais de cache) ──────────
  if (isNetworkOnlyApi(url)) {
    event.respondWith(fetch(request));
    return;
  }

  // ── Cache-first : tuiles OpenStreetMap ─────────────────────────────────────
  if (isTileRequest(url)) {
    event.respondWith(cacheFirst(request, TILES_CACHE));
    return;
  }

  // ── Cache-first : assets Vite construits (/assets/*) ───────────────────────
  if (isViteAsset(url) && url.origin === self.location.origin) {
    event.respondWith(cacheFirst(request, STATIC_CACHE));
    return;
  }

  // ── Network-first + fallback cache (TTL 10 min) : API critiques ───────────
  if (isNetworkFirstApi(url)) {
    event.respondWith(networkFirst(request, API_CACHE, API_CACHE_TTL_MS));
    return;
  }

  // Tout le reste : comportement par défaut du navigateur (pas d'interception).
});

// ──────────────────────────────────────────────────────────────────────────────
// message — permet à l'app de forcer l'activation immédiate d'un nouveau SW
// (utilisé par pwa.ts après détection d'une mise à jour)
// ──────────────────────────────────────────────────────────────────────────────
self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

// ────────────────────────────────────────────────────────────────────────────
// push — notifications Web Push (additif, ne modifie pas les stratégies
// existantes ci-dessus). Le corps de la notification est du JSON envoyé par
// le serveur ({ title, body, url, tag }). VAPID configuré côté serveur via
// /api/push/subscribe-info — aucune dépendance npm ajoutée ici.
// ────────────────────────────────────────────────────────────────────────────
self.addEventListener("push", (event) => {
  let payload = { title: "VTC Intelligence", body: "Nouvelle notification", url: "/" };
  try {
    if (event.data) {
      payload = { ...payload, ...event.data.json() };
    }
  } catch (err) {
    if (event.data) {
      payload.body = event.data.text();
    }
  }

  const options = {
    body: payload.body,
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    tag: payload.tag || "vtc-notification",
    data: { url: payload.url || "/" },
  };

  event.waitUntil(self.registration.showNotification(payload.title, options));
});

// ────────────────────────────────────────────────────────────────────────────
// notificationclick — focus/ouvre l'app sur l'URL ciblée par la notification
// ────────────────────────────────────────────────────────────────────────────
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || "/";

  event.waitUntil(
    (async () => {
      const allClients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of allClients) {
        if ("focus" in client) {
          client.navigate(targetUrl);
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })()
  );
});
