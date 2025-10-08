/**
 * Main application component with routing and theming.
 */

// src/App.tsx
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { CssBaseline, ThemeProvider, createTheme, LinearProgress, Box } from "@mui/material";

// auth
import { AuthProvider } from "./auth/AuthContext";
import { useAuth } from "./auth/useAuth";

// shell + pages
import ResponsiveNav from "./components/ResponsiveNav";
import LoginPage from "./pages/Login";
import HomePage from "./pages/Home";
import PicksPage from "./pages/Picks";

// ---- optional theme ----
const theme = createTheme({
  palette: {
    mode: "light",
    primary: { main: "#1976d2" },
  },
});

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

  // Not signed in → redirect to login
  if (state.status === "signedOut") {
    return <Navigate to="/login" replace />;
  }

  // Signed in → render the app shell with routes
  return (
    <ResponsiveNav title="Pigeon Pool" onSignOut={signOut}>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/picks" element={<PicksPage />} />
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
            {/* Private app */}
            <Route path="/*" element={<PrivateShell />} />
          </Routes>
        </BrowserRouter>
      </AuthProvider>
    </ThemeProvider>
  );
}
