// ──────────────────────────────────────────────────────────────────────────────
// pwa.ts — Enregistrement du service worker + gestion de l'installation PWA
// ──────────────────────────────────────────────────────────────────────────────
// - registerServiceWorker() : à appeler une fois depuis App.tsx (uniquement en
//   PROD, ne doit jamais s'exécuter en dev pour ne pas casser le HMR Vite).
// - promptInstall()          : déclenche le prompt natif d'installation si
//   l'événement `beforeinstallprompt` a été capturé au préalable.
// - isStandalone()           : détecte si l'app tourne déjà en mode installé
//   (standalone / TWA / iOS "ajouter à l'écran d'accueil").
// - Écoute globale de `beforeinstallprompt` pour permettre à InstallPrompt.tsx
//   d'afficher un bandeau personnalisé au lieu du mini-infobar par défaut.
// ──────────────────────────────────────────────────────────────────────────────

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
};

let deferredPrompt: BeforeInstallPromptEvent | null = null;

// Liste d'abonnés notifiés quand la disponibilité de l'installation change.
type InstallAvailabilityListener = (available: boolean) => void;
const availabilityListeners = new Set<InstallAvailabilityListener>();

// ──────────────────────────────────────────────────────────────────────────────
// Capture précoce de l'événement beforeinstallprompt (module chargé au boot).
// ──────────────────────────────────────────────────────────────────────────────
if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (event) => {
    // Empêche Chrome d'afficher son mini-infobar automatique.
    event.preventDefault();
    deferredPrompt = event as BeforeInstallPromptEvent;
    availabilityListeners.forEach((listener) => listener(true));
  });

  window.addEventListener("appinstalled", () => {
    deferredPrompt = null;
    availabilityListeners.forEach((listener) => listener(false));
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// registerServiceWorker — à appeler depuis App.tsx (montage racine unique).
// Ne s'exécute qu'en production pour ne jamais interférer avec le dev server.
// ──────────────────────────────────────────────────────────────────────────────
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD) return;
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;

  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("/sw.js")
      .then((registration) => {
        // Vérifie régulièrement les mises à jour (ex: retour au premier plan).
        registration.addEventListener("updatefound", () => {
          const newWorker = registration.installing;
          if (!newWorker) return;
          newWorker.addEventListener("statechange", () => {
            if (newWorker.state === "installed" && navigator.serviceWorker.controller) {
              // Nouvelle version prête : elle prendra effet au prochain reload
              // (le SW appelle déjà skipWaiting côté sw.js pour une MAJ propre).
              // eslint-disable-next-line no-console
              console.info("[pwa] nouvelle version disponible, sera active au prochain chargement");
            }
          });
        });
      })
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.warn("[pwa] échec d'enregistrement du service worker", err);
      });
  });
}

// ──────────────────────────────────────────────────────────────────────────────
// isStandalone — true si l'app est déjà installée / lancée en mode autonome.
// ──────────────────────────────────────────────────────────────────────────────
export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;

  const mediaStandalone = window.matchMedia?.("(display-mode: standalone)")?.matches;
  // iOS Safari expose navigator.standalone (non standard, non typé par défaut).
  const iosStandalone = (window.navigator as Navigator & { standalone?: boolean }).standalone;

  return Boolean(mediaStandalone || iosStandalone);
}

// ──────────────────────────────────────────────────────────────────────────────
// isInstallAvailable — indique si le prompt natif est actuellement disponible.
// ──────────────────────────────────────────────────────────────────────────────
export function isInstallAvailable(): boolean {
  return deferredPrompt !== null;
}

// ──────────────────────────────────────────────────────────────────────────────
// onInstallAvailabilityChange — s'abonner aux changements de disponibilité
// (utilisé par InstallPrompt.tsx pour se ré-afficher/masquer dynamiquement).
// Retourne une fonction de désabonnement.
// ──────────────────────────────────────────────────────────────────────────────
export function onInstallAvailabilityChange(listener: InstallAvailabilityListener): () => void {
  availabilityListeners.add(listener);
  return () => availabilityListeners.delete(listener);
}

// ──────────────────────────────────────────────────────────────────────────────
// promptInstall — déclenche le prompt natif d'installation.
// Retourne "accepted" | "dismissed" | "unavailable".
// ──────────────────────────────────────────────────────────────────────────────
export async function promptInstall(): Promise<"accepted" | "dismissed" | "unavailable"> {
  if (!deferredPrompt) return "unavailable";

  await deferredPrompt.prompt();
  const { outcome } = await deferredPrompt.userChoice;
  deferredPrompt = null;
  availabilityListeners.forEach((listener) => listener(false));

  return outcome;
}
