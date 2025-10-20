/**
 * Authentication hook to access auth context.
 */

// src/auth/useAuth.ts
import { useContext } from "react";
import { AuthCtx } from "./_authContextObjects";
import type { AuthContextValue } from "./_authContextObjects";

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthCtx);
  if (!ctx) throw new Error("useAuth must be used within <AuthProvider>");
  // Helper: expose me for convenience
  let me = undefined;
  if (ctx.state.status === "signedIn") {
    me = ctx.state.user;
  }
  return { ...ctx, me };
}
