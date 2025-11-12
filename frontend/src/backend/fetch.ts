/**
 * Wrapper functions for fetching data from the backend API.
 */

import {
  AdminPigeon,
  AdminPigeonUpdateIn,
  AdminUser,
  AdminUserCreateIn,
  AdminUserUpdateIn,
  AdminWeekLock,
  Me,
  Ok,
  LeaderboardRow,
  LoginPayload,
  PasswordResetConfirm,
  PasswordResetRequest,
  CurrentWeek,
  Game,
  PickOut,
  PicksBulkIn,
  WeekPicksRow,
  type AdminBulkEmailRequest
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
  factory: (data: unknown, res?: Response) => T;
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
    // Try to surface server-provided message, tolerate empty bodies
    let message = res.statusText || "Request failed";
    try {
      const ct = res.headers.get("content-type") || "";
      if (ct.includes("application/json")) {
        const j = await res.json();
        if (j && typeof j === "object" && "detail" in j) {
          message = String((j as { detail?: unknown }).detail ?? message);
        } else {
          message = JSON.stringify(j);
        }
      } else {
        const text = await res.text();
        if (text) message = text;
      }
    } catch {
      /* ignore parse errors */
    }
    throw new Error(`API error ${res.status}: ${message}`);
  }

  // No-content statuses: never attempt to parse
  if (res.status === 204 || res.status === 205) {
    return init.factory(undefined, res);
  }

  // Only parse JSON when content-type indicates JSON; tolerate empty body
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    let data: unknown = undefined;
    try {
      data = await res.json();
    } catch {
      // empty body or invalid JSON -> leave data undefined
    }
    return init.factory(data, res);
  }

  // Non-JSON success: pass undefined (or read text if you ever need it)
  return init.factory(undefined, res);
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
export function getCurrentWeek(): Promise<CurrentWeek> {
  return apiFetch("/schedule/current_week", {
    method: "GET",
    factory: (d) => new CurrentWeek(d),
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
/** Helpers to construct optional query-string for submitting a pick for an alternative pigeon */
function withPigeon(qs: string, pigeonNumber?: number | null): string {
  if (pigeonNumber == null) return qs;
  if (!Number.isInteger(pigeonNumber) || pigeonNumber < 1 || pigeonNumber > 68) {
    throw new Error(`Invalid pigeonNumber: ${pigeonNumber}`);
  }
  return `${qs}${qs.includes("?") ? "&" : "?"}pigeon_number=${pigeonNumber}`;
}

/** Get picks for a week; optionally act as another managed pigeon */
export function getMyPicksForWeek(
  weekNumber: number,
  pigeonNumber?: number
): Promise<PickOut[]> {
  if (!Number.isInteger(weekNumber) || weekNumber < 1 || weekNumber > 18) {
    return Promise.reject(new Error(`Invalid weekNumber: ${weekNumber}`));
  }

  const path = withPigeon(`/picks/${weekNumber}`, pigeonNumber);

  return apiFetch(path, {
    method: "GET",
    factory: (d) => {
      if (!Array.isArray(d)) throw new Error("Expected array");
      return d.map((item) => new PickOut(item));
    },
  });
}

/** Create/update picks for a week; optionally act as another managed pigeon */
export function setMyPicks(
  payload: PicksBulkIn,
  pigeonNumber?: number
): Promise<PickOut[]> {
  const path = withPigeon(`/picks`, pigeonNumber);

  return apiFetch(path, {
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

/**
 * Fetch all weeks' lock times (admin only)
 */
export async function adminGetWeeksLocks(): Promise<AdminWeekLock[]> {
  return apiFetch("/admin/weeks/locks", {
    method: "GET",
    factory: (data: unknown) => {
      if (!Array.isArray(data)) throw new Error("Expected array");
      return data.map((row) => new AdminWeekLock(row));
    },
  });
}

/**
 * Adjust the lock time for a week (admin only)
 */
export async function adminAdjustWeekLock(week: number, lock_at: Date): Promise<void> {
  await apiFetch(`/admin/weeks/${week}/lock`, {
    method: "PATCH",
    body: JSON.stringify({ lock_at: lock_at.toISOString() }),
    factory: () => undefined,
  });
}

/** List all pigeons with their (optional) owners. */
export function adminGetPigeons(): Promise<AdminPigeon[]> {
  return apiFetch("/admin/pigeons", {
    method: "GET",
    factory: (data: unknown) => {
      if (!Array.isArray(data)) throw new Error("Expected array");
      return data.map((row) => new AdminPigeon(row));
    },
  });
}

/**
 * Update a single pigeon (name and/or owner).
 * Pass { owner_email: null } to unassign an owner.
 */
export function adminUpdatePigeon(
  pigeonNumber: number,
  patch: AdminPigeonUpdateIn | { pigeon_name?: string; owner_email?: string | null }
): Promise<void> {
  const body =
    patch instanceof AdminPigeonUpdateIn ? patch : new AdminPigeonUpdateIn(patch);
  return apiFetch(`/admin/pigeons/${pigeonNumber}`, {
    method: "PATCH",
    body: JSON.stringify(body),
    factory: () => undefined,
  });
}

// =============================
// Admin APIs – Users
// =============================

/** List all users with primary/secondary pigeon assignments. */
export function adminGetUsers(): Promise<AdminUser[]> {
  return apiFetch("/admin/users", {
    method: "GET",
    factory: (data: unknown) => {
      if (!Array.isArray(data)) throw new Error("Expected array");
      return data.map((row) => new AdminUser(row));
    },
  });
}

/**
 * Create a user (admin only).
 * Backend generates a random password; response includes email and empty assignments.
 */
export function adminCreateUser(
  input: AdminUserCreateIn | { email: string }
): Promise<AdminUser> {
  const body = input instanceof AdminUserCreateIn ? input : new AdminUserCreateIn(input);
  return apiFetch("/admin/users", {
    method: "POST",
    body: JSON.stringify(body),
    factory: (data: unknown) => new AdminUser(data),
  });
}

/**
 * Replace all assignments for a user.
 * - primary_pigeon: number|null (omit to leave user with no primary)
 * - secondary_pigeons: number[] (use [] to clear)
 */
export function adminUpdateUser(
  email: string,
  input: AdminUserUpdateIn | { primary_pigeon?: number | null; secondary_pigeons: number[] }
): Promise<void> {
  const body = input instanceof AdminUserUpdateIn ? input : new AdminUserUpdateIn(input);
  return apiFetch(`/admin/users/${encodeURIComponent(email)}`, {
    method: "PUT",
    body: JSON.stringify(body),
    factory: () => undefined,
  });
}

/** Delete a user (409 if they currently own a pigeon). */
export function adminDeleteUser(email: string): Promise<void> {
  return apiFetch(`/admin/users/${encodeURIComponent(email)}`, {
    method: "DELETE",
    factory: () => undefined,
  });
}

/** Send a bulk email to all users (admin only). Returns void on success. */
export function adminSendBulkEmail(
  req: AdminBulkEmailRequest
): Promise<void> {
  return apiFetch<void>(`/admin/bulk-email`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
    factory: () => undefined,
  });
}