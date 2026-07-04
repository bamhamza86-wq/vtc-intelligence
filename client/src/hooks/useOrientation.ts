/**
 * useOrientation — Détection portrait / paysage
 * ─────────────────────────────────────────────────────────────────────────────
 * Écoute `window.matchMedia('(orientation: landscape)')` et retourne
 * l'orientation courante. Support opt-in par page : chaque page décide si
 * elle adapte son layout (ex. classes `.landscape-rail`, `.landscape-pad-sm`
 * définies dans index.css) en fonction de la valeur retournée.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { useEffect, useState } from "react";

export type Orientation = "portrait" | "landscape";

const QUERY = "(orientation: landscape)";

function getOrientation(): Orientation {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return "portrait";
  }
  return window.matchMedia(QUERY).matches ? "landscape" : "portrait";
}

export function useOrientation(): Orientation {
  const [orientation, setOrientation] = useState<Orientation>(() => getOrientation());

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;

    const mql = window.matchMedia(QUERY);
    const handleChange = (e: MediaQueryListEvent | MediaQueryList) => {
      setOrientation(e.matches ? "landscape" : "portrait");
    };

    // Safari iOS < 14 n'a pas addEventListener sur MediaQueryList — fallback
    // sur l'ancienne API addListener/removeListener si nécessaire.
    if (typeof mql.addEventListener === "function") {
      mql.addEventListener("change", handleChange);
      return () => mql.removeEventListener("change", handleChange);
    } else if (typeof (mql as any).addListener === "function") {
      (mql as any).addListener(handleChange);
      return () => (mql as any).removeListener(handleChange);
    }
  }, []);

  return orientation;
}

export default useOrientation;
