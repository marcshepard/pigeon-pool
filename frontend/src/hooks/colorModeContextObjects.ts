/**
 * Color mode context objects and types.
 */

import { createContext } from "react";
import type { ColorMode } from "../theme";

export interface ColorModeContextValue {
  mode: ColorMode;
  toggleMode: () => void;
}

// only export context + types (no React components) — keeps react-refresh happy
export const ColorModeCtx = createContext<ColorModeContextValue | null>(null);
