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

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: "unknown" });

  const refresh = async () => {
    try {
      const user = await apiMe();
      setState({ status: "signedIn", user });
    } catch {
      setState({ status: "signedOut" });
    }
  };

  const signIn = async (payload: LoginPayload) => {
    await apiLogin(payload);
    await refresh();
  };

  const signOut = async () => {
    try {
      await apiLogout();
    } finally {
      setState({ status: "signedOut" });
    }
  };

  const switchTenant = async (tenant_id: number) => {
    await apiSelectTenantContext(tenant_id);
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

