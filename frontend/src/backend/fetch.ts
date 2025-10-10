/**
 * Wrapper functions for fetching data from the backend API.
 */

import {
  Me,
  Ok,
  LoginPayload,
  PasswordResetConfirm,
  PasswordResetRequest,
  ScheduleCurrent,
  Game,
  PickIn,
  PickOut,
  PicksBulkIn,
} from "./types";

// Base URL for API calls, from env or default to relative /api (for dev with proxy)
const BASE = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, "") || "/api";

// Generic JSON fetch with type-safe factory & no `any`
// Redirect to the login page on 401 with session expired message unless they are already on that page
export async function apiFetch<T>(
  path: string,
  init: RequestInit & { factory: (data: unknown) => T }
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers || {}) },
    credentials: "include",
  });

  if (!res.ok) {
    if (res.status === 401) {
      // Only redirect if we're not already on the login page.
      const loginPath = "/login";
      const onLoginPage = location.pathname.startsWith(loginPath);

      if (!onLoginPage) {
        const returnTo = encodeURIComponent(location.pathname + location.search);
        const reason = "session_expired";
        // replace() avoids cluttering history with multiple failed redirects
        location.replace(`${loginPath}?reason=${reason}&returnTo=${returnTo}`);
      }

      // Bubble an error so callers on /login can render form-level feedback.
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

// ---- Endpoint helpers ----
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

/** GET /schedule/current_weeks → { next_picks_week, live_week } */
export function getScheduleCurrent(): Promise<ScheduleCurrent> {
  return apiFetch("/schedule/current_weeks", {
    method: "GET",
    factory: (d) => new ScheduleCurrent(d),
  });
}

/** GET /schedule/{week_number}/games → Game[] */
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

/**
 * GET /picks/{week_number} → PickOut[]
 */
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
export function upsertPicksBulk(payload: PicksBulkIn): Promise<PickOut[]> {
  return apiFetch(`/picks/bulk`, {
    method: "POST",
    body: JSON.stringify(payload),
    factory: (d) => {
      if (!Array.isArray(d)) throw new Error("Expected array");
      return d.map((item) => new PickOut(item));
    },
  });
}

/**
 * PUT /picks/{game_id} → PickOut
 * @param gameId number
 * @param pick PickIn
 */
export function upsertSinglePick(gameId: number, pick: PickIn): Promise<PickOut> {
  if (!Number.isInteger(gameId)) {
    return Promise.reject(new Error("Invalid gameId"));
  }
  return apiFetch(`/picks/${gameId}`, {
    method: "PUT",
    body: JSON.stringify(pick),
    factory: (d) => new PickOut(d),
  });
}