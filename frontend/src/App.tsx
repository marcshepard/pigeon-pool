/**
 * Main application component with routing and theming.
 */

// React
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";

// 3rd party
import { CssBaseline, ThemeProvider, createTheme, LinearProgress, Box } from "@mui/material";
import HomeIcon from "@mui/icons-material/Home";
import ListAltIcon from "@mui/icons-material/ListAlt";
import EmojiEventsIcon from "@mui/icons-material/EmojiEvents";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import EditNoteIcon from "@mui/icons-material/EditNote";
import AdminPanelSettingsIcon from "@mui/icons-material/AdminPanelSettings";
import SportsFootballIcon from "@mui/icons-material/SportsFootball";

// auth
import { AuthProvider } from "./auth/AuthContext";
import { useAuth } from "./auth/useAuth";
import LoginPage from "./pages/Login";
import PasswordResetConfirmPage from "./pages/PasswordResetConfirmPage";

// shell
import UserMenuAvatar from "./components/UserMenuAvatar";
import type { NavItem } from "./components/ResponsiveNav";
import ResponsiveNav from "./components/ResponsiveNav";

// pages
import HomePage from "./pages/Home";
import PicksPage from "./pages/Picks";
import PicksheetPage from "./pages/Picksheet";
import MnfOutcomesPage from "./pages/MnfOutcomes";
import YearToDatePage from "./pages/YearToDatePage";
import AboutPage from "./pages/AboutPage";
import AdminPage from "./pages/Admin";

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


function getNavItems(isAdmin: boolean): NavItem[] {
  const items: NavItem[] = [
    { path: "/", label: "Home", icon: <HomeIcon fontSize="small" /> },
    { path: "/picks", label: "Enter Picks", icon: <EditNoteIcon fontSize="small" /> },
    { path: "/picksheet", label: "Picksheet", icon: <ListAltIcon fontSize="small" /> },
    { path: "/mnf-outcomes", label: "MNF Outcomes", icon: <SportsFootballIcon fontSize="small" /> },
    { path: "/year-to-date", label: "Year-to-Date", icon: <EmojiEventsIcon fontSize="small" /> },
    { path: "/about", label: "About", icon: <InfoOutlinedIcon fontSize="small" /> },
  ];
  if (isAdmin) {
    items.push({ path: "/admin", label: "Admin", icon: <AdminPanelSettingsIcon fontSize="small" /> });
  }
  return items;
}

function PrivateShell() {
  const { state, signOut, isAdmin } = useAuth();

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
      navItems={getNavItems(isAdmin())}
      userMenu={userMenu}
    >
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/picks" element={<PicksPage />} />
        <Route path="/picksheet" element={<PicksheetPage />} />
        <Route path="/mnf-outcomes" element={<MnfOutcomesPage />} />
        <Route path="/year-to-date" element={<YearToDatePage />} />
        <Route path="/about" element={<AboutPage />} />
        <Route path="/admin" element={isAdmin() ? <AdminPage /> : <Box p={3}>Not authorized</Box>} />
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
