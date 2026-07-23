/**
 * Central MUI theme for the app. This is the single place to tweak the
 * color scheme — every component should pull colors from `theme.palette`
 * (e.g. `color="primary"`, `theme.palette.divider`) rather than hardcoding
 * hex values, so changes here propagate everywhere.
 *
 * "Sky & slate": sky-blue primary (open sky) over slate-gray neutrals
 * (pigeon-feather gray), appropriate for a pigeon pool. Both a light and
 * a dark variant are defined; see `hooks/useColorMode.tsx` for the toggle.
 */
import { createTheme, type Theme } from "@mui/material";

export type ColorMode = "light" | "dark";

export function getTheme(mode: ColorMode): Theme {
  return createTheme({
    palette:
      mode === "light"
        ? {
            mode: "light",
            primary: {
              main: "#0284c7",
              light: "#38bdf8",
              dark: "#075985",
              contrastText: "#ffffff",
            },
            secondary: {
              main: "#475569",
              light: "#64748b",
              dark: "#1e293b",
              contrastText: "#ffffff",
            },
            background: {
              default: "#f5f5f5",
              paper: "#ffffff",
            },
            text: {
              primary: "#1e293b",
              secondary: "#475569",
            },
            divider: "#94a3b8",
          }
        : {
            mode: "dark",
            primary: {
              main: "#38bdf8",
              light: "#7dd3fc",
              dark: "#0284c7",
              contrastText: "#0f172a",
            },
            secondary: {
              main: "#94a3b8",
              light: "#cbd5e1",
              dark: "#64748b",
              contrastText: "#0f172a",
            },
            background: {
              default: "#0f172a",
              paper: "#1e293b",
            },
            text: {
              primary: "#e2e8f0",
              secondary: "#94a3b8",
            },
            divider: "#475569",
          },
  });
}
