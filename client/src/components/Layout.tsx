/**
 * Layout — Structure principale de l'application VTC Intelligence
 * ─────────────────────────────────────────────────────────────────────────────
 * Navigation refonte Lot C :
 *   3 onglets principaux : Carte / Alertes / Éco
 *   1 bouton « Plus » (MoreHorizontal) → menu déroulant :
 *     Trajet / Planning / Simulator / Sources / Profil
 *
 * Lot 2 — Mobile responsive :
 *   - Header compact sur mobile (logo w-8, titre tronqué, sous-titre masqué)
 *   - DaySignalBadge masqué sur mobile (pastille uniquement)
 *   - Bouton thème + logout en menu Plus mobile
 *   - Nav bottom : pb-safe, min-h-[56px], icônes size={22}, text-[11px]
 *   - Menu Plus → bottom-sheet full-width sur mobile
 *
 * Redirection automatique vers /drive si vitesse GPS > 20 km/h (Lot C).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { Link, useLocation } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, useRef, useEffect } from "react";
import { apiRequest, getAuthToken, setAuthToken, API_BASE, REALTIME_INTERVAL } from "@/lib/queryClient";
import { useTheme } from "./ThemeProvider";
import {
  Bell,
  Map,
  BarChart2,
  Sun,
  Moon,
  LogOut,
  Navigation,
  Target,
  User,
  MoreHorizontal,
  Cpu,
  Database,
  FileText,
  Brain,
  Layers,
  Trophy,
} from "lucide-react";
import { DaySignalBadge } from "@/components/DaySignalBadge";
import { StreakBadge } from "@/components/StreakBadge";
import { LiveIndicator } from "@/components/LiveIndicator";
import { TomTomStatusPill } from "@/components/TomTomStatusPill";
import { useLiveRefresh } from "@/hooks/useLiveRefresh";
import { useSSE } from "@/hooks/useSSE";
import { useGpsPosition } from "@/hooks/useGpsPosition";

// ─── Onglets principaux (barre de navigation) ──────────────────────────────────
// Refonte mobile : Focus prend la place de Carte (recommandation unique en zone du pouce)
const primaryNavItems = [
  { path: "/focus",     label: "Focus",   icon: Target    },
  { path: "/alerts",    label: "Alertes", icon: Bell      },
  { path: "/economics", label: "Éco",     icon: BarChart2 },
];

// ─── Entrées du menu « Plus » ──────────────────────────────────────────────────
// Carte déplacée dans Plus (accessible en 1 tap), Fiscal ajouté (Lot D).
const moreMenuItems = [
  { path: "/",            label: "Carte",     icon: Map        },
  { path: "/best-route",  label: "Trajet",    icon: Navigation },
  { path: "/smart-plan",  label: "Planning",  icon: Target     },
  { path: "/tax",         label: "Fiscal",    icon: FileText   },
  { path: "/platforms",   label: "Plateformes", icon: Layers   },
  { path: "/simulator",   label: "Simulator", icon: Cpu        },
  { path: "/sources",     label: "Sources",   icon: Database   },
  { path: "/ml-insights", label: "Insights IA", icon: Brain    },
  { path: "/achievements", label: "Succès",    icon: Trophy     },
  { path: "/profile",     label: "Profil",    icon: User       },
];

// ─── Redirection auto vers /drive ─────────────────────────────────────────────
// Seuils avec hystérésis pour éviter les allers-retours autour de 20 km/h.
const DRIVE_ENTER_KMH = 20; // au-dessus → mode conduite
const DRIVE_EXIT_KMH  = 8;  // en-dessous et déjà sur /drive → on ne quitte pas auto

export default function Layout({ children }: { children: React.ReactNode }) {
  const [location, navigate] = useLocation();
  const { theme, toggle } = useTheme();
  const qc = useQueryClient();

  // ─── Pulse temps réel global (30s) ────────────────────────────────────
  useLiveRefresh();

  // ─── SSE push serveur (Levier 1) : écoute /api/stream, reconnexion auto ──
  // Émet des events window `vtc:sse` que les queries peuvent écouter pour re-fetch
  useSSE();

  // ─── État du menu « Plus » ──────────────────────────────────────────────────
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);

  // Fermer le menu au clic extérieur
  useEffect(() => {
    if (!moreOpen) return;
    function handleClickOutside(e: MouseEvent) {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) {
        setMoreOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [moreOpen]);

  // ─── Déconnexion ────────────────────────────────────────────────────────────
  const handleLogout = async () => {
    const token = getAuthToken();
    if (token) {
      await fetch(`${API_BASE}/api/auth/logout`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${token}`, "X-Auth-Token": token },
      });
    }
    setAuthToken(null);
    qc.setQueryData(["auth-me"], { authenticated: false });
    qc.invalidateQueries({ queryKey: ["auth-me"] });
  };

  // ─── Alertes non-lues ───────────────────────────────────────────────────────
  // Badge affiché via le Layout sur toutes les pages : 30s largement suffisant,
  // évite un refetch permanent qui remonte l'app tree toutes les 3s.
  const { data: alerts = [] } = useQuery({
    queryKey: ["/api/alerts"],
    queryFn: () => apiRequest("GET", "/api/alerts").then(r => r.json()),
    refetchInterval: 30_000,
    staleTime: 25_000,
  });
  const unreadCount   = (alerts as any[]).filter((a: any) => !a.is_read).length;
  const criticalCount = (alerts as any[]).filter((a: any) => !a.is_read && a.priority === "critical").length;

  // ─── Redirection vitesse GPS > 20 km/h → /drive (Lot C) ───────────────────
  // useGpsPosition expose désormais speedKmh (via coords.speed × 3.6).
  // Hystérésis : on entre à 20 km/h, on ne sort JAMAIS automatiquement (le chauffeur
  // reprend le contrôle manuellement, évite le clignotement au feu rouge).
  // Opt-out possible via localStorage `vtc.autodrive_off`="1".
  const { speedKmh } = useGpsPosition();
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.localStorage.getItem("vtc.autodrive_off") === "1") return;
    if (speedKmh >= DRIVE_ENTER_KMH && location !== "/drive") {
      navigate("/drive");
    }
    // Note: DRIVE_EXIT_KMH volontairement inutilisé — pas de sortie auto.
    void DRIVE_EXIT_KMH;
  }, [speedKmh, location, navigate]);

  // ─── Vague 3, Levier 1 : remap zone du pouce en mode conduite ─────────────
  // En dessous de ce seuil, la nav garde son ordre naturel (pas de conduite).
  // À partir de ce seuil, on réorganise via `order-*` CSS pour rapprocher
  // "Focus" (action la plus fréquente) de la zone de pouce facile, sans
  // remonter/démonter les éléments (pas de churn de clés React).
  const THUMB_REMAP_KMH = 10;
  const [handedness, setHandednessLocal] = useState<"right" | "left">(() => {
    if (typeof window === "undefined") return "right";
    return window.localStorage.getItem("vtc.handedness") === "left" ? "left" : "right";
  });
  // Se resynchronise si l'utilisateur change la préférence depuis Profil pendant que Layout est monté
  useEffect(() => {
    function handleStorage(e: StorageEvent) {
      if (e.key === "vtc.handedness") {
        setHandednessLocal(e.newValue === "left" ? "left" : "right");
      }
    }
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, []);
  const isDrivingForNav = speedKmh >= THUMB_REMAP_KMH;

  // Ordre CSS des 3 onglets principaux (Focus / Alertes / Éco) selon le mode :
  //   - Repos : ordre naturel (Focus, Alertes, Éco)
  //   - Conduite + droitier : Focus en position 2 depuis la droite (avant «Plus»)
  //   - Conduite + gaucher  : Focus en position 2 depuis la gauche
  const navOrder: Record<string, number> = isDrivingForNav
    ? handedness === "left"
      ? { "/focus": 2, "/alerts": 1, "/economics": 3 }
      : { "/focus": 3, "/alerts": 1, "/economics": 2 }
    : { "/focus": 1, "/alerts": 2, "/economics": 3 };
  // Classes Tailwind statiques (le JIT ne détecte pas les classes construites
  // dynamiquement via template string, d'où cette table de correspondance).
  const ORDER_CLASS: Record<number, string> = { 1: "order-1", 2: "order-2", 3: "order-3" };


  // ─── Calcul si un item du menu Plus est actif ──────────────────────────────
  const isMoreActive = moreMenuItems.some(item => location === item.path);

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* ─── En-tête ────────────────────────────────────────────────────────── */}
      {/* z-[60] : au-dessus des markers Leaflet (z-index 1169) grâce à l'isolation de <main> */}
      <header className="border-b border-border bg-card sticky top-0 z-[60] pt-safe">
        <div className="flex items-center justify-between px-3 sm:px-4 py-2 sm:py-3">
          {/* ─── Logo + titre ────────────────────────────────────────────── */}
          <div className="flex items-center gap-2">
            <svg viewBox="0 0 40 40" className="w-8 h-8 shrink-0" aria-label="VTC Intelligence" fill="none">
              <rect width="40" height="40" rx="8" fill="currentColor" className="text-primary" opacity="0.15"/>
              <circle cx="20" cy="20" r="10" stroke="currentColor" className="text-primary" strokeWidth="2"/>
              <circle cx="20" cy="20" r="4" fill="currentColor" className="text-primary"/>
              <path d="M20 10 L22 14 L20 13 L18 14 Z" fill="currentColor" className="text-primary"/>
              <path d="M30 20 L26 22 L27 20 L26 18 Z" fill="currentColor" className="text-primary"/>
              <path d="M20 30 L18 26 L20 27 L22 26 Z" fill="currentColor" className="text-primary"/>
              <path d="M10 20 L14 18 L13 20 L14 22 Z" fill="currentColor" className="text-primary"/>
            </svg>
            <div className="min-w-0">
              <h1 className="font-bold text-xs sm:text-sm leading-none truncate max-w-[140px] sm:max-w-none">VTC Intelligence</h1>
              <p className="hidden sm:block text-xs text-muted-foreground leading-none mt-0.5">Aide à la décision</p>
            </div>
          </div>

          {/* ─── Actions header ──────────────────────────────────────────── */}
          <div className="flex items-center gap-1">
            {/* Signal journée — pastille compacte sur mobile, badge complet sur sm+ */}
            <div className="hidden sm:flex">
              <DaySignalBadge />
            </div>
            {/* Pastille seule sur mobile (DaySignalBadge masqué, on garde juste l'icône) */}
            <div className="flex sm:hidden" data-testid="day-signal-mobile">
              <DaySignalBadge compact />
            </div>
            {/* Pastille TomTom compacte sur mobile (icône seule, à côté de DaySignalBadge) */}
            <div className="flex sm:hidden">
              <TomTomStatusPill compact />
            </div>
            {/* Couche Wow Factor : série quotidienne (streak) compacte dans le header */}
            <StreakBadge compact />
            {/* Indicateur LIVE/STALE fraîcheur GPS */}
            <div className="hidden sm:flex">
              <LiveIndicator />
            </div>
            {/* Pastille TomTom actif / non connecté — juste après LiveIndicator (desktop) */}
            <div className="hidden sm:flex">
              <TomTomStatusPill />
            </div>
            {/* Bouton thème — desktop seulement (mobile : dans menu Plus) */}
            <button
              onClick={toggle}
              data-testid="button-theme-toggle"
              className="hidden sm:flex p-2 rounded-md hover:bg-accent transition-colors"
              aria-label="Basculer le thème"
            >
              {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
            </button>
            {/* Bouton logout — desktop seulement (mobile : dans menu Plus) */}
            <button
              onClick={handleLogout}
              className="hidden sm:flex p-2 rounded-md hover:bg-destructive/20 hover:text-destructive transition-colors"
              aria-label="Déconnexion"
              title="Déconnexion"
            >
              <LogOut size={16} />
            </button>
          </div>
        </div>
      </header>

      {/* ─── Contenu principal ──────────────────────────────────────────────── */}
      {/* isolate + relative + z-0 : crée un stacking context qui plafonne les z-index enfants (markers Leaflet z:1169) DANS <main>, les empêchant de déborder au-dessus du header/nav (z-[60]). */}
      <main className="flex-1 overflow-auto relative z-0 isolate">{children}</main>

      {/* ─── Barre de navigation bas ────────────────────────────────────────── */}
      {/* z-[60] : même niveau que header, au-dessus des markers Leaflet */}
      <nav
        className="border-t border-border bg-card sticky bottom-0 z-[60] pb-safe"
        data-testid="nav-bottom"
      >
        {/* ─── Grille fixe 4 colonnes ──────────────────────────────────────── */}
        <div className="grid grid-cols-4">
          {/* ── Onglets principaux ─────────────────────────────────────────── */}
          {primaryNavItems.map(({ path, label, icon: Icon }) => {
            const isActive = location === path;
            const isAlerts = path === "/alerts";
            // Vague 3, Levier 1 : ordre visuel remappé en mode conduite (zone du pouce)
            const orderClass = ORDER_CLASS[navOrder[path]] || "";
            return (
              <Link
                key={path}
                href={path}
                className={`flex flex-col items-center justify-center gap-1 min-h-[56px] text-[11px] transition-colors relative ${orderClass} ${
                  isActive ? "text-primary font-medium" : "text-muted-foreground hover:text-foreground"
                }`}
                data-testid={`link-nav-${label.toLowerCase()}`}
              >
                <div className="relative">
                  <Icon size={22} />
                  {isAlerts && unreadCount > 0 && (
                    <span
                      className={`absolute -top-1.5 -right-1.5 text-[10px] font-bold rounded-full min-w-[16px] h-4 flex items-center justify-center px-1 ${
                        criticalCount > 0
                          ? "bg-red-600 text-white animate-pulse ring-2 ring-red-400/50"
                          : "bg-destructive text-destructive-foreground"
                      }`}
                    >
                      {unreadCount}
                    </span>
                  )}
                </div>
                <span>{label}</span>
                {isActive && (
                  <span className="absolute top-0 left-1/2 -translate-x-1/2 w-8 h-0.5 bg-primary rounded-full" />
                )}
              </Link>
            );
          })}

          {/* ── Bouton « Plus » ──────────────────────────────────────────── */}
          <div ref={moreRef} className="relative flex flex-col items-center justify-center order-4">
            <button
              data-testid="nav-more-button"
              onClick={() => setMoreOpen(prev => !prev)}
              className={`flex flex-col items-center justify-center gap-1 min-h-[56px] w-full text-[11px] transition-colors relative ${
                isMoreActive || moreOpen ? "text-primary font-medium" : "text-muted-foreground hover:text-foreground"
              }`}
              aria-haspopup="true"
              aria-expanded={moreOpen}
            >
              <MoreHorizontal size={22} />
              <span>Plus</span>
              {(isMoreActive) && (
                <span className="absolute top-0 left-1/2 -translate-x-1/2 w-8 h-0.5 bg-primary rounded-full" />
              )}
            </button>

            {/* ─── Menu Plus — bottom-sheet mobile / popover desktop ────── */}
            {moreOpen && (
              <>
                {/* Backdrop mobile */}
                <div
                  className="fixed inset-0 bg-black/50 z-40 sm:hidden"
                  onClick={() => setMoreOpen(false)}
                  data-testid="nav-more-backdrop"
                />
                {/* Bottom-sheet mobile */}
                <div
                  data-testid="nav-more-menu"
                  className="
                    fixed inset-x-0 bottom-16 z-50 rounded-t-xl bg-card border-t border-border shadow-2xl pb-safe
                    sm:absolute sm:inset-x-auto sm:bottom-full sm:right-0 sm:mb-1 sm:w-44 sm:rounded-lg sm:border sm:shadow-lg sm:overflow-hidden
                  "
                >
                  {/* ─── Actions thème + logout — visibles uniquement sur mobile (dans ce menu) */}
                  <div className="flex items-center gap-2 px-4 py-3 border-b border-border sm:hidden">
                    <button
                      onClick={() => { toggle(); setMoreOpen(false); }}
                      className="flex items-center gap-2 flex-1 text-sm text-foreground"
                      aria-label="Basculer le thème"
                    >
                      {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
                      <span>{theme === "dark" ? "Mode clair" : "Mode sombre"}</span>
                    </button>
                    <button
                      onClick={() => { handleLogout(); setMoreOpen(false); }}
                      className="flex items-center gap-2 text-sm text-destructive"
                      aria-label="Déconnexion"
                    >
                      <LogOut size={16} />
                      <span>Déconnexion</span>
                    </button>
                  </div>
                  {/* ─── Items de navigation ─────────────────────────────── */}
                  {moreMenuItems.map(({ path, label, icon: Icon }) => {
                    const isActive = location === path;
                    return (
                      <Link
                        key={path}
                        href={path}
                        onClick={() => setMoreOpen(false)}
                        className={`flex items-center gap-2.5 px-4 py-3 sm:py-2.5 text-sm transition-colors ${
                          isActive
                            ? "bg-primary/10 text-primary font-medium"
                            : "text-foreground hover:bg-accent"
                        }`}
                      >
                        <Icon size={15} />
                        <span>{label}</span>
                      </Link>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        </div>
      </nav>
    </div>
  );
}
