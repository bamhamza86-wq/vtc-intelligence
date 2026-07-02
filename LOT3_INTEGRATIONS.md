# Lot 3 — Intégrations restantes pour l'agent principal

## Build status

✅ `npm run build` — succès, 0 erreurs TypeScript, 0 erreurs Vite.

---

## Fichiers créés

| Fichier | Description |
|---|---|
| `client/src/hooks/useLiveRefresh.ts` | Pulsation globale 30s, émet `vtc:pulse`, détecte visibilitychange |
| `client/src/components/LiveIndicator.tsx` | Point vert/orange/rouge pulsant LIVE/STALE, `data-testid="live-indicator"` |
| `client/src/hooks/useSmartQueryRefresh.ts` | Wrapper useQuery — 30s visible / 5min masqué, écoute `vtc:pulse` |
| `client/src/hooks/useSwipe.ts` | Détection swipe up/down/left/right sur un ref DOM |
| `client/src/components/PullToRefresh.tsx` | Wrapper pull-to-refresh tactile (80px), icône RefreshCw, `data-testid="pull-to-refresh"` |
| `client/src/lib/haptics.ts` | `haptic("tap"|"success"|"warning"|"error")` via Vibration API |
| `client/src/hooks/useWakeLock.ts` | Wake Lock API, release au unmount, réacquisition sur visibilitychange |
| `client/src/lib/audio.ts` | `playSound("alert"|"success")` via Web Audio API, géré par `vtc.sound_enabled` |
| `client/src/components/MobileSettings.tsx` | Panneau settings mobile, 4 toggles, persist localStorage, `data-testid="mobile-settings"` |

---

## Intégrations déjà effectuées

### DrivePage.tsx — `useWakeLock` ✅ DÉJÀ INTÉGRÉ

`useWakeLock()` a été ajouté au tout début du composant `DrivePage`.  
L'écran ne se mettra plus en veille automatiquement pendant la conduite.

---

## Intégrations restantes (à faire par l'agent principal)

### 1. ProfilePage.tsx — `MobileSettings`

Ajouter le composant `MobileSettings` dans `ProfilePage.tsx`, juste avant le bouton "Sauvegarder le profil" :

```tsx
import { MobileSettings } from "@/components/MobileSettings";

// Dans le JSX de ProfilePage, avant le <Button className="w-full h-12"...>
<MobileSettings />
```

### 2. Layout.tsx — `LiveIndicator` dans le header

Le header de `Layout.tsx` n'expose pas de slot dédiée.  
Insérer `LiveIndicator` dans la zone `flex items-center gap-1.5` du header, entre `<DaySignalBadge />` et le bouton theme toggle :

```tsx
import { LiveIndicator } from "@/components/LiveIndicator";

// Dans Layout.tsx, dans <div className="flex items-center gap-1.5">
<LiveIndicator />
<DaySignalBadge />
// ... reste
```

### 3. Pages principales — `PullToRefresh`

Wrapper le contenu principal des pages avec `PullToRefresh` :

```tsx
import { PullToRefresh } from "@/components/PullToRefresh";

// Dans MapPage, AlertsPage, EconomicsDashboard, etc.
<PullToRefresh onRefresh={async () => { await queryClient.invalidateQueries(); }}>
  {/* contenu existant */}
</PullToRefresh>
```

### 4. DrivePage — `useSwipe` (gestes navigation)

Le hook `useSwipe` est prêt à être intégré dans DrivePage pour swiper entre les zones :

```tsx
import { useSwipe } from "@/hooks/useSwipe";
const containerRef = useRef<HTMLDivElement>(null);
useSwipe(containerRef, {
  onSwipeLeft:  () => { /* zone suivante */ },
  onSwipeRight: () => { /* zone précédente */ },
  threshold: 50,
});
// Attacher ref={containerRef} sur le div principal
```

### 5. `useLiveRefresh` — montage global (optionnel)

Pour garantir que `vtc:pulse` est émis même si aucun composant ne l'utilise,
monter `useLiveRefresh` dans `App.tsx` ou `Layout.tsx` :

```tsx
import { useLiveRefresh } from "@/hooks/useLiveRefresh";
// En haut du composant Layout :
useLiveRefresh(); // garantit le pulse global 30s
```

### 6. `useSmartQueryRefresh` — remplacement progressif

Remplacer les `useQuery` existants des pages critiques par `useSmartQueryRefresh`
pour bénéficier du refresh adaptatif (30s visible / 5min masqué) :

```tsx
import { useSmartQueryRefresh } from "@/hooks/useSmartQueryRefresh";

// Avant :
const { data } = useQuery({ queryKey: ["/api/top-zones"], queryFn: ... });
// Après :
const { data } = useSmartQueryRefresh(["/api/top-zones"], () => apiRequest(...).then(r => r.json()));
```

---

## localStorage keys utilisées par Lot 3

| Clé | Valeur | Défaut | Usage |
|---|---|---|---|
| `vtc.sound_enabled` | `"1"` / `"0"` | `"0"` | Sons d'alerte (audio.ts) |
| `vtc.haptic_enabled` | `"1"` / `"0"` | `"1"` | Vibrations (MobileSettings) |
| `vtc.wakelockdrive` | `"1"` / `"0"` | `"1"` | Wake Lock en mode conduite (MobileSettings) |
| `vtc.autodrive_off` | `"1"` / `"0"` | `"0"` | Désactiver auto-drive (déjà utilisé par Layout) |
