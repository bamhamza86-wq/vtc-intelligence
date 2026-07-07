# Rapport — Implémentation COUCHE VÉHICULE

**Statut : ✅ TERMINÉ — `npm run build` réussi, aucun commit/déploiement effectué.**

## Fichiers créés

1. **`server/vehicleEngine.ts`** (776 lignes) — moteur complet :
   - Connexion SQLite dédiée (`better-sqlite3`, fichier `data.db`), suivant le pattern de `fatigueCoach.ts` (connexion séparée en mode WAL) plutôt que l'export `sqlite` de `storage.ts`. Choix délibéré de cohérence avec l'architecture existante des moteurs autonomes.
   - Tables créées : `fuel_stations_idf` (34 stations IDF pré-seedées : TotalEnergies, Intermarché, Leclerc, Auchan, Carrefour, BP, Shell, Esso, Avia sur Paris, Nanterre, Villejuif, Vélizy, Rosny, Gennevilliers, Boulogne, Ivry, La Défense, Aubervilliers, Bondy, Montreuil, Créteil, Saint-Denis, Vitry, Colombes, Argenteuil, Noisy-le-Grand, Orly, Roissy, Massy, Bobigny, Cergy, Melun, Évry, SQY, Versailles, Antony, Clichy, Pantin), `maintenance_reminders` (pré-seed vidange 15 000 km, pneus 30 000 km, freins 40 000 km, révision annuelle, CT 4 ans), `fuel_log`, `eco_driving_log`, `vehicle_profile`.
   - Réutilise `getNearbyStationsFallback()` et le type `ChargingStation` de `chargingStationsIDF.ts` existant (non modifié).
   - Réutilise `computeMicrosleepRisk()` de `fatigueCoach.ts` pour corréler temps de charge EV et pause légale.
   - Constantes tarifaires EV : borne rapide 0,25 €/kWh, borne lente 0,15 €/kWh, domicile 0,18 €/kWh, réduction entretien EV -40 %.

2. **`client/src/pages/VehiculePage.tsx`** (521 lignes) — 7 sections, UI française mobile-first :
   - Score éco-conduite du jour (jauge circulaire SVG)
   - Stations carburant proches (filtres E10/Gazole/GNV)
   - Recharge EV / Pauses (affichage 3 paliers)
   - Entretien à venir (bouton "marquer comme fait")
   - LOA/LLD tracker (barre de progression + alerte dépassement km)
   - Consommation moyenne (graphique en barres CSS pur, aucune librairie de chart)
   - EV vs Thermique (cartes comparatives)
   - Aucune nouvelle dépendance npm ; icônes lucide-react (Car, Fuel, Zap, Wrench, Gauge, TrendingDown, MapPin, Battery, Coffee, AlertTriangle, CheckCircle2, Calendar, Droplet).

## Fichiers modifiés (additifs uniquement)

- **`server/routes.ts`** : import `vehicleEngine`, section "COUCHE VÉHICULE" ajoutée (~lignes 5004-5226), toutes les routes protégées par `requireAuth`.
- **`client/src/App.tsx`** : import `VehiculePage` + route `<Route path="/vehicule" component={VehiculePage} />`.
- **`client/src/components/Layout.tsx`** : icône `Car` ajoutée aux imports lucide-react + entrée `{ path: "/vehicule", label: "Véhicule", icon: Car }` dans le menu de navigation.

## Choix d'architecture notables

- **Réutilisation via délégation** : `loa_contract` et le comparateur de financement existaient déjà dans `server/fiscalProactif.ts` (`computeLoaKmTracker()`, `upsertLoaContract()`, `compareVehicleFinance()`). Conformément à la contrainte « ne rien casser de l'existant », les endpoints `/api/vehicle/loa-tracker` et `/api/vehicle/finance-comparator` délèguent à ces fonctions existantes plutôt que de dupliquer les tables. Les tables réellement nouvelles (`fuel_stations_idf`, `maintenance_reminders`, `fuel_log`, `eco_driving_log`, `vehicle_profile`) couvrent les leviers non traités auparavant.
- **`vehicle_maintenance`** (table pré-existante dans `storage.ts`) n'a pas été touchée ; `maintenance_reminders` est une table distincte pour les nouveaux rappels génériques par kilométrage/date.

