# Couche CRM Chauffeur — Rapport d'implémentation

Contexte : `/home/user/workspace/vtc_rentabilite/CONTEXTE_IMPL.md` + rapport.md §7, §14, §17.

## Fichiers créés / modifiés

- **Créé** `server/crmEngine.ts` (898 lignes) — moteur complet : tables SQLite, seed data, toutes les fonctions métier.
- **Modifié** `server/routes.ts` — ajout de l'import `crmEngine` + 30 endpoints `/api/crm/*` en fin de `registerRoutes`.
- **Créé** `client/src/pages/CrmPage.tsx` (1018 lignes) — page avec 6 onglets (Clients, Récurrentes, Factures, Partenariats, Bourse d'échanges, Templates réponses auto).
- **Modifié** `client/src/App.tsx` — ajout de la route `/crm` + import `CrmPage`.
- **Modifié** `client/src/components/Layout.tsx` — ajout de l'entrée « CRM » (icône `Users`) dans le menu « Plus ».

## Tables SQLite créées (dans `data.db`, via `better-sqlite3`)

| Table | Rôle |
|---|---|
| `private_clients` | Carnet clientèle privée (nom, tel, email, notes, tags JSON, vip, created_at, last_ride_at) — §7.1 |
| `private_rides` | Historique des courses privées par client (montant, distance, pourboire, note) — §7.1 |
| `client_blacklist` | Liste noire personnelle (plate_or_id, motif, date) — §7.2 |
| `recurring_rides` | Courses récurrentes (jour_semaine, heure, depart/arrivee, montant, next_occurrence, active) — §7.5 |
| `partnerships` | Partenariats hôtels/restos/salles (type, address, contact, commission_pct, active) — §7.6 |
| `private_invoices` | Facturation privée (ride_ids JSON, montant_ht/tva/ttc, statut, paid_at) — §7.7 |
| `ride_exchange` | Bourse d'échange de courses communautaire, démo avec seed (from_user, from_ride, to_zone, price, status) — §14.1 |
| `auto_reply_templates` | Templates réponses auto SMS/WhatsApp (trigger_type, message, active) — §17.1 |

Toutes les tables sont créées en `CREATE TABLE IF NOT EXISTS`, additivement, sans toucher aux tables existantes.

## Seed data (idempotent via `seed_meta`)

- **5 clients démo** : Mme Chantal Dubreuil (VIP), M. Karim Belhadj (VIP), Mme Aïcha Ndiaye, M. Thomas Lefèvre (VIP), Mme Julie Moreau — avec 8 courses privées historiques associées (CA total 320€, pourboires 32€).
- **2 partenariats démo** : Hôtel Le Meurice (10% commission), Restaurant Le Chalet des Îles (5% commission).
- **5 templates SMS FR** pré-remplis (exactement ceux demandés) :
  1. "Je conduis actuellement, je vous rappelle dès que je peux." (en_conduite)
  2. "Je suis en course. Réservation pour quelle date/heure ?" (en_course)
  3. "Bonjour, je peux vous prendre en charge à [ADRESSE] à [HEURE]. Confirmez-vous ?" (disponible)
  4. "Ma course est terminée dans ~15 min. Vous êtes toujours dispo ?" (fin_course)
  5. "Merci pour votre confiance ! Prochaine course quand vous voulez." (remerciement)
- **4 offres bourse d'échange démo** (courses proposées par `antoine` / `vtc-one`).

## Endpoints créés (30 routes, toutes protégées par `requireAuth`)

### 7.1 Clients (CRUD)
- `GET /api/crm/clients?search=` — liste + recherche
- `GET /api/crm/clients/:id` — détail + historique (rides, récurrentes, factures)
- `POST /api/crm/clients` — création
- `PUT /api/crm/clients/:id` — mise à jour
- `DELETE /api/crm/clients/:id` — suppression (cascade sur rides/récurrentes/factures)

### 7.1 Courses privées
- `GET /api/crm/rides?client_id=` — liste (par client ou globale)
- `POST /api/crm/rides` — ajout d'une course
- `DELETE /api/crm/rides/:id` — suppression

### 7.2 Blacklist personnelle
- `GET /api/crm/blacklist` — liste
- `POST /api/crm/blacklist` — ajout (plate_or_id, motif)
- `DELETE /api/crm/blacklist/:id` — suppression

### 7.3 Notation client
- `GET /api/crm/rating-lookup?ref=` — croise blacklist + carnet privé (honnête : aucune API tierce n'expose la note passager en 2026, signal basé sur données locales uniquement)

### 7.4 VIP / pourboires
- `GET /api/crm/vip-analytics` — top clients par CA et par pourboires + résumé global

### 7.5 Courses récurrentes
- `GET /api/crm/recurring` — liste avec `next_occurrence` calculée
- `POST /api/crm/recurring` — création
- `PUT /api/crm/recurring/:id` — mise à jour (recalcule next_occurrence si jour/heure changent)
- `DELETE /api/crm/recurring/:id` — suppression

### 7.6 Partenariats
- `GET /api/crm/partnerships` — liste
- `POST /api/crm/partnerships` — création
- `PUT /api/crm/partnerships/:id` — mise à jour
- `DELETE /api/crm/partnerships/:id` — suppression

### 7.7 Facturation privée
- `GET /api/crm/invoices` — liste
- `GET /api/crm/invoices/:id` — détail avec courses liées
- `POST /api/crm/invoices` — génération depuis un client + liste de `ride_ids`
- `PUT /api/crm/invoices/:id/statut` — changement de statut (brouillon/envoyee/payee/en_retard)
- `DELETE /api/crm/invoices/:id` — suppression

### 17.3 Génération PDF facture
- `GET /api/crm/invoice-pdf/:id` — retourne du HTML formaté (impression via `window.print()` côté client, déclenché depuis `CrmPage.tsx`)

### 17.4 Relances impayés
- `GET /api/crm/invoice-reminders` — factures groupées par ancienneté J+7 / J+15 / J+30 / à jour + total impayé

### 14.1 Bourse d'échange de courses
- `GET /api/crm/ride-exchange` — liste des offres
- `POST /api/crm/ride-exchange` — publication d'une offre
- `PUT /api/crm/ride-exchange/:id` — changement de statut (ouverte/reservee/terminee/annulee)
- `DELETE /api/crm/ride-exchange/:id` — suppression

### 17.1 Templates réponses auto
- `GET /api/crm/auto-reply-templates` — liste
- `POST /api/crm/auto-reply-templates` — création
- `PUT /api/crm/auto-reply-templates/:id` — mise à jour
- `DELETE /api/crm/auto-reply-templates/:id` — suppression

## Frontend

`client/src/pages/CrmPage.tsx` — page mobile-first (tap targets ≥ 44px), UI 100% française, icônes `lucide-react` (`Users`, `Repeat`, `FileText`, `Handshake`, `Send`, `MessageSquare`), 6 onglets scrollables horizontalement :

1. **Clients** — recherche, bouton +Nouveau, cartes cliquables ouvrant un modal de détail avec historique de courses + ajout de course + suppression.
2. **Récurrentes** — liste avec jour/heure/next_occurrence, activation/désactivation, création via modal.
3. **Factures** — bandeau de relances impayés (J+7/15/30), liste avec statut coloré, bouton imprimer (ouvre le HTML retourné par `/api/crm/invoice-pdf/:id` dans un nouvel onglet + déclenche `window.print()`), création par sélection de courses.
4. **Partenariats** — cartes hôtels/restos/salles avec commission%, création via modal.
5. **Bourse d'échanges** — mode démo explicite affiché à l'utilisateur, liste des offres avec statut, réservation en un tap.
6. **Templates réponses auto** — 5 templates seedés, copier/coller rapide, activation/désactivation, suppression.

Route `/crm` ajoutée dans `App.tsx`, lien « CRM » ajouté dans le menu « Plus » de `Layout.tsx` (icône `Users`).

## Vérifications effectuées

- **`npm run build`** : ✅ succès (client Vite + serveur esbuild → `dist/index.cjs` 824.3kb).
- **Démarrage serveur** : ✅ aucune erreur, tables créées, seed exécuté une seule fois (idempotent).
- **Tests endpoints en live** (curl avec token JWT) : ✅ `clients`, `vip-analytics`, `rating-lookup` (cas carnet privé + cas blacklist), `partnerships`, `auto-reply-templates`, `ride-exchange`, `invoice-reminders`, `recurring`, création de facture + génération HTML imprimable, ajout blacklist, création récurrente — tous fonctionnels.
- **Contrainte "zéro nouvelle dépendance npm"** : respectée (uniquement `better-sqlite3`, déjà présent).
- **`requireAuth`** : appliqué sur les 30 routes.
- Données de test créées pendant la vérification (facture/blacklist/récurrente de test) nettoyées après contrôle ; seed data d'origine (5 clients, 2 partenariats, 5 templates, 4 offres bourse) intact.

## Notes

- Deux erreurs TypeScript préexistantes dans `App.tsx` (imports dupliqués `MLInsightsPage`/`FatiguePage`) ont été détectées via `tsc --noEmit` mais **ne sont pas liées à cette implémentation** — elles existaient déjà dans le fichier avant toute modification CRM et n'empêchent pas `npm run build` de réussir (esbuild/vite ne font pas de vérification de types stricte en doublon d'identifiants ES module au même niveau que `tsc`).
- Une erreur de typage introduite dans `crmEngine.ts` (`checkBlacklist`) a été corrigée avec un cast explicite.
- Aucun commit ni déploiement effectué, conformément à la consigne.
