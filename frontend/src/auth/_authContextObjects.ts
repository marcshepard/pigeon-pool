/**
 * Authentication context objects and types.
 */

import { createContext } from "react";
import type { Me, LoginPayload } from "../backend/types";

export type AuthState =
  | { status: "unknown" }
  | { status: "signedOut" }
  | { status: "signedIn"; user: Me };


export type AuthContextValue = {
  state: AuthState;
  refresh: () => Promise<void>;
  signIn: (payload: LoginPayload) => Promise<void>;
  signOut: () => Promise<void>;
  me?: Me;
};

// ✅ only export context + types (no React components)
export const AuthCtx = createContext<AuthContextValue | null>(null);
