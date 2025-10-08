/**
 * Wrapper functions for fetching data from the backend API.
 */

import {
  Me, Ok, LoginPayload, PasswordResetConfirm, PasswordResetRequest
} from "./types";

// Base URL for API calls, from env or default to relative /api (for dev with proxy)
const BASE = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, "") || "/api";

export type UnauthorizedHandler = () => void;
let onUnauthorized: UnauthorizedHandler | null = null;
export function setUnauthorizedHandler(handler: UnauthorizedHandler) {
  onUnauthorized = handler;
}

// Generic JSON fetch with type-safe factory & no `any`
export async function apiFetch<T>(
  path: string,
  init: RequestInit & { factory: (data: unknown) => T }
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers || {}) },
    credentials: "include", // cookie auth
  });

  if (!res.ok) {
    if (res.status === 401 && onUnauthorized) {
      onUnauthorized();
    }
    const text = await res.text();
    throw new Error(`API error ${res.status}: ${text}`);
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