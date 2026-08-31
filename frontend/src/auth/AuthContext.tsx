/**
 * Authentication context for managing user sessions.
 * 
 * The backend API supports simple name/password login and uses server-side session cookies.
 * It includes self-service password reset via email.
 */

// src/auth/AuthContext.tsx
import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { apiMe, apiLogin, apiLogout, apiSelectTenantContext } from "../backend/fetch";
import { type AuthContextValue, type AuthState, AuthCtx } from "./authContextObjects";
import { LoginPayload } from "../backend/types";
import { useAppCache } from "../hooks/useAppCache";

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: "unknown" });

  const refresh = async () => {
    try {
      const user = await apiMe();
      setState({ status: "signedIn", user });
    } catch {
      useAppCache.getState().invalidateAll();
      setState({ status: "signedOut" });
    }
  };

  const signIn = async (payload: LoginPayload) => {
    await apiLogin(payload);
    useAppCache.getState().invalidateAll();
    await refresh();
  };

  const signOut = async () => {
    try {
      await apiLogout();
    } finally {
      useAppCache.getState().invalidateAll();
      setState({ status: "signedOut" });
    }
  };

  const switchTenant = async (tenant_id: number) => {
    await apiSelectTenantContext(tenant_id);
    useAppCache.getState().invalidateAll();
    // Reload so all page-level data re-fetches against the new tenant.
    // TODO (future milestone): invalidate per-page query caches instead of full reload.
    window.location.reload();
  };

  useEffect(() => {
    refresh();
  }, []);




  const value = useMemo<AuthContextValue>(
    () => ({ state, refresh, signIn, signOut, switchTenant }),
    [state]   // eslint-disable-line react-hooks/exhaustive-deps
  );

  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}

