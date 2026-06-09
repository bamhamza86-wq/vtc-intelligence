import { QueryClient, QueryFunction } from "@tanstack/react-query";

// ──────────────────────────────────────────────────────────────────────────────
// API base URL
// The sentinel __PORT_5000__ is rewritten to /port/5000 by publish_website.
// During local dev it stays as-is and resolves to empty string (same origin).
// ──────────────────────────────────────────────────────────────────────────────
const _sentinel = "__PORT_5000__";
export const API_BASE = _sentinel.startsWith("__") ? "" : _sentinel;

// ──────────────────────────────────────────────────────────────────────────────
// Auth token helpers
// Token is kept in localStorage for persistence + an in-memory fallback.
// ──────────────────────────────────────────────────────────────────────────────
const TOKEN_KEY = "vtc_auth_token";
let _memToken: string | null = null;

export function getAuthToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY) || _memToken;
  } catch {
    return _memToken;
  }
}

export function setAuthToken(token: string | null): void {
  _memToken = token;
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // localStorage unavailable — memory-only
  }
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

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "throw" }),
      refetchInterval: false,
      refetchOnWindowFocus: false,
      staleTime: Infinity,
      retry: false,
    },
    mutations: {
      retry: false,
    },
  },
});
