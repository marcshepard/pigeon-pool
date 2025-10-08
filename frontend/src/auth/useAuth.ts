/**
 * Authentication hook to access auth context.
 */

// src/auth/useAuth.ts
import { useContext } from "react";
import { AuthCtx } from "./AuthContextObjects";
import type { AuthContextValue } from "./AuthContextObjects";

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthCtx);
  if (!ctx) throw new Error("useAuth must be used within <AuthProvider>");
  return ctx;
}
