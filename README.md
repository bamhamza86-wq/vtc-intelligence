# VTC Intelligence 🗺️

**Application d'aide à la décision pour chauffeurs VTC — Seine-Saint-Denis (93) + Aéroports CDG & Orly**

> Guidez-vous vers les zones les plus rentables en temps réel grâce à une heatmap interactive, un simulateur de rentabilité et des alertes intelligentes.

Live : **[vtc-one.pplx.app](https://vtc-one.pplx.app)**

---

## Table des matières

1. [Aperçu de l'application](#aperçu)
2. [Modèle économique — 1 €/km](#modèle-économique)
3. [Zones couvertes — Seine-Saint-Denis (93)](#zones)
4. [Architecture technique](#architecture)
5. [Stack & dépendances](#stack)
6. [Installation locale](#installation-locale)
7. [Déploiement sur pplx.app](#déploiement)
8. [Structure des fichiers](#structure)
9. [API Reference](#api-reference)
10. [Schéma SQLite](#schéma-sqlite)

---

## Aperçu

VTC Intelligence est une PWA fullstack (React + Express + SQLite) conçue pour aider les chauffeurs VTC à maximiser leur rentabilité dans le département **Seine-Saint-Denis (93)** et les deux aéroports parisiens.

### Fonctionnalités principales

| Page | Description |
|------|-------------|
| **Carte** | Heatmap Leaflet des 14 zones avec score de rentabilité, slider horaire 0h–23h, marqueurs d'événements en temps réel |
| **Simulateur** | Calcul du profit net par course (tarif, commission, carburant, usure), détection du seuil de rentabilité |
| **Alertes** | Flux d'opportunités priorisées (critique / haute / moyenne) avec revenus estimés et durée de validité |
| **Sources** | Catalogue des APIs et jeux de données intégrables (IDFM PRIM, CDG ADP, Ticketmaster, etc.) |
| **Profil** | Paramètres personnalisés du chauffeur : consommation, commission plateforme, objectif horaire |

---

## Modèle économique — 1 €/km

### Seuil de rentabilité

Le modèle repose sur deux conditions **simultanées** :

```
Tarif ≥ 1 €/km  ET  Durée ≤ 1 min/km
```

**Exemple concret :**
- Course de 16 km → tarif minimum = 16 € ET durée maximale = 16 min
- En deçà = perte nette après déduction des coûts
- Au-delà des deux seuils = rentabilité réelle

### Formule de calcul complet

```
Profit net = Tarif - Commission(%) - Carburant - Usure

Carburant   = (distance_km / 100) × conso_L100 × prix_litre
Usure       = distance_km × cout_usure_km
Commission  = tarif × (commission_pct / 100)

Taux horaire = (profit_net / durée_min) × 60
Score (0-100) = min(100, (taux_horaire / objectif_horaire) × 100)
```

### Paramètres par défaut (IDF)

| Paramètre | Valeur | Note |
|-----------|--------|------|
| Consommation | 7,5 L/100 km | Berline IDF (trafic dense) |
| Prix carburant | 1,92 €/L | Prix moyen IDF 2026 |
| Commission plateforme | 25 % | Uber/Bolt standard |
| Usure | 0,08 €/km | Entretien + pneumatiques |
| Objectif horaire | 35 €/h | Cible IDF (vs 30 €/h province) |
| Tarif base | 1,25 €/km + 2,50 € | Prise en charge IDF |

### Niveaux de rentabilité (carte)

| Couleur | Score | Label |
|---------|-------|-------|
| 🟢 Vert vif | ≥ 75 | Ultra rentable |
| 🟢 Vert clair | ≥ 60 | Rentable |
| 🟡 Jaune | ≥ 40 | Neutre |
| 🟠 Orange | ≥ 25 | Faible |
| 🔴 Rouge | < 25 | Saturé |

---

## Zones

### 14 zones Seine-Saint-Denis (93) + Aéroports

| ID | Nom | Type | Lat | Lng | Distance moy. | Probabilité longue course |
|----|-----|------|-----|-----|--------------|--------------------------|
| `z_cdg` | CDG — Roissy-en-France | Airport | 49.0097 | 2.5479 | 38 km | 92 % |
| `z_orly` | Orly — Terminal Sud/Ouest | Airport | 48.7262 | 2.3652 | 24 km | 80 % |
| `z_saint_denis_gare` | Gare Saint-Denis | Transport | 48.9362 | 2.3573 | 15 km | 38 % |
| `z_bobigny_gare` | Bobigny Pablo Picasso | Transport | 48.9059 | 2.4470 | 12 km | 30 % |
| `z_aubervilliers` | Aubervilliers — Pantin | Transport | 48.9144 | 2.3895 | 14 km | 35 % |
| `z_epinay_gennevilliers` | Épinay / Gennevilliers | Transport | 48.9527 | 2.3090 | 18 km | 42 % |
| `z_plaine_commune` | Plaine Commune — Affaires | Business | 48.9209 | 2.3716 | 16 km | 45 % |
| `z_le_bourget` | Le Bourget — Parc Expo | Business | 48.9437 | 2.4254 | 22 km | 55 % |
| `z_villepinte` | Villepinte — Paris Nord | Business | 48.9744 | 2.5330 | 28 km | 65 % |
| `z_tremblay` | Tremblay-en-France | Business | 48.9579 | 2.5572 | 32 km | 70 % |
| `z_stade_france` | Stade de France | Entertainment | 48.9245 | 2.3596 | 14 km | 32 % |
| `z_93_centre` | Saint-Denis — Centre | Entertainment | 48.9356 | 2.3535 | 13 km | 28 % |
| `z_montreuil` | Montreuil | Residential | 48.8637 | 2.4482 | 11 km | 25 % |
| `z_aulnay` | Aulnay-sous-Bois | Residential | 48.9383 | 2.4951 | 20 km | 48 % |

### Logique de scoring par zone

Pour chaque zone, les scores de rentabilité sont pré-calculés pour **24 heures × 2 types de jour** (weekday / weekend) :

```typescript
profitability_index = min(100, max(0,
  (demand/supply_ratio × 18) +   // Ratio D/O : jusqu'à 36 pts
  (long_ride_probability × 28) + // Longues courses : jusqu'à 28 pts
  (hourly_rate/70 × 32) +        // Taux horaire : jusqu'à 32 pts
  (surge > 1.3 ? 22 : surge > 1.1 ? 10 : 0) // Surge : jusqu'à 22 pts
))
```

### Heures de pointe par catégorie

| Type de zone | Heures de pointe |
|---|---|
| Aéroports (CDG/Orly) | 4h–11h, 16h–23h (CDG : 24h/7) |
| Gares (RER B/D) | 6h–9h, 17h–20h |
| Business (Plaine Commune, Villepinte) | 7h–10h, 17h–20h |
| Divertissement (Stade de France) | 18h–23h (événement seulement) |
| Résidentiel (Montreuil, Aulnay) | 7h–9h, 17h–19h |

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    FRONTEND (React/Vite)                │
│                                                         │
│  MapPage          SimulatorPage     AlertsPage          │
│  ├─ Leaflet map   ├─ Profit calc    ├─ Alert feed       │
│  ├─ Heatmap       ├─ Bar chart      └─ Strategy tips    │
│  ├─ Zone markers  └─ Scenarios                          │
│  └─ Event pins                                          │
│                                                         │
│  DataSourcesPage  ProfilePage                           │
│  └─ APIs catalog  └─ Driver params                      │
│                                                         │
│  React Query ──────────────────────────────────────     │
│  (TanStack Query v5, refetch 30s–60s)                   │
└────────────────────┬────────────────────────────────────┘
                     │ HTTP (fetch / REST)
                     │ __PORT_5000__ → port/5000 (published)
┌────────────────────▼────────────────────────────────────┐
│                 BACKEND (Express / Node)                │
│                                                         │
│  GET  /api/zones              → All 14 zones            │
│  GET  /api/profitability      → Scores by hour+dayType  │
│  GET  /api/top-zones          → Top N zones ranked      │
│  GET  /api/events             → Active events           │
│  GET  /api/alerts             → Active alerts           │
│  POST /api/alerts/:id/read    → Mark alert read         │
│  POST /api/calculate          → Profit calculation      │
│  GET  /api/rides/stats        → Aggregated ride stats   │
│  GET  /api/rides              → Recent rides history    │
│  GET  /api/driver-profile     → Driver settings         │
│  PUT  /api/driver-profile     → Update settings         │
│  GET  /api/data-sources       → Data sources catalog    │
└────────────────────┬────────────────────────────────────┘
                     │ better-sqlite3
┌────────────────────▼────────────────────────────────────┐
│                   DATABASE (SQLite)                     │
│                                                         │
│  zones (14 rows)                                        │
│  profitability_scores (672 rows = 14×24×2)              │
│  events (6 rows, renouvelés quotidiennement)            │
│  alerts (4 rows, TTL 5–10h)                             │
│  rides (historique courses saisies)                     │
│  driver_profile (1 row, paramètres chauffeur)           │
└─────────────────────────────────────────────────────────┘
```

### Flux de données

```
Démarrage serveur
  └─ seedData() → vérifie COUNT(zones) > 0
       └─ Si vide : insère 14 zones + 672 scores + events + alerts + profil
            └─ Si plein : skip (idempotent)

Requête client /api/top-zones?hour=15&dayType=weekday
  └─ storage.getTopZones(15, 'weekday', 5)
       └─ JOIN profitability_scores + zones → enrichissement
            └─ Renvoie [{...score, zone: {...}}]
```

---

## Stack

### Frontend
| Lib | Version | Usage |
|-----|---------|-------|
| React | 18 | UI framework |
| Vite | 5 | Build & HMR |
| TanStack Query | 5 | Data fetching + cache |
| Wouter | 3 | Hash-based routing (iframe-safe) |
| Leaflet | 1.9.4 | Carte interactive (CDN) |
| Recharts | 2 | Graphiques rentabilité |
| Tailwind CSS | 3 | Styles utilitaires |
| shadcn/ui | latest | Composants UI |
| date-fns | 3 | Formatage dates |
| lucide-react | latest | Icônes |

### Backend
| Lib | Version | Usage |
|-----|---------|-------|
| Express | 4 | Serveur HTTP |
| better-sqlite3 | 9 | ORM-free SQLite sync |
| TypeScript | 5 | Typage full-stack |
| tsup | latest | Bundle server → CJS |

---

## Installation locale

### Prérequis

- Node.js ≥ 20
- npm ≥ 10

### Cloner et installer

```bash
git clone https://github.com/<votre-username>/vtc-intelligence.git
cd vtc-intelligence
npm install
```

### Développement (hot reload)

```bash
npm run dev
# → http://localhost:5000
```

Le serveur Express sert à la fois l'API et le frontend Vite en dev.

### Build de production

```bash
npm run build
# Frontend → dist/public/
# Backend  → dist/index.cjs
```

### Démarrage en production

```bash
NODE_ENV=production node dist/index.cjs
# → http://localhost:5000
```

La base SQLite `data.db` est créée automatiquement au premier démarrage avec le seed complet (14 zones, 672 scores, events, alertes).

### Variables d'environnement

| Variable | Défaut | Description |
|----------|--------|-------------|
| `PORT` | `5000` | Port du serveur Express |
| `NODE_ENV` | `development` | `production` désactive le HMR Vite |

> **Note :** Aucune clé API n'est requise. L'application fonctionne entièrement hors-ligne (données pré-seedées).

### Re-seeder la base de données

```bash
# Supprimer la base existante pour forcer un re-seed
rm data.db
NODE_ENV=production node dist/index.cjs
```

---

## Déploiement

### Sur pplx.app (Perplexity Computer)

```bash
npm run build

# Deploy preview
pplx-tool deploy_website \
  --project_path ./dist/public \
  --site_name "VTC Intelligence"

# Publish permanent
pplx-tool publish_website \
  --project_path . \
  --dist_path ./dist/public \
  --run_command "NODE_ENV=production node dist/index.cjs" \
  --install_command "npm ci --omit=dev" \
  --port 5000 \
  --subdomain "vtc-one"
```

> La BDD `data.db` doit être dans la racine du projet pour la persistance inter-déploiements.

### Sur un VPS / serveur dédié

```bash
npm run build
NODE_ENV=production node dist/index.cjs &

# Ou avec PM2 :
npm install -g pm2
pm2 start "NODE_ENV=production node dist/index.cjs" --name vtc-intelligence
pm2 save
```

### Sur Vercel (frontend uniquement)

> Le backend Express n'est pas compatible avec Vercel Functions tel quel.
> Pour un déploiement Vercel complet, migrer le backend vers des Vercel API Routes
> et SQLite vers Supabase (PostgreSQL).

---

## Structure des fichiers

```
vtc-intelligence/
├── client/
│   ├── index.html               # Entry point HTML
│   └── src/
│       ├── App.tsx              # Router (hash-based)
│       ├── main.tsx             # React entry
│       ├── index.css            # Dark slate + green palette
│       ├── lib/
│       │   ├── queryClient.ts   # TanStack Query + API_BASE sentinel
│       │   └── utils.ts         # cn() utility
│       ├── components/
│       │   ├── Layout.tsx       # Bottom nav, header, alert badge
│       │   ├── ThemeProvider.tsx
│       │   └── ui/              # shadcn/ui components (40+)
│       ├── hooks/
│       │   ├── use-mobile.tsx
│       │   └── use-toast.ts
│       └── pages/
│           ├── MapPage.tsx      # Carte Leaflet + heatmap + événements
│           ├── SimulatorPage.tsx # Simulateur rentabilité + Recharts
│           ├── AlertsPage.tsx   # Feed alertes + stratégies
│           ├── DataSourcesPage.tsx # Catalogue sources de données
│           ├── ProfilePage.tsx  # Paramètres chauffeur
│           └── not-found.tsx
├── server/
│   ├── index.ts                 # Express app entry + Vite middleware
│   ├── routes.ts                # Toutes les routes API REST
│   ├── storage.ts               # SQLite queries + seed data (14 zones 93)
│   ├── static.ts                # Middleware fichiers statiques prod
│   └── vite.ts                  # Dev middleware Vite
├── shared/
│   └── schema.ts                # Types TypeScript partagés (Zone, Alert, Ride…)
├── script/
│   └── build.ts                 # Script build (tsup server + vite client)
├── dist/                        # Build output (gitignored)
│   ├── index.cjs                # Backend bundle
│   └── public/                  # Frontend bundle
│       ├── index.html
│       └── assets/
├── data.db                      # SQLite database (gitignored)
├── package.json
├── vite.config.ts
├── tailwind.config.ts
├── tsconfig.json
├── drizzle.config.ts            # Config Drizzle (schema reference seulement)
├── components.json              # shadcn/ui config
└── README.md
```

---

## API Reference

Toutes les routes sont préfixées `/api`. En production publiée sur pplx.app, le frontend les appelle via `port/5000/api/...`.

### `GET /api/zones`
Retourne les 14 zones Seine-Saint-Denis.

```json
[
  {
    "id": "z_cdg",
    "name": "CDG — Roissy-en-France",
    "lat": 49.0097,
    "lng": 2.5479,
    "type": "airport",
    "city": "Seine-Saint-Denis"
  }
]
```

### `GET /api/profitability?hour=15&dayType=weekday`
Retourne les scores de rentabilité pour une heure et un type de jour donnés.

| Paramètre | Type | Défaut | Description |
|-----------|------|--------|-------------|
| `hour` | int 0–23 | heure actuelle | Heure UTC |
| `dayType` | `weekday`\|`weekend` | auto | Type de jour |

```json
[
  {
    "zone_id": "z_cdg",
    "hour": 15,
    "day_type": "weekday",
    "demand_score": 85.3,
    "supply_score": 48.2,
    "ratio_ds": 1.77,
    "avg_distance_km": 39.4,
    "avg_duration_min": 65.7,
    "avg_fare": 51.75,
    "profitability_index": 87.1,
    "long_ride_probability": 0.92,
    "surge_multiplier": 1.3
  }
]
```

### `GET /api/top-zones?hour=15&dayType=weekday&limit=5`
Top N zones par score de rentabilité, enrichies avec les données de zone.

### `GET /api/events`
Événements actifs (non expirés), enrichis avec les coordonnées de zone.

### `GET /api/alerts`
Alertes actives triées par priorité (`critical` > `high` > `medium` > `low`).

### `POST /api/alerts/:id/read`
Marque une alerte comme lue.

### `POST /api/calculate`
Calcule la rentabilité d'une course.

**Body :**
```json
{
  "distanceKm": 38,
  "durationMin": 42,
  "fare": 55.0
}
```

**Response :**
```json
{
  "distanceKm": 38,
  "durationMin": 42,
  "fare": 55.0,
  "commission": 13.75,
  "fuelCost": 5.47,
  "wearCost": 3.04,
  "netProfit": 32.74,
  "hourlyRate": 46.77,
  "isProfitable": true,
  "profitabilityScore": 94,
  "thresholdFare": 38,
  "thresholdDuration": 38
}
```

### `GET /api/rides/stats`
Statistiques agrégées sur les courses enregistrées.

### `GET /api/rides`
20 dernières courses enregistrées.

### `GET /api/driver-profile`
Paramètres du profil chauffeur.

### `PUT /api/driver-profile`
Met à jour le profil chauffeur (upsert).

### `GET /api/data-sources`
Catalogue des sources de données disponibles par catégorie.

---

## Schéma SQLite

```sql
-- Zones géographiques
CREATE TABLE zones (
  id    TEXT PRIMARY KEY,  -- ex: 'z_cdg'
  name  TEXT NOT NULL,
  lat   REAL NOT NULL,
  lng   REAL NOT NULL,
  type  TEXT NOT NULL,     -- 'airport'|'transport'|'business'|'entertainment'|'residential'
  city  TEXT NOT NULL DEFAULT 'Seine-Saint-Denis'
);

-- Scores de rentabilité pré-calculés (14 zones × 24h × 2 dayTypes = 672 lignes)
CREATE TABLE profitability_scores (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  zone_id               TEXT NOT NULL,
  hour                  INTEGER NOT NULL,    -- 0–23
  day_type              TEXT NOT NULL,       -- 'weekday'|'weekend'
  demand_score          REAL NOT NULL,       -- 0–100
  supply_score          REAL NOT NULL,       -- 0–100
  ratio_ds              REAL NOT NULL,       -- demand/supply
  avg_distance_km       REAL NOT NULL,
  avg_duration_min      REAL NOT NULL,
  avg_fare              REAL NOT NULL,
  profitability_index   REAL NOT NULL,       -- 0–100
  long_ride_probability REAL NOT NULL,       -- 0.0–1.0
  surge_multiplier      REAL NOT NULL DEFAULT 1.0
);

-- Événements (concerts, matchs, salons, flux aéroports)
CREATE TABLE events (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  name                TEXT NOT NULL,
  zone_id             TEXT NOT NULL,
  event_type          TEXT NOT NULL,  -- 'match'|'concert'|'conference'|'transport'|'entertainment'
  start_time          TEXT NOT NULL,  -- ISO 8601
  end_time            TEXT NOT NULL,  -- ISO 8601
  expected_attendance INTEGER,
  demand_boost        REAL NOT NULL DEFAULT 1.0,
  is_active           INTEGER NOT NULL DEFAULT 1
);

-- Alertes opportunités temps réel
CREATE TABLE alerts (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  type              TEXT NOT NULL,   -- 'demand_spike'|'event_ending'|'long_ride_opportunity'|...
  title             TEXT NOT NULL,
  message           TEXT NOT NULL,
  zone_id           TEXT,
  priority          TEXT NOT NULL,   -- 'critical'|'high'|'medium'|'low'
  estimated_revenue REAL,
  expires_at        TEXT NOT NULL,   -- ISO 8601
  created_at        TEXT NOT NULL,   -- ISO 8601
  is_read           INTEGER NOT NULL DEFAULT 0
);

-- Historique des courses saisies
CREATE TABLE rides (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  pickup_zone_id   TEXT NOT NULL,
  dropoff_zone_id  TEXT NOT NULL,
  distance_km      REAL NOT NULL,
  duration_min     REAL NOT NULL,
  fare             REAL NOT NULL,
  commission       REAL NOT NULL,
  fuel_cost        REAL NOT NULL,
  net_profit       REAL NOT NULL,
  hourly_rate      REAL NOT NULL,
  is_profitable    INTEGER NOT NULL,  -- 0|1
  is_long_ride     INTEGER NOT NULL,  -- 0|1
  timestamp        TEXT NOT NULL,
  weather          TEXT
);

-- Profil du chauffeur (1 seule ligne)
CREATE TABLE driver_profile (
  id                          INTEGER PRIMARY KEY AUTOINCREMENT,
  fuel_consumption_per100km   REAL NOT NULL DEFAULT 7.5,
  fuel_price_per_liter        REAL NOT NULL DEFAULT 1.92,
  platform_commission_pct     REAL NOT NULL DEFAULT 25.0,
  hourly_target_income        REAL NOT NULL DEFAULT 35.0,
  wear_cost_per_km            REAL NOT NULL DEFAULT 0.08,
  min_profitable_km_per_min   REAL NOT NULL DEFAULT 1.0,
  vehicle_type                TEXT NOT NULL DEFAULT 'berline',
  prefer_long_rides           INTEGER NOT NULL DEFAULT 1
);
```

---

## Licence

MIT — Libre d'utilisation, modification et redistribution.

---

## Logique de priorisation des alertes

### Architecture (depuis v2.0 — juin 2026)

Les alertes ne sont plus hardcodées mais **générées dynamiquement** toutes les 3 minutes
depuis les scores de rentabilité temps réel (`profitability_scores`).

#### Règles de déclenchement (ordre de priorité)

| Règle | Condition | Priorité | TTL |
|-------|-----------|----------|-----|
| Surge trafic | ratio D/O > 4.5 | critical | 2h |
| Surge trafic | ratio D/O 3.5–4.5 | high | 4h |
| Surge trafic | ratio D/O 3.0–3.5 | medium | 4h |
| Événement actif | demand_boost ≥ 3.0 | critical | jusqu'à fin event |
| Événement actif | demand_boost ≥ 2.0 | high | jusqu'à fin event |
| Aéroport (CDG/Orly) | profitability_index > 85 | high | 3h |
| Aéroport (CDG/Orly) | profitability_index > 70 | medium | 3h |
| Zone saturée | ratio D/O < 0.8 ET demand < 30 | low | 1h |

#### Tri dans la liste (getActiveAlerts)

1. Non lues en premier (`is_read ASC`)
2. Priorité statique (critical → high → medium → low)
3. **Densité trafic temps réel** (`ratio_ds DESC`) — nouveau critère principal
4. Date de création (`created_at DESC`)

#### Pour ajustements UI futurs

- Champ `traffic_density` (ratio D/O) disponible dans chaque alerte retournée
- Champ `current_demand` (score 0-100) disponible
- Champ `current_surge` (multiplicateur surge) disponible
- Seuil `ratio_ds > 3.0` = déclenchement alerte (configurable dans `generateDynamicAlerts`)
- Max 8 alertes actives simultanées (configurable)
- TTL par règle ajustable dans les constantes `ttlH`

#### Endpoint de rafraîchissement

`POST /api/alerts/refresh` force la régénération immédiate des alertes dynamiques et
renvoie `{ success, count, alerts }`.

#### Zones ciblées (Seine-Saint-Denis)

Toutes les 14 zones sont dans le département 93 ou aéroports franciliens :
CDG, Orly, Le Bourget, Villepinte, Tremblay, Aulnay, Saint-Denis Gare,
Plaine Commune, Bobigny, Aubervilliers, Épinay-Gennevilliers, 93 Centre, Montreuil, Stade de France

---

## Auteur

Développé avec [Perplexity Computer](https://www.perplexity.ai/computer) · Déployé sur [vtc-one.pplx.app](https://vtc-one.pplx.app)
