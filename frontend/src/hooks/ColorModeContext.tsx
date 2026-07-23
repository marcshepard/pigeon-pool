/**
 * Provides the MUI theme, driven by a light/dark mode that's persisted to localStorage.
 */

import { useMemo, useState, type ReactNode } from "react";
import { ThemeProvider, CssBaseline } from "@mui/material";
import { getTheme, type ColorMode } from "../theme";
import { ColorModeCtx } from "./colorModeContextObjects";

const STORAGE_KEY = "pp_color_mode";

function getInitialMode(): ColorMode {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === "light" || stored === "dark") return stored;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function ColorModeProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<ColorMode>(getInitialMode);

  const toggleMode = () => {
    setMode((prev) => {
      const next: ColorMode = prev === "light" ? "dark" : "light";
      localStorage.setItem(STORAGE_KEY, next);
      return next;
    });
  };

  const theme = useMemo(() => getTheme(mode), [mode]);

  return (
    <ColorModeCtx.Provider value={{ mode, toggleMode }}>
      <ThemeProvider theme={theme}>
        <CssBaseline />
        {children}
      </ThemeProvider>
    </ColorModeCtx.Provider>
  );
}
