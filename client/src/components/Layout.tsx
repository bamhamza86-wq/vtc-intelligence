import { Link, useLocation } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest, getAuthToken, setAuthToken, API_BASE, REALTIME_INTERVAL } from "@/lib/queryClient";
import { useTheme } from "./ThemeProvider";
import { Bell, Map, Calculator, Database, User, Sun, Moon, LogOut, Navigation, Target, BarChart2, CornerDownLeft } from "lucide-react";

const navItems = [
  { path: "/", label: "Carte", icon: Map },
  { path: "/best-route", label: "Trajet", icon: Navigation },
  { path: "/return-journey", label: "Retour", icon: CornerDownLeft },
  { path: "/smart-plan", label: "Planning", icon: Target },
  { path: "/alerts", label: "Alertes", icon: Bell },
  { path: "/economics", label: "Éco", icon: BarChart2 },
  { path: "/profile", label: "Profil", icon: User },
];

export default function Layout({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();
  const { theme, toggle } = useTheme();
  const qc = useQueryClient();

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
  const { data: alerts = [] } = useQuery({
    queryKey: ["/api/alerts"],
    queryFn: () => apiRequest("GET", "/api/alerts").then(r => r.json()),
    refetchInterval: 3_000,   // alertes : refresh 3s temps réel
  });
  const unreadCount = (alerts as any[]).filter((a: any) => !a.is_read).length;
  const criticalCount = (alerts as any[]).filter((a: any) => !a.is_read && a.priority === "critical").length;

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <header className="border-b border-border bg-card sticky top-0 z-50">
        <div className="flex items-center justify-between px-4 py-3">
          <div className="flex items-center gap-2">
            <svg viewBox="0 0 40 40" width="32" height="32" aria-label="VTC Intelligence" fill="none">
              <rect width="40" height="40" rx="8" fill="currentColor" className="text-primary" opacity="0.15"/>
              <circle cx="20" cy="20" r="10" stroke="currentColor" className="text-primary" strokeWidth="2"/>
              <circle cx="20" cy="20" r="4" fill="currentColor" className="text-primary"/>
              <path d="M20 10 L22 14 L20 13 L18 14 Z" fill="currentColor" className="text-primary"/>
              <path d="M30 20 L26 22 L27 20 L26 18 Z" fill="currentColor" className="text-primary"/>
              <path d="M20 30 L18 26 L20 27 L22 26 Z" fill="currentColor" className="text-primary"/>
              <path d="M10 20 L14 18 L13 20 L14 22 Z" fill="currentColor" className="text-primary"/>
            </svg>
            <div>
              <h1 className="font-bold text-sm leading-none">VTC Intelligence</h1>
              <p className="text-xs text-muted-foreground leading-none mt-0.5">Aide à la décision</p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <button onClick={toggle} data-testid="button-theme-toggle" className="p-2 rounded-md hover:bg-accent transition-colors" aria-label="Basculer le thème">
              {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
            </button>
            <button onClick={handleLogout} className="p-2 rounded-md hover:bg-destructive/20 hover:text-destructive transition-colors" aria-label="Déconnexion" title="Déconnexion">
              <LogOut size={16} />
            </button>
          </div>
        </div>
      </header>
      <main className="flex-1 overflow-auto">{children}</main>
      <nav className="border-t border-border bg-card sticky bottom-0 z-50">
        <div className="flex">
          {navItems.map(({ path, label, icon: Icon }) => {
            const isActive = location === path;
            const isAlerts = path === "/alerts";
            return (
              <Link key={path} href={path} className={`flex-1 flex flex-col items-center gap-1 py-2.5 text-xs transition-colors relative ${isActive ? "text-primary font-medium" : "text-muted-foreground hover:text-foreground"}`} data-testid={`link-nav-${label.toLowerCase()}`}>
                <div className="relative">
                  <Icon size={18} />
                  {isAlerts && unreadCount > 0 && (
                    <span className={`absolute -top-1.5 -right-1.5 text-[10px] font-bold rounded-full min-w-[16px] h-4 flex items-center justify-center px-1 ${criticalCount > 0 ? "bg-red-600 text-white animate-pulse ring-2 ring-red-400/50" : "bg-destructive text-destructive-foreground"}`}>{unreadCount}</span>
                  )}
                </div>
                <span>{label}</span>
                {isActive && <span className="absolute top-0 left-1/2 -translate-x-1/2 w-8 h-0.5 bg-primary rounded-full" />}
              </Link>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
