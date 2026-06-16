import { QueryClient, QueryFunction } from "@tanstack/react-query";

// ──────────────────────────────────────────────────────────────────────────────
// API base URL
// publish_website rewrites __PORT_5000__ → /port/5000 during S3 upload.
// We prefix the sentinel with / so the rewrite produces /port/5000 (absolute).
// During local dev the sentinel stays __PORT_5000__ → startsWith("__") → "".
// ──────────────────────────────────────────────────────────────────────────────
const _raw = "__PORT_5000__"; // rewritten to /port/5000 by publish_website
export const API_BASE: string = _raw.startsWith("__") ? "" : "/" + _raw;

// ──────────────────────────────────────────────────────────────────────────────
// Auth token helpers
// Token is kept in memory (primary) + optional web storage for persistence.
// Using indirect access to storage to avoid static analysis false positives.
// ──────────────────────────────────────────────────────────────────────────────
const TOKEN_KEY = "vtc_auth_token";
let _memToken: string | null = null;

// Auth token — memory only (published iframe doesn't support web storage)
export function getAuthToken(): string | null {
  return _memToken;
}

export function setAuthToken(token: string | null): void {
  _memToken = token;
}

function authHeaders(): Record<string, string> {
  const token = getAuthToken();
  if (!token) return {};
  return {
    Authorization: `Bearer ${token}`,
    "X-Auth-Token": token,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// API helpers
// ──────────────────────────────────────────────────────────────────────────────
async function throwIfResNotOk(res: Response) {
  if (!res.ok) {
    const text = (await res.text()) || res.statusText;
    throw new Error(`${res.status}: ${text}`);
  }
}

export async function apiRequest(
  method: string,
  url: string,
  data?: unknown,
): Promise<Response> {
  // Retry sur 401 : couvre la race condition où le token n'est pas encore set
  // au moment du premier fetch (mount React avant setAuthToken).
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`${API_BASE}${url}`, {
      method,
      headers: {
        ...(data ? { "Content-Type": "application/json" } : {}),
        ...authHeaders(),
      },
      body: data ? JSON.stringify(data) : undefined,
    });

    if (res.status === 401 && attempt < 2) {
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
      continue;
    }

    await throwIfResNotOk(res);
    return res;
  }
  throw new Error("401: Non authentifié");
}

type UnauthorizedBehavior = "returnNull" | "throw";

export const getQueryFn: <T>(options: {
  on401: UnauthorizedBehavior;
}) => QueryFunction<T> =
  ({ on401: unauthorizedBehavior }) =>
  async ({ queryKey }) => {
    // Retry intelligent sur 401 : attend que le token soit disponible
    // (race condition entre LoginPage.onLogin et le premier render des enfants).
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch(`${API_BASE}${queryKey.join("/")}`, {
        headers: authHeaders(),
      });

      if (res.status === 401) {
        if (unauthorizedBehavior === "returnNull") return null as T;
        if (attempt < 2) {
          await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
          continue;
        }
        await throwIfResNotOk(res);
      }

      await throwIfResNotOk(res);
      return (await res.json()) as T;
    }
    throw new Error("401: Non authentifié");
  };

// Refresh global : 2s quasi temps réel pour données critiques
// Les pages peuvent surcharger avec leur propre refetchInterval
export const REALTIME_INTERVAL = 3_000;   // 3s — quasi temps réel
export const SLOW_INTERVAL     = 3_000;   // 3s — toutes les données
export const STATIC_INTERVAL   = 3_000;   // 3s — toutes les données

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "throw" }),
      refetchInterval: REALTIME_INTERVAL,   // 3s par défaut — quasi temps réel
      refetchOnWindowFocus: true,           // refresh quand l'app reprend le focus
      staleTime: 2_500,                     // considère stale après 2.5s (< 3s interval)
      gcTime: 5 * 60 * 1000,               // garde en cache 5min même si stale
      retry: (failureCount, error) => {
        // 401 déjà géré dans getQueryFn — ne pas re-retry au niveau react-query
        if (error instanceof Error && error.message.startsWith("401")) return false;
        return failureCount < 2;
      },
      retryDelay: (attempt) => Math.min(1000 * attempt, 3000),
    },
    mutations: {
      retry: false,
    },
  },
});
