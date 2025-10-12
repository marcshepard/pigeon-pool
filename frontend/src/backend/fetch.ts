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
const BASE = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, "") || "/api";

// Generic JSON fetch with type-safe factory & no `any`
// Redirect to the login page on 401 with session expired message unless they are already on that page
export async function apiFetch<T>(
  path: string,
  init: RequestInit & { factory: (data: unknown) => T }
): Promise<T> {
  console.debug(`apiFetch ${init.method || "GET"} ${path}`);
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers || {}) },
    credentials: "include",
  });

  if (!res.ok) {
    if (res.status === 401) {
      console.warn("apiFetch: 401 Unauthorized");
      // Only redirect if we're not already on the login or reset-password page.
      const loginPath = "/login";
      const resetPasswordPath = "/reset-password";
      const currentPath = location.pathname;
      const onLoginOrReset = currentPath === loginPath || currentPath === resetPasswordPath;

      if (!onLoginOrReset) {
        console.info("apiFetch: Redirecting to login page due to 401 from non-login/reset-password page");
        const returnTo = encodeURIComponent(location.pathname + location.search);
        const reason = "session_expired";
        // replace() avoids cluttering history with multiple failed redirects
        location.replace(`${loginPath}?reason=${reason}&returnTo=${returnTo}`);
      }

      // Bubble an error so callers on /login or /reset-password can render form-level feedback.
      console.warn("apiFetch: Throwing Unauthorized error");
      throw new Error("Unauthorized");
    }

    // Build a readable error message for snackbars
    let message = res.statusText || "Request failed";
    try {
      const text = await res.text();
      message = text || message;
    } catch {
      /* ignore */
    }
    throw new Error(`API error ${res.status}: ${message}`);
  }

  const json = await res.json();
  return init.factory(json);
}

// =============================
// Auth fetch wrappers
// =============================

export async function apiLogin(payload: LoginPayload): Promise<Me> {
  return apiFetch("/auth/login", {
    method: "POST",
    body: JSON.stringify(payload),
    factory: (d) => new Me(d),
  });
}

export async function apiLogout(): Promise<Ok> {
  return apiFetch("/auth/logout", {
    method: "POST",
    factory: (d) => new Ok(d),
  });
}

export async function apiMe(): Promise<Me> {
  return apiFetch("/auth/me", {
    method: "GET",
    factory: (d) => new Me(d),
  });
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
