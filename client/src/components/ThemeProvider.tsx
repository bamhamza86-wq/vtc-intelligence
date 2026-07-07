import { createContext, useContext, useEffect, useState } from "react";
type Theme = "dark" | "light";
// setTheme ajouté (Vague 2 - Feature 7) pour permettre un contrôle programmatique
// (ex: bascule automatique jour/nuit) sans casser l'API existante (theme/toggle).
const ThemeContext = createContext<{ theme: Theme; toggle: () => void; setTheme: (t: Theme) => void }>({ theme: "dark", toggle: () => {}, setTheme: () => {} });
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setTheme] = useState<Theme>(() => window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  useEffect(() => { document.documentElement.classList.toggle("dark", theme === "dark"); }, [theme]);
  const toggle = () => {
    // Bascule manuelle : on note l'horodatage pour que useAutoSunsetTheme
    // suspende la bascule automatique pendant quelques heures (Vague 2 - Feature 7).
    try { localStorage.setItem("vtc.theme.lastManualToggle", String(Date.now())); } catch {}
    setTheme(t => t === "dark" ? "light" : "dark");
  };
  return <ThemeContext.Provider value={{ theme, toggle, setTheme }}>{children}</ThemeContext.Provider>;
}
export const useTheme = () => useContext(ThemeContext);
