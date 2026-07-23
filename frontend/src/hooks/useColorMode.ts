/**
 * Hook to access the color mode context.
 */

import { useContext } from "react";
import { ColorModeCtx } from "./colorModeContextObjects";
import type { ColorModeContextValue } from "./colorModeContextObjects";

export function useColorMode(): ColorModeContextValue {
  const ctx = useContext(ColorModeCtx);
  if (!ctx) throw new Error("useColorMode must be used within a ColorModeProvider");
  return ctx;
}
