/**
 * useVoice — Wrapper React autour de lib/voice.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Expose { speak, isEnabled, setEnabled, isSupported } pour intégration
 * facile dans les composants (ex: bouton "Tester" dans MobileSettings).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { useCallback, useEffect, useState } from "react";
import {
  speak as speakVoice,
  isVoiceEnabled,
  setVoiceMode,
  isSupported as checkIsSupported,
  type SpeakOptions,
} from "@/lib/voice";

export function useVoice() {
  const [isEnabled, setIsEnabledState] = useState<boolean>(() => isVoiceEnabled());
  const [isSupported, setIsSupported] = useState<boolean>(true);

  useEffect(() => {
    let cancelled = false;
    checkIsSupported().then((supported) => {
      if (!cancelled) setIsSupported(supported);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const setEnabled = useCallback((enabled: boolean) => {
    setIsEnabledState(enabled);
    setVoiceMode(enabled ? "on" : "off");
  }, []);

  const speak = useCallback((text: string, opts?: SpeakOptions) => {
    speakVoice(text, opts);
  }, []);

  return { speak, isEnabled, setEnabled, isSupported };
}

export default useVoice;
