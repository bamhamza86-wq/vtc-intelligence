/**
 * CommandPalette — Palette de commandes rapides (⌘K desktop / swipe-up mobile)
 * ─────────────────────────────────────────────────────────────────────────────
 * Desktop : raccourci natif Ctrl+K / Cmd+K (KeyboardEvent, aucune dépendance)
 * ouvre une palette centrée avec recherche filtrée sur les actions.
 *
 * Mobile : geste swipe-up depuis le bord bas de l'écran (Pointer Events,
 * distance > 60px vers le haut, démarré dans les 24 derniers px de l'écran)
 * ouvre la même liste dans un BottomSheet (réutilise le composant BottomSheet).
 *
 * Actions couvertes : aller au focus, signaler surge, check prochaine zone,
 * voir gains du jour, ouvrir carte, ouvrir alertes, basculer thème,
 * couper/activer le son.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "wouter";
import {
  Search, Target, Zap, MapPin, Euro, Map as MapIcon, Bell,
  Moon, Sun, Volume2, VolumeX, CornerDownLeft, Command as CommandIcon,
} from "lucide-react";
import { BottomSheet } from "@/components/BottomSheet";
import { useTheme } from "@/components/ThemeProvider";
import { isSoundEnabled, setSoundEnabled, playSound } from "@/lib/audio";
import { toast } from "@/lib/toast";

interface PaletteAction {
  id: string;
  label: string;
  hint?: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  run: () => void;
  keywords?: string;
}

const SWIPE_UP_THRESHOLD_PX = 60;
const SWIPE_START_ZONE_PX = 28; // doit démarrer proche du bord bas

export function CommandPalette() {
  const [, navigate] = useLocation();
  const { theme, toggle } = useTheme();
  const [open, setOpen] = useState(false);
  const [isMobileSheet, setIsMobileSheet] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const actions: PaletteAction[] = useMemo(() => [
    {
      id: "focus",
      label: "Aller au Focus",
      hint: "Recommandation unique du moment",
      icon: Target,
      run: () => navigate("/focus"),
      keywords: "focus recommandation zone",
    },
    {
      id: "report-surge",
      label: "Signaler un surge",
      hint: "Ouvrir la carte pour signaler",
      icon: Zap,
      run: () => navigate("/"),
      keywords: "signaler surge communaute demande",
    },
    {
      id: "next-zone",
      label: "Vérifier la prochaine zone",
      hint: "Insights IA — meilleure zone",
      icon: MapPin,
      run: () => navigate("/ml-insights"),
      keywords: "prochaine zone ia ml insights",
    },
    {
      id: "day-earnings",
      label: "Voir les gains du jour",
      hint: "Tableau économique",
      icon: Euro,
      run: () => navigate("/economics"),
      keywords: "gains jour euros economie bilan",
    },
    {
      id: "map",
      label: "Ouvrir la carte",
      icon: MapIcon,
      run: () => navigate("/"),
      keywords: "carte map rentabilite",
    },
    {
      id: "alerts",
      label: "Ouvrir les alertes",
      icon: Bell,
      run: () => navigate("/alerts"),
      keywords: "alertes notifications",
    },
    {
      id: "theme",
      label: theme === "dark" ? "Passer en mode clair" : "Passer en mode sombre",
      icon: theme === "dark" ? Sun : Moon,
      run: () => toggle(),
      keywords: "theme sombre clair dark light",
    },
    {
      id: "sound",
      label: isSoundEnabled() ? "Couper les sons" : "Activer les sons",
      icon: isSoundEnabled() ? VolumeX : Volume2,
      run: () => {
        const next = !isSoundEnabled();
        setSoundEnabled(next);
        if (next) setTimeout(() => playSound("ping"), 30);
        toast.show({ msg: next ? "Sons activés" : "Sons désactivés" });
      },
      keywords: "son mute sound audio",
    },
  ], [theme, navigate, toggle]);

  const filtered = useMemo(() => {
    if (!query.trim()) return actions;
    const q = query.toLowerCase();
    return actions.filter(
      (a) => a.label.toLowerCase().includes(q) || (a.keywords ?? "").includes(q)
    );
  }, [actions, query]);

  // ── Raccourci clavier ⌘K / Ctrl+K (desktop) ──────────────────────────────
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const isMod = e.metaKey || e.ctrlKey;
      if (isMod && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setIsMobileSheet(false);
        setOpen((v) => !v);
      }
      if (e.key === "Escape") {
        setOpen(false);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // ── Geste swipe-up depuis le bord bas (mobile) ───────────────────────────
  useEffect(() => {
    let startY: number | null = null;
    let validStart = false;

    function onPointerDown(e: PointerEvent) {
      if (e.pointerType !== "touch") return;
      const distFromBottom = window.innerHeight - e.clientY;
      validStart = distFromBottom <= SWIPE_START_ZONE_PX;
      startY = validStart ? e.clientY : null;
    }
    function onPointerUp(e: PointerEvent) {
      if (!validStart || startY === null) return;
      const dy = startY - e.clientY;
      if (dy > SWIPE_UP_THRESHOLD_PX) {
        setIsMobileSheet(true);
        setOpen(true);
      }
      startY = null;
      validStart = false;
    }
    window.addEventListener("pointerdown", onPointerDown, { passive: true });
    window.addEventListener("pointerup", onPointerUp, { passive: true });
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointerup", onPointerUp);
    };
  }, []);

  useEffect(() => {
    if (open) {
      setQuery("");
      setActiveIndex(0);
      if (!isMobileSheet) {
        setTimeout(() => inputRef.current?.focus(), 20);
      }
    }
  }, [open, isMobileSheet]);

  function runAction(a: PaletteAction) {
    a.run();
    setOpen(false);
  }

  function handleKeyNav(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const a = filtered[activeIndex];
      if (a) runAction(a);
    }
  }

  if (!open) return null;

  const listContent = (
    <div className="max-h-[60vh] overflow-y-auto py-1.5">
      {filtered.length === 0 && (
        <p className="px-4 py-6 text-center text-sm text-muted-foreground">Aucune action trouvée</p>
      )}
      {filtered.map((a, i) => {
        const Icon = a.icon;
        return (
          <button
            key={a.id}
            onClick={() => runAction(a)}
            onMouseEnter={() => setActiveIndex(i)}
            className={`w-full flex items-center gap-3 px-4 py-3 text-left transition-colors ${
              i === activeIndex ? "bg-primary/10" : "hover:bg-accent/60"
            }`}
            style={{ minHeight: 44 }}
            data-testid={`command-action-${a.id}`}
          >
            <Icon size={16} className={i === activeIndex ? "text-primary" : "text-muted-foreground"} />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium truncate">{a.label}</p>
              {a.hint && <p className="text-[11px] text-muted-foreground truncate">{a.hint}</p>}
            </div>
            {i === activeIndex && <CornerDownLeft size={13} className="text-muted-foreground shrink-0" />}
          </button>
        );
      })}
    </div>
  );

  // ── Mobile : BottomSheet ──────────────────────────────────────────────────
  if (isMobileSheet) {
    return (
      <BottomSheet open={open} onClose={() => setOpen(false)} title="Actions rapides" snapPoints={[0.5, 0.85]} initialSnap={0}>
        <div className="px-3 pb-2">
          <div className="flex items-center gap-2 px-3 py-2.5 rounded-xl bg-muted/50 mb-1">
            <Search size={15} className="text-muted-foreground shrink-0" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Rechercher une action…"
              className="flex-1 bg-transparent outline-none text-sm"
              data-testid="command-palette-input-mobile"
            />
          </div>
        </div>
        {listContent}
      </BottomSheet>
    );
  }

  // ── Desktop : palette centrée ⌘K ─────────────────────────────────────────
  return (
    <div
      className="fixed inset-0 z-[75] flex items-start justify-center pt-[15vh] px-4 bg-black/50 backdrop-blur-sm"
      onClick={() => setOpen(false)}
      role="dialog"
      aria-modal="true"
      aria-label="Palette de commandes"
      data-testid="command-palette-desktop"
    >
      <div
        className="w-full max-w-lg bg-card border border-border rounded-2xl shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border">
          <Search size={16} className="text-muted-foreground shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyNav}
            placeholder="Tapez une commande… (ex : focus, surge, gains)"
            className="flex-1 bg-transparent outline-none text-sm"
            data-testid="command-palette-input"
          />
          <kbd className="hidden sm:flex items-center gap-0.5 px-1.5 py-0.5 rounded border border-border text-[10px] text-muted-foreground">
            <CommandIcon size={9} />K
          </kbd>
        </div>
        {listContent}
      </div>
    </div>
  );
}

export default CommandPalette;
