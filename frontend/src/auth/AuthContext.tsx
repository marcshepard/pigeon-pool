/**
 * Authentication context for managing user sessions.
 * 
 * The backend API supports simple name/password login and uses server-side session cookies.
 * It includes self-service password reset via email.
 */

// src/auth/AuthContext.tsx
import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { apiMe, apiLogin, apiLogout } from "../backend/fetch";
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

  useEffect(() => {
    refresh();
  }, []);




  const value = useMemo<AuthContextValue>(
    () => ({ state, refresh, signIn, signOut }),
    [state]   // eslint-disable-line react-hooks/exhaustive-deps
  );

  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}

