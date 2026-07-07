# Rapport — Couche Coach IA Économique + Gamification

Implémentation complète dans `/home/user/workspace/vtc-intelligence/`, conformément au contexte `/home/user/workspace/vtc_rentabilite/CONTEXTE_IMPL.md` et aux sections rapport §10, §13, §15, §20, §21.

## Fichiers créés

| Fichier | Rôle |
|---|---|
| `server/healthMetrics.ts` | KPI business (€/h net, €/km, taux accept/annulation, ratio productif/mort, tendances 7j/30j/90j), peer comparison k-anon, score composite /100, courbe d'apprentissage, export RGPD (CSV/JSON) |
| `server/coachEngine.ts` | Brief matin/soir (texte à synthétiser), réponses vocales rapides ("combien j'ai fait", "où aller", "prochain gros"), coach conversationnel étendu (économie + fiscalité) |
| `server/gamifEcon.ts` | Table `weekly_challenges`, génération de défis automatiques, leaderboard économique k-anon, progression d'objectif (jour/semaine/mois) avec projection |
| `server/notificationRules.ts` | Table `notification_prefs`, règle de délivrance adaptative (jamais en conduite, seuil 20 km/h), digest de notifications, préférences par catégorie |

## Fichiers modifiés

- `server/wowEngine.ts` — 4 nouveaux achievements financiers (`first_2000`, `breakeven_10j`, `big_rides_10`, `streak_7j`) + fonction `checkEconAchievements()`.
- `server/voiceCommands.ts` — délégation des intents "combien j'ai fait" / "où aller" vers `coachEngine.answerQuickVoiceQuery` pour des réponses vocales plus riches.
- `server/decision.ts` — la route `/api/coach/ask` utilise désormais `answerCoachQuestionExtended` (patterns économiques étendus).
- `server/routes.ts` — imports des 4 nouveaux modules + enregistrement de toutes les routes ci-dessous.
- `client/src/pages/CoachPage.tsx` (nouveau, 434 lignes) — page complète avec les 6 sections demandées.
- `client/src/App.tsx` — route `/coach` ajoutée.
- `client/src/components/Layout.tsx` — entrée "Coach" (icône `Mic`) ajoutée au menu "Plus".

## Endpoints créés (tous protégés par `requireAuth`)

**Santé business (§10)**
- `GET /api/health/business-kpis`
- `GET /api/health/peer-benchmark`
- `GET /api/health/perf-score`

**Coach vocal & conversationnel (§13)**
- `POST /api/voice/quick-query` — body `{ text }`
- `GET /api/voice/morning-brief`
- `GET /api/voice/evening-debrief` — optionnel `?date=`
- `POST /api/coach/ask` (route existante, réponses étendues)

**Gamification économique (§15)**
- `GET /api/gamif/weekly-challenge`
- `GET /api/gamif/econ-leaderboard`
- `GET /api/gamif/goal-progress` — optionnel `?period=daily|weekly|monthly`

**Analytics personnels & RGPD (§20)**
- `GET /api/analytics/personal-records`
- `GET /api/analytics/learning-curve`
- `GET /api/analytics/export-all` — optionnel `?format=csv|json`

**Notifications adaptatives (§21)**
- `POST /api/notifications/should-deliver` — body `{ alertType, speedKmh }`
- `GET /api/notifications/digest`
- `GET /api/notifications/prefs`
- `POST /api/notifications/prefs` — body `{ category, enabled, digestOnly }`

## Page `client/src/pages/CoachPage.tsx`

Route `/coach`, accessible depuis le menu "Plus" (icône Mic). Sections :
1. **Brief du matin** — bouton play/stop, synthèse vocale native (`window.speechSynthesis`, aucune dépendance).
2. **Ma santé business** — score /100 (anneau SVG), grille de KPI, comparaison peer (médiane / top 25%).
3. **Records personnels** — podium des meilleures performances (réutilise `wowEngine.getAllRecords()`).
4. **Courbe d'apprentissage** — mini graphique SVG pur (polyline, sans lib graphique).
5. **Défi de la semaine** — carte défi actif + barre de progression.
6. **Coach — Posez une question** — réutilise le composant existant `CoachSidebar`, connecté à `/api/coach/ask` étendu.

Tap targets ≥ 44px, UI entièrement en français, icônes lucide-react (Mic, Trophy, TrendingUp, Target, Bell, Volume2, Sparkles, etc.).

## Vérification build

```
npm run build
```

Résultat : **succès complet**, aucune erreur.
- Client (Vite) : 2732 modules transformés, bundle généré dans `dist/public/`.
- Serveur (esbuild) : bundle unique `dist/index.cjs` (824.3 kb).
- Tous les 15 nouveaux endpoints confirmés présents dans le bundle serveur compilé.
- Le contenu de `CoachPage.tsx` (« Brief du matin », « Records personnels », « Défi de la semaine ») est confirmé présent dans le bundle client compilé.

Des avertissements pré-existants et sans rapport avec ce travail sont apparus (taille de chunk, import dynamique/statique mixte de `voice.ts`, doublons d'imports `MLInsightsPage`/`FatiguePage` dans `App.tsx` visibles uniquement via `tsc --noEmit`) — aucun n'affecte le build réel (esbuild/Vite ne font pas de vérification stricte de types et n'ont pas échoué).

**Aucun commit ni déploiement n'a été effectué**, conformément à la consigne.
