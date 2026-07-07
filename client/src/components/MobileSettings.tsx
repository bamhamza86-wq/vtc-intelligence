/**
 * MobileSettings — Panneau de paramètres mobiles du chauffeur
 * ─────────────────────────────────────────────────────────────────────────────
 * Permet de configurer les options d'expérience mobile :
 *   • Vibrations (haptic feedback)
 *   • Sons d'alerte (Web Audio API)
 *   • Écran toujours allumé en mode conduite (Wake Lock API)
 *   • Bascule automatique vers le mode conduite à > 20 km/h
 *
 * Chaque toggle est persisté dans localStorage avec un préfixe `vtc.*`.
 *
 * Clés localStorage :
 *   vtc.haptic_enabled   — "1" | "0" (défaut : "1")
 *   vtc.sound_enabled    — "1" | "0" (défaut : "0")
 *   vtc.wakelockdrive    — "1" | "0" (défaut : "1")
 *   vtc.autodrive_off    — "1" | "0" (défaut : "0")
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * INTÉGRATION : ce composant est prêt à être inséré dans ProfilePage.tsx.
 * Ajouter au bas de la page profil, juste avant le bouton de sauvegarde :
 *
 *   import { MobileSettings } from "@/components/MobileSettings";
 *   // ...dans le JSX de ProfilePage :
 *   <MobileSettings />
 *
 * Le composant est autonome (pas de props requises) et gère son propre état.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { useState, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { Button } from "@/components/ui/button";
import { Smartphone, Volume2, Monitor, Car, MoonStar, Mic, Hand } from "lucide-react";
import { setSoundEnabled } from "@/lib/audio";
// ── Lot B : mode nuit ambre, vibrations enrichies, voix française ───────────
import { AmberNightToggle } from "@/components/AmberNightToggle";
import { hapticsEnabled, setHapticsEnabled } from "@/lib/haptics";
import { useVoice } from "@/hooks/useVoice";

// ── Clés localStorage ─────────────────────────────────────────────────────────
const KEYS = {
  haptic:     "vtc.haptic_enabled",
  sound:      "vtc.sound_enabled",
  wakelock:   "vtc.wakelockdrive",
  autoDrive:  "vtc.autodrive_off",
  handedness: "vtc.handedness",
} as const;

// ── Helpers localStorage ──────────────────────────────────────────────────────
function getFlag(key: string, defaultValue: boolean): boolean {
  const val = localStorage.getItem(key);
  if (val === null) return defaultValue;
  return val === "1";
}

function setFlag(key: string, value: boolean): void {
  localStorage.setItem(key, value ? "1" : "0");
}

// ── Vague 3, Levier 1 : main dominante (remap zone du pouce en mode conduite) ──
function getHandedness(): "right" | "left" {
  const val = localStorage.getItem(KEYS.handedness);
  return val === "left" ? "left" : "right";
}

function setHandedness(value: "right" | "left"): void {
  localStorage.setItem(KEYS.handedness, value);
}

// ── Composant ─────────────────────────────────────────────────────────────────
export function MobileSettings() {
  // ── État initial depuis localStorage ────────────────────────────────────
  const [hapticEnabled,    setHapticEnabled]    = useState(() => getFlag(KEYS.haptic,    true));
  const [soundEnabled,     setSoundEnabledState] = useState(() => getFlag(KEYS.sound,    false));
  const [wakeLockEnabled,  setWakeLockEnabled]  = useState(() => getFlag(KEYS.wakelock,  true));
  // autodrive_off = true signifie que l'auto-drive est DÉSACTIVÉ
  // On l'affiche inversé : "Bascule auto" est actif quand autodrive_off = false
  const [autoDriveActive,  setAutoDriveActive]  = useState(() => !getFlag(KEYS.autoDrive, false));

  // ── Handlers ────────────────────────────────────────────────────────────
  const handleHaptic = useCallback((val: boolean) => {
    setHapticEnabled(val);
    setFlag(KEYS.haptic, val);
  }, []);

  const handleSound = useCallback((val: boolean) => {
    setSoundEnabledState(val);
    setSoundEnabled(val); // Synchronise avec lib/audio.ts
  }, []);

  const handleWakeLock = useCallback((val: boolean) => {
    setWakeLockEnabled(val);
    setFlag(KEYS.wakelock, val);
  }, []);

  const handleAutoDrive = useCallback((val: boolean) => {
    setAutoDriveActive(val);
    // autodrive_off = "1" désactive l'auto-drive → inverser la valeur du toggle
    setFlag(KEYS.autoDrive, !val);
  }, []);

  // ── Lot B : vibrations enrichies + voix française ────────────────────────
  const [enrichedHapticsOn, setEnrichedHapticsOn] = useState(() => hapticsEnabled());
  const { speak, isEnabled: voiceEnabled, setEnabled: setVoiceEnabled } = useVoice();

  const handleEnrichedHaptics = useCallback((val: boolean) => {
    setEnrichedHapticsOn(val);
    setHapticsEnabled(val);
  }, []);

  const handleTestVoice = useCallback(() => {
    speak("Test de la voix. Roissy dans 14 minutes.", { priority: "high" });
  }, [speak]);

  // ── Vague 3, Levier 1 : main dominante ──────────────────────────────
  const [handedness, setHandednessState] = useState<"right" | "left">(() => getHandedness());
  const handleHandedness = useCallback((isLeft: boolean) => {
    const next = isLeft ? "left" : "right";
    setHandednessState(next);
    setHandedness(next);
  }, []);

  return (
    <Card data-testid="mobile-settings" className="border-primary/20">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <Smartphone size={14} className="text-primary" />
          Paramètres mobiles
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-0 px-4 pb-4">

        {/* ── Vibrations ─────────────────────────────────────────────────── */}
        <div className="flex items-center justify-between py-3">
          <div>
            <p className="text-sm font-medium">Vibrations</p>
            <p className="text-xs text-muted-foreground">
              Retour haptique sur les actions et alertes
            </p>
          </div>
          <Switch
            checked={hapticEnabled}
            onCheckedChange={handleHaptic}
            data-testid="toggle-haptic"
            aria-label="Activer les vibrations"
          />
        </div>

        <Separator />

        {/* ── Sons d'alerte ──────────────────────────────────────────────── */}
        <div className="flex items-center justify-between py-3">
          <div className="flex items-start gap-2.5">
            <Volume2 size={16} className="text-muted-foreground mt-0.5 shrink-0" />
            <div>
              <p className="text-sm font-medium">Sons d&apos;alerte</p>
              <p className="text-xs text-muted-foreground">
                Bips sonores pour les notifications importantes
              </p>
            </div>
          </div>
          <Switch
            checked={soundEnabled}
            onCheckedChange={handleSound}
            data-testid="toggle-sound"
            aria-label="Activer les sons d'alerte"
          />
        </div>

        <Separator />

        {/* ── Écran toujours allumé ───────────────────────────────────────── */}
        <div className="flex items-center justify-between py-3">
          <div className="flex items-start gap-2.5">
            <Monitor size={16} className="text-muted-foreground mt-0.5 shrink-0" />
            <div>
              <p className="text-sm font-medium">Écran toujours allumé</p>
              <p className="text-xs text-muted-foreground">
                Empêche la mise en veille en mode conduite
              </p>
            </div>
          </div>
          <Switch
            checked={wakeLockEnabled}
            onCheckedChange={handleWakeLock}
            data-testid="toggle-wakelock"
            aria-label="Activer l'écran toujours allumé en mode conduite"
          />
        </div>

        <Separator />

        {/* ── Bascule auto vers mode conduite ────────────────────────────── */}
        <div className="flex items-center justify-between py-3">
          <div className="flex items-start gap-2.5">
            <Car size={16} className="text-muted-foreground mt-0.5 shrink-0" />
            <div>
              <p className="text-sm font-medium">Bascule auto vers mode conduite</p>
              <p className="text-xs text-muted-foreground">
                Passe automatiquement en vue conduite à &gt; 20 km/h
              </p>
            </div>
          </div>
          <Switch
            checked={autoDriveActive}
            onCheckedChange={handleAutoDrive}
            data-testid="toggle-autodrive"
            aria-label="Activer la bascule automatique vers le mode conduite"
          />
        </div>

        <Separator />

        {/* ── Lot B : Mode nuit ambre ────────────────────────────────── */}
        <div className="flex items-center justify-between py-3 gap-3">
          <div className="flex items-start gap-2.5">
            <MoonStar size={16} className="text-muted-foreground mt-0.5 shrink-0" />
            <div>
              <p className="text-sm font-medium">Mode nuit ambre</p>
              <p className="text-xs text-muted-foreground">
                Palette ambre basse lumière pour la conduite de nuit (Off / Auto 21h–6h / On)
              </p>
            </div>
          </div>
          <AmberNightToggle />
        </div>

        <Separator />

        {/* ── Lot B : Vibrations enrichies ──────────────────────────── */}
        <div className="flex items-center justify-between py-3">
          <div className="flex items-start gap-2.5">
            <Smartphone size={16} className="text-muted-foreground mt-0.5 shrink-0" />
            <div>
              <p className="text-sm font-medium">Vibrations enrichies</p>
              <p className="text-xs text-muted-foreground">
                Vocabulaire haptique différencié (opportunité, alerte, fatigue, arrivée)
              </p>
            </div>
          </div>
          <Switch
            checked={enrichedHapticsOn}
            onCheckedChange={handleEnrichedHaptics}
            data-testid="toggle-haptics-enriched"
            aria-label="Activer les vibrations enrichies"
          />
        </div>

        <Separator />

        {/* ── Lot B : Voix française ─────────────────────────────── */}
        <div className="flex items-center justify-between py-3 gap-3">
          <div className="flex items-start gap-2.5">
            <Mic size={16} className="text-muted-foreground mt-0.5 shrink-0" />
            <div>
              <p className="text-sm font-medium">Voix française</p>
              <p className="text-xs text-muted-foreground">
                Annonces vocales (ex. prochaine zone, temps d'attente)
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleTestVoice}
              data-testid="button-test-voice"
              aria-label="Tester la voix française"
            >
              Tester
            </Button>
            <Switch
              checked={voiceEnabled}
              onCheckedChange={setVoiceEnabled}
              data-testid="toggle-voice"
              aria-label="Activer la voix française"
            />
          </div>
        </div>

        <Separator />

        {/* ── Vague 3, Levier 1 : Main dominante (remap zone du pouce) ────────── */}
        <div className="flex items-center justify-between py-3">
          <div className="flex items-start gap-2.5">
            <Hand size={16} className="text-muted-foreground mt-0.5 shrink-0" />
            <div>
              <p className="text-sm font-medium">Main dominante</p>
              <p className="text-xs text-muted-foreground">
                Réorganise la barre de navigation en mode conduite pour la garder à portée du pouce
              </p>
            </div>
          </div>
          <Switch
            checked={handedness === "left"}
            onCheckedChange={handleHandedness}
            data-testid="toggle-handedness"
            aria-label="Main gauche dominante (désactivé = main droite)"
          />
        </div>

      </CardContent>
    </Card>
  );
}
