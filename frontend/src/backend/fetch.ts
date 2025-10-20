/**
 * Wrapper functions for fetching data from the backend API.
 */

import {
  Me,
  Ok,
  LeaderboardRow,
  LoginPayload,
  PasswordResetConfirm,
  PasswordResetRequest,
  ScheduleCurrent,
  Game,
  PickOut,
  PicksBulkIn,
  WeekPicksRow,
} from "./types";

// Base URL for API calls, from env or default to relative /api (for dev with proxy)
const BASE = import.meta.env.VITE_API_URL as string;

// --- Lightweight token store ---
// In-memory cache and mirror to localStorage so refreshes survive.
const TOKEN_KEY = "pp_access_token";
let tokenCache: string | null = null;

function getToken(): string | null {
  if (tokenCache) return tokenCache;
  try {
    tokenCache = localStorage.getItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
  return tokenCache;
}

function setToken(t: string | null) {
  tokenCache = t;
  try {
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

// Generic JSON fetch with type-safe factory & no `any`
// Redirect to the login page on 401 with session expired message unless they are already on that page
type FetchInit<T> = RequestInit & {
  factory: (data: unknown) => T;
  redirectOn401?: boolean; // default true; set false for boot-time /auth/me
};

export async function apiFetch<T>(path: string, init: FetchInit<T>): Promise<T> {
  console.log(`API ${init.method || "GET"} ${path}`);
  const url = `${BASE}${path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(init.headers as Record<string, string> | undefined),
  };

  const tok = getToken();
  if (tok) headers.Authorization = `Bearer ${tok}`;

  const res = await fetch(url, {
    ...init,
    headers,
    // no cookies needed for bearer tokens
  });

  if (!res.ok) {
    if (res.status === 401) {
      const shouldRedirect = init.redirectOn401 !== false; // default true
      const onAuthScreens = ["/login", "/reset-password"].includes(location.pathname);
      if (shouldRedirect && !onAuthScreens) {
        const returnTo = encodeURIComponent(location.pathname + location.search);
        location.replace(`/login?reason=session_expired&returnTo=${returnTo}`);
      }
      throw new Error("Unauthorized");
    }
    let message = res.statusText || "Request failed";
    try {
      const text = await res.text();
      if (text) message = text;
    } catch { /* ignore */ }
    throw new Error(`API error ${res.status}: ${message}`);
  }

  const json = await res.json();
  return init.factory(json);
}

// =============================
// Auth fetch wrappers
// =============================
type LoginOut = {
  ok: boolean;
  access_token: string;
  token_type: "bearer";
  expires_at: string;
  user: unknown;         // will be validated by new Me(...)
};

export async function apiLogin(payload: LoginPayload): Promise<Me> {
  const out = await apiFetch<LoginOut>("/auth/login", {
    method: "POST",
    body: JSON.stringify(payload),
    factory: (d) => d as LoginOut,
    redirectOn401: false, // let caller show “invalid credentials” etc
  });

  setToken(out.access_token);
  return new Me(out.user);
}

export async function apiMe(): Promise<Me> {
  return apiFetch<Me>("/auth/me", {
    method: "GET",
    factory: (d) => new Me(d),
    redirectOn401: false, // AuthContext decides what to do on first boot
  });
}

export async function apiLogout(): Promise<void> {
  try {
    await apiFetch<{ ok: boolean }>("/auth/logout", {
      method: "POST",
      factory: () => ({ ok: true }),
      redirectOn401: false,
    });
  } catch { /* ignore */ }
  setToken(null);
}

export async function apiRequestPasswordReset(p: PasswordResetRequest): Promise<Ok> {
  return apiFetch("/auth/password-reset", {
    method: "POST",
    body: JSON.stringify(p),
    factory: (d) => new Ok(d),
  });
}

export async function apiConfirmPasswordReset(p: PasswordResetConfirm): Promise<Ok> {
  return apiFetch("/auth/password-reset/confirm", {
    method: "POST",
    body: JSON.stringify(p),
    factory: (d) => new Ok(d),
  });
}

// =============================
// Schedule fetch wrappers
// =============================
export function getScheduleCurrent(): Promise<ScheduleCurrent> {
  return apiFetch("/schedule/current_weeks", {
    method: "GET",
    factory: (d) => new ScheduleCurrent(d),
  });
}

export function getGamesForWeek(weekNumber: number): Promise<Game[]> {
  if (!Number.isInteger(weekNumber) || weekNumber < 1 || weekNumber > 18) {
    return Promise.reject(new Error(`Invalid weekNumber: ${weekNumber}`));
  }
  return apiFetch(`/schedule/${weekNumber}/games`, {
    method: "GET",
    factory: (d) => {
      if (!Array.isArray(d)) {
        throw new Error("Expected an array");
      }
      return d.map((item) => new Game(item));
    },
  });
}

// =============================
// Picks fetch wrappers
// =============================
export function getMyPicksForWeek(weekNumber: number): Promise<PickOut[]> {
  if (!Number.isInteger(weekNumber) || weekNumber < 1 || weekNumber > 18) {
    return Promise.reject(new Error(`Invalid weekNumber: ${weekNumber}`));
  }
  return apiFetch(`/picks/${weekNumber}`, {
    method: "GET",
    factory: (d) => {
      if (!Array.isArray(d)) throw new Error("Expected array");
      return d.map((item) => new PickOut(item));
    },
  });
}

/**
 * POST /picks/bulk → PickOut[]
 * @param payload PicksBulkIn
 */
export function setMyPicks(payload: PicksBulkIn): Promise<PickOut[]> {
  return apiFetch(`/picks`, {
    method: "POST",
    body: JSON.stringify(payload),
    factory: (d) => {
      if (!Array.isArray(d)) throw new Error("Expected array");
      return d.map((item) => new PickOut(item));
    },
  });
}

// =============================
// Results / Leaderboard fetches
// =============================

/**
 * Fetch all picks (joined with game metadata) for a locked week.
 * Backend will return 409 if the week is not locked.
 */
export function getResultsWeekPicks(week: number): Promise<WeekPicksRow[]> {
  return apiFetch(`/results/weeks/${week}/picks`, {
    method: "GET",
    factory: (data: unknown) => {
      if (!Array.isArray(data)) throw new Error("Invalid payload: expected array");
      return data.map((row) => new WeekPicksRow(row));
    },
  });
}

/**
 * Fetch leaderboard rows for a specific locked week.
 * Works for live (locked but ongoing) weeks since the view ignores not-started games.
 */
export function getResultsWeekLeaderboard(week: number): Promise<LeaderboardRow[]> {
  return apiFetch(`/results/weeks/${week}/leaderboard`, {
    method: "GET",
    factory: (data: unknown) => {
      if (!Array.isArray(data)) throw new Error("Invalid payload: expected array");
      return data.map((row) => new LeaderboardRow(row));
    },
  });
}

/**
 * Fetch leaderboard rows across all locked weeks (concatenated).
 */
export function getResultsAllLeaderboards(): Promise<LeaderboardRow[]> {
  return apiFetch(`/results/leaderboard`, {
    method: "GET",
    factory: (data: unknown) => {
      if (!Array.isArray(data)) throw new Error("Invalid payload: expected array");
      return data.map((row) => new LeaderboardRow(row));
    },
  });
}


// =============================
// Admin APIs
// =============================

/**
 * Fetch all picks (joined with game metadata) for any week (admin only).
 * Backend will return 403 if the user is not admin.
 */
export function adminGetWeekPicks(week: number): Promise<WeekPicksRow[]> {
  return apiFetch(`/admin/weeks/${week}/picks`, {
    method: "GET",
    factory: (data: unknown) => {
      if (!Array.isArray(data)) throw new Error("Invalid payload: expected array");
      return data.map((row) => new WeekPicksRow(row));
    },
  });
}