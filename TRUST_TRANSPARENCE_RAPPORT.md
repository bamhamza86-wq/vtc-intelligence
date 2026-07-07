# Rapport — Couche Trust & Transparence

Implémentation additive dans `/home/user/workspace/vtc-intelligence/`, conformément au contexte `/home/user/workspace/vtc_rentabilite/CONTEXTE_IMPL.md`.

Inspiré des gaps benchmark : **Para** (révélation pourboire, flags client), **Mystro** (historique offres même refusées), **Everlance** (garantie audit fiscal), **Stride** (marketplace assurance / transparence commissions).

## Fichiers créés/modifiés

- **Créé** `server/trustEngine.ts` — moteur métier, connexion SQLite dédiée (`better-sqlite3`, pattern `fatigueCoach.ts`)
- **Modifié** `server/routes.ts` — import du moteur + 21 endpoints `/api/trust/*` (tous `requireAuth`), insérés avant le catch-all frontend
- **Créé** `client/src/pages/TrustPage.tsx` — nouvelle page avec 8 sections
- **Modifié** `client/src/App.tsx` — route `/trust` ajoutée
- **Modifié** `client/src/components/Layout.tsx` — entrée "Trust" (icône `ShieldCheck`) dans `moreMenuItems`

Aucune dépendance npm ajoutée. Aucun fichier existant supprimé ni de logique cassée (additive only).

## Tables SQLite créées (dans `data.db`, via `CREATE TABLE IF NOT EXISTS`)

| Table | Rôle |
|---|---|
| `client_flags` | Flags positifs/négatifs sur clients (tag: ponctuel, pourboire, agressif, malpoli, généreux, prof) |
| `location_flags` | Tags de lieu (hotspot, safe, dangereux, zone_morte, contrôle_police) avec votes |
| `offers_history` | Historique complet des offres (acceptées, refusées, expirées) |
| `incidents_log` | Journal d'incidents (agression, arnaque, impayé, dispute, autre) |
| `geo_proofs` | Preuves géolocalisées horodatées et signées pour litiges |
| `tip_observations` | Observations historiques de pourboires (alimente la prévision statistique) |

## Endpoints créés (tous `requireAuth`)

### 1. Prévision pourboire (Para)
- `POST /api/trust/tip-forecast` — {zone_pickup, zone_dropoff, hour, day, fare} → pourboire probable €/%
- `POST /api/trust/tip-observation` — enregistre une observation réelle pour affiner le modèle

### 2. Flags client
- `GET /api/trust/flags`
- `POST /api/trust/flags`
- `PUT /api/trust/flags/:id`
- `DELETE /api/trust/flags/:id`

### 3. Tags de lieu
- `GET /api/trust/locations`
- `POST /api/trust/locations`
- `POST /api/trust/locations/:id/vote`
- `DELETE /api/trust/locations/:id`

### 4. Historique offres complet (Mystro)
- `GET /api/trust/all-offers?status=&limit=` — stats + analyse "meilleures offres"
- `POST /api/trust/all-offers` — enregistrement d'une nouvelle offre reçue

### 5. Garantie audit fiscal (Everlance)
- `GET /api/trust/audit-shield` — score de conformité, inventaire des justificatifs, actions recommandées

### 6. Vérification passager instantanée
- `GET /api/trust/passenger-lookup?phone=` — croise les flags historiques

### 7. Comparateur commissions plateformes (Stride)
- `GET /api/trust/commission-comparator?hour=` — tableau Uber/Bolt/Heetch/FreeNow par créneau

### 8. Journal d'incidents
- `GET /api/trust/incidents`
- `POST /api/trust/incidents`
- `PUT /api/trust/incidents/:id`
- `DELETE /api/trust/incidents/:id`

### 9. Preuve géolocalisée
- `POST /api/trust/geo-proof` — snapshot position + timestamp signé
- `GET /api/trust/geo-proof?limit=` — historique des preuves

## Page frontend — `client/src/pages/TrustPage.tsx`

Route `/trust`, accessible via le menu "Plus" (Layout.tsx) avec l'icône `ShieldCheck`. Sections (mobile-first, tap targets ≥ 44px, UI 100% française) :

1. **Prévision pourboire** — formulaire (zone pickup/dropoff, heure, jour, prix) → estimation €/% + niveau de confiance
2. **Clients flaggés** — liste éditable rouge (négatif) / vert (positif), recherche instantanée par téléphone (vérification passager)
3. **Zones flaggées** — mini-carte simplifiée (pastilles positionnées, sans dépendance carto) + liste avec vote et suppression
4. **Historique offres complet** — stats (total/acceptées/refusées/expirées), filtres, tableau détaillé
5. **Bouclier fiscal** — score de conformité (%), statut (protégé/vigilance/risque), checklist justificatifs, actions recommandées
6. **Comparateur commissions** — tableau live Uber/Bolt/Heetch/FreeNow selon créneau horaire
7. **Journal d'incidents** — liste avec bouton "+Nouveau", marquage résolu/non résolu
8. **Preuve géolocalisée** — capture GPS + signature horodatée pour litige

## Seed data (vérifié en base après build)

- 3 flags clients démo : 2 positifs (généreux, ponctuel), 1 négatif (agressif) — confirmé `client_flags` = 3 lignes
- 4 zones flaggées démo : 2 hotspots (Gare du Nord, CDG T2E), 1 dangereux (Porte de la Chapelle), 1 zone morte (Rungis nuit) — confirmé `location_flags` = 4 lignes
- 5 incidents historiques mixtes (impayé, dispute, agression, arnaque, autre) — confirmé `incidents_log` = 5 lignes
- 20 offres historiques factices : 10 acceptées, 8 refusées, 2 expirées — confirmé `offers_history` = 20 lignes
- Seed idempotent (ne se relance pas si déjà présent), déclenché automatiquement au démarrage du serveur

## Vérification build

```
npm run build
✓ 2738 modules transformed.
✓ built in 8.37s
building server...
dist/index.cjs  1012.4kb
⚡ Done in 66ms
```

Build **OK**, aucune erreur TypeScript ni Vite bloquante (warnings préexistants sur la taille des chunks, non liés à cette implémentation).

## Tests fonctionnels effectués

Serveur démarré localement, authentification via `root`/`12345678`, tous les endpoints testés avec token valide :
- `POST /api/trust/tip-forecast` → réponse cohérente avec confiance calculée sur échantillon
- `GET /api/trust/flags`, `/api/trust/locations`, `/api/trust/all-offers`, `/api/trust/incidents` → données seed retournées
- `GET /api/trust/audit-shield` → score 20% (risque), car aucune donnée dans les tables fiscales existantes du repo (comportement attendu, pas de faux positif)
- `GET /api/trust/passenger-lookup?phone=...` → verdict positif basé sur flag existant
- `GET /api/trust/commission-comparator` → tableau des 4 plateformes
- `POST /api/trust/geo-proof` → signature générée avec succès
- Accès sans token → `401` confirmé sur toutes les routes `/api/trust/*`

## Non fait (hors périmètre demandé)

- Aucun commit ni déploiement effectué, conformément à la contrainte.
