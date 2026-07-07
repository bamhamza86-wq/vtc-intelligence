# Rapport — Couche Onboarding Nouveau Chauffeur + Juridique

Statut : **TERMINÉ**. `npm run build` = **OK** (client + server compilés sans erreur TypeScript).
Aucun commit, aucun déploiement effectué (conformément à la consigne).

## Fichiers créés

1. `server/onboardingEngine.ts` (626 lignes)
2. `server/legalEngine.ts` (742 lignes)
3. `client/src/pages/OnboardingPage.tsx` (598 lignes)
4. `client/src/pages/LegalPage.tsx` (674 lignes)

## Fichiers modifiés

- `server/routes.ts` : imports `onboardingEngine` / `legalEngine` + bloc de 12 routes (init des moteurs + tables SQLite via `sqlite.exec`).
- `client/src/App.tsx` : imports `OnboardingPage`/`LegalPage` + routes `/onboarding` et `/legal` dans le `<Switch>`.
- `client/src/components/Layout.tsx` : icônes `Rocket`/`Scale` ajoutées à l'import lucide-react + 2 entrées dans `moreMenuItems` (Onboarding, Juridique).

## Endpoints créés (tous protégés par `requireAuth`)

### Onboarding
- `POST /api/onboarding/installation-simulator` — simulateur d'installation (coûts, seuil de rentabilité)
- `POST /api/onboarding/business-plan` — génération business plan (HTML)
- `GET /api/onboarding/checklist` / `PATCH /api/onboarding/checklist/:itemKey` — checklist administrative (18 items : identité, juridique, assurance, véhicule, formation, financier)
- `POST /api/onboarding/status-guide` — recommandation statut fiscal (micro-BIC / micro-BNC / EI au réel / SASU)
- `GET /api/onboarding/journey` / `PATCH /api/onboarding/journey/:day` — parcours guidé 30 jours

### Juridique
- `GET /api/legal/faq` / `POST /api/legal/faq` — FAQ contextuelle (15 questions : maraude, réservation préalable, carte T3P, cumul emploi, Uber Files, jurisprudence Cass. 2020, etc.)
- `GET /api/legal/contract-template` / `POST /api/legal/contract-template` — générateur de contrats (4 modèles : mission mariage, contrat-cadre entreprise, CGV clientèle privée, décharge de responsabilité)
- `GET /api/legal/rules` — base réglementaire 2026 (24 règles : T3P, ADS taxi vs VTC, réservation préalable, tarif horokilométrique, LOTI, plaques, etc.)
- `GET /api/legal/dispute-templates` / `POST /api/legal/dispute-templates` — modèles de litiges (5 templates : paiement manquant, désactivation de compte, note injustifiée, RGPD accès données, requalification salariale)
- `GET /api/legal/disputes` / `POST /api/legal/disputes` / `PATCH /api/legal/disputes/:id` — suivi des litiges (journal SQLite)
- `GET /api/legal/formation-continue` — statut formation continue (obligation quinquennale, 5 organismes agréés IDF)
- `POST /api/legal/retirement-cipav-simulator` — simulateur retraite CIPAV

## Pages front-end

- **`/onboarding`** (icône Rocket) : Simulateur d'installation, Business plan (aperçu iframe + téléchargement), Checklist admin, Guide statut fiscal, Parcours 30 jours.
- **`/legal`** (icône Scale) : FAQ contextuelle, Générateur de contrats (avec copie), Base réglementaire (filtrable par catégorie), Suivi des litiges, Formation continue, Simulateur retraite CIPAV.

## Contraintes respectées

- SQLite via `sqlite.exec(...)` (pattern existant `storage.ts`), tables : `onboarding_checklist_status`, `onboarding_journey`, `business_plans`, `legal_rules_2026`, `disputes_log`.
- `requireAuth` sur toutes les routes.
- UI 100% française.
- Aucune nouvelle dépendance npm.
- Icônes lucide-react utilisées : Rocket, Scale, FileText, CheckCircle, GraduationCap (+ autres déjà disponibles dans la librairie).

## Vérification build

```
npm run build
✓ 2741 modules transformed (client, vite)
✓ built in 8.46s
building server...
dist/index.cjs 1.1mb
⚡ Done in 84ms
```

Aucune erreur TypeScript. Seuls avertissements pré-existants (taille de chunk, import dynamique/statique mixte sur `voice.ts`) sans lien avec le nouveau code.
