/**
 * Main application component with routing and theming.
 */

// src/App.tsx
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { CssBaseline, ThemeProvider, createTheme, LinearProgress, Box } from "@mui/material";
import UserMenuAvatar from "./components/UserMenuAvatar";

// auth
import { AuthProvider } from "./auth/AuthContext";
import { useAuth } from "./auth/useAuth";

// shell + pages
import ResponsiveNav from "./components/ResponsiveNav";
import LoginPage from "./pages/Login";
import PasswordResetConfirmPage from "./pages/PasswordResetConfirmPage";
import HomePage from "./pages/Home";
import PicksPage from "./pages/Picks";
import ResultsPage from "./pages/ResultsPage";
import YearToDatePage from "./pages/YearToDatePage";
import AboutPage from "./pages/AboutPage";

import type { NavItem } from "./components/ResponsiveNav";
import HomeIcon from "@mui/icons-material/Home";
import ListAltIcon from "@mui/icons-material/ListAlt";
import EmojiEventsIcon from "@mui/icons-material/EmojiEvents";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import EditNoteIcon from "@mui/icons-material/EditNote";

// ---- optional theme ----
const theme = createTheme({
  palette: {
    mode: "light",
    primary: { main: "#1976d2" },
  },
});

function Brand() {
  return (
      <img
        src="/pigeon.png"
        alt="Pigeon logo"
        style={{ height: 48, width: "auto", display: "block" }}
      />
  );
}

const navItems: NavItem[] = [
  { path: "/", label: "Home", icon: <HomeIcon fontSize="small" /> },
  { path: "/picks", label: "Enter Picks", icon: <EditNoteIcon fontSize="small" /> },
  { path: "/results", label: "Results", icon: <ListAltIcon fontSize="small" /> },
  { path: "/year-to-date", label: "Year-to-Date", icon: <EmojiEventsIcon fontSize="small" /> },
  { path: "/about", label: "About", icon: <InfoOutlinedIcon fontSize="small" /> },
];

function PrivateShell() {
  const { state, signOut } = useAuth();

  // First boot: probing /auth/me
  if (state.status === "unknown") {
    return (
      <Box sx={{ p: 2 }}>
        <LinearProgress />
      </Box>
    );
  }

  // Not signed in → redirect to login, unless already on /login or /reset-password
  if (state.status === "signedOut") {
    console.log ("Current state is signedOut");
    const currentPath = window.location.pathname;
      console.log ("Current path is ", currentPath);

    if (currentPath !== "/login" && currentPath !== "/reset-password") {
      return <Navigate to="/login" replace />;
    }
  }

  // Signed in → render the app shell with routes
  const userMenu = state.status === "signedIn" ? (
    <UserMenuAvatar user={state.user} onSignOut={signOut} />
  ) : null;

  return (
    <ResponsiveNav
      title="Pigeon Pool"
      brand={<Brand />}
      navItems={navItems}
      userMenu={userMenu}
    >
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/picks" element={<PicksPage />} />
        <Route path="/results" element={<ResultsPage />} />
        <Route path="/year-to-date" element={<YearToDatePage />} />
        <Route path="/about" element={<AboutPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </ResponsiveNav>
  );
}

export default function App() {
  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <AuthProvider>
        <BrowserRouter>
          <Routes>
            {/* Public routes */}
            <Route path="/login" element={<LoginPage />} />
            <Route path="/reset-password" element={<PasswordResetConfirmPage />} />
            {/* Private app */}
            <Route path="/*" element={<PrivateShell />} />
          </Routes>
        </BrowserRouter>
      </AuthProvider>
    </ThemeProvider>
  );
}
