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
  const res = await fetch(`${API_BASE}${url}`, {
    method,
    headers: {
      ...(data ? { "Content-Type": "application/json" } : {}),
      ...authHeaders(),
    },
    body: data ? JSON.stringify(data) : undefined,
  });

  await throwIfResNotOk(res);
  return res;
}

type UnauthorizedBehavior = "returnNull" | "throw";

export const getQueryFn: <T>(options: {
  on401: UnauthorizedBehavior;
}) => QueryFunction<T> =
  ({ on401: unauthorizedBehavior }) =>
  async ({ queryKey }) => {
    const res = await fetch(`${API_BASE}${queryKey.join("/")}`, {
      headers: authHeaders(),
    });

    if (unauthorizedBehavior === "returnNull" && res.status === 401) {
      return null;
    }

    await throwIfResNotOk(res);
    return await res.json();
  };

// Refresh global : 2s quasi temps réel pour données critiques
// Les pages peuvent surcharger avec leur propre refetchInterval
export const REALTIME_INTERVAL = 2_000;   // 2s — données live (profitability, alerts)
export const SLOW_INTERVAL     = 30_000;  // 30s — données lentes (events, flights)
export const STATIC_INTERVAL   = 60_000;  // 60s — données statiques (zones, profile)

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "throw" }),
      refetchInterval: REALTIME_INTERVAL,   // 2s par défaut — temps réel
      refetchOnWindowFocus: true,           // refresh quand l'app reprend le focus
      staleTime: 1_500,                     // considère stale après 1.5s (< 2s interval)
      gcTime: 5 * 60 * 1000,               // garde en cache 5min même si stale
      retry: 1,                             // 1 retry en cas d'erreur réseau
    },
    mutations: {
      retry: false,
    },
  },
});