## Endpoints créés (18 au total, tous sous `requireAuth`)

| # | Méthode | Route | Description |
|---|---------|-------|-------------|
| 1 | POST | `/api/vehicle/eco-score/log` | Log d'un datapoint éco-conduite (freinages/accélérations brusques, vitesse moy., km) |
| 2 | GET | `/api/vehicle/eco-score` | Score éco-conduite du jour /100 + détail + conseils |
| 3 | GET | `/api/vehicle/cheap-fuel?lat=&lng=&type=E10&radiusKm=` | Stations carburant les moins chères, triées |
| 4 | GET | `/api/vehicle/charging-strategy?lat=&lng=` | Stratégie de recharge EV à 3 paliers |
| 5 | GET | `/api/vehicle/charge-as-break?lat=&lng=` | Corrèle temps de charge et recommandation de pause (fatigue) |
| 6 | POST/GET | `/api/vehicle/ev-vs-thermal` | Comparaison coût réel EV vs thermique |
| 7 | GET | `/api/vehicle/maintenance-reminders` | Liste des rappels d'entretien triés par urgence |
| 8 | POST | `/api/vehicle/maintenance-reminders/progress` | Met à jour le statut des rappels selon le km actuel |
| 9 | PUT | `/api/vehicle/maintenance-reminders/:id/done` | Marque un entretien comme fait, replanifie |
| 10 | GET | `/api/vehicle/loa-tracker` | Suivi km LOA/LLD (délègue à `fiscalProactif`) |
| 11 | POST | `/api/vehicle/loa-tracker` | Crée/met à jour un contrat LOA/LLD |
| 12 | POST | `/api/vehicle/finance-comparator` | Comparateur LOA vs LLD vs achat |
| 13 | GET | `/api/vehicle/fuel-log?limit=30` | Stats de consommation (L/100km, kWh/100km, coût moyen) |
| 14 | POST | `/api/vehicle/fuel-log` | Ajoute une entrée de plein/charge |
| 15 | GET | `/api/vehicle/refuel-decision?lat=&lng=&type=&reservoir_pct=` | Décision « faire le plein maintenant ou attendre » |
| 16 | GET | `/api/vehicle/profitability-check?courses_par_jour=&km_par_jour=` | Détecteur véhicule non rentable |
| 17 | GET | `/api/vehicle/profile` | Récupère le profil véhicule |
| 18 | PUT | `/api/vehicle/profile` | Met à jour le profil véhicule |

## Vérification build

```
npm run build
> building client... ✓ 2735 modules transformed, built in 8.35s
> building server... dist/index.cjs 980.5kb, Done in 68ms
```
Aucune erreur. Seuls avertissements pré-existants et non liés (taille de chunk >500kB, import dynamique/statique de `voice.ts`).

`npx tsc --noEmit | grep -i vehicle` → **aucun résultat** (0 erreur liée au véhicule). 162 erreurs pré-existantes ailleurs dans le code (routes.ts lignes 1015-4182, FlightData/SncfStats) sont sans rapport avec cette tâche.

## Contraintes respectées

- ✅ SQLite (connexion `better-sqlite3` dédiée, pattern `fatigueCoach.ts`)
- ✅ `requireAuth` sur toutes les routes
- ✅ Réutilisation de `chargingStationsIDF.ts` existant (non modifié)
- ✅ UI française, mobile-first
- ✅ Aucune nouvelle dépendance npm
- ✅ Icônes lucide-react demandées (Car, Fuel, Zap, Wrench, Gauge, TrendingDown) + complémentaires
- ✅ Aucun commit ni déploiement effectué (`git log -1` inchangé : `8e68165`)
