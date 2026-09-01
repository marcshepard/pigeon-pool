/**
 * Login page component.
 */

// src/pages/Login.tsx
import { useEffect, useState } from "react";
import { Alert, Box, Button, Checkbox, FormControlLabel, Paper, Stack, TextField, Typography, Link } from "@mui/material";
import IosShareIcon from "@mui/icons-material/IosShare";
import MoreVertIcon from "@mui/icons-material/MoreVert";
import { alpha } from "@mui/material/styles";
import { AppSnackbar } from "../components/CommonComponents";
import PasswordResetRequestForm from "./PasswordResetRequestForm";
import { useAuth } from "../auth/useAuth";
import { LoginPayload } from "../backend/types";
import { useNavigate, useSearchParams } from "react-router-dom";
import { PASSWORD_MAX_LENGTH } from "../utils/passwordPolicy";

type InstallPlatform = "ios" | "android";

function getMobileInstallPlatform(): InstallPlatform | null {
  const userAgent = navigator.userAgent;
  const isIOS =
    /iPad|iPhone|iPod/i.test(userAgent) ||
    (/Macintosh/i.test(userAgent) && navigator.maxTouchPoints > 1);
  const platform = isIOS
    ? "ios"
    : /Android/i.test(userAgent)
      ? "android"
      : null;
  const isStandalone =
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true;

  return platform && !isStandalone ? platform : null;
}

export default function LoginPage() {
  const { signIn } = useAuth();  // pulls in apiLogin via context
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const reason = searchParams.get("reason");
  const returnToParam = searchParams.get("returnTo") || "/";
  const returnTo = returnToParam.startsWith("/") ? returnToParam : "/";   // only allow same-origin relative paths

  const [email, setEmail] = useState("");
  const [rememberEmail, setRememberEmail] = useState(false);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [installPlatform] = useState(getMobileInstallPlatform);

  const [snack, setSnack] = useState({
    open: false,
    message: "",
    severity: "info" as "success" | "error" | "info" | "warning",
  });
  // Track if last error was an auth failure to highlight reset option
  const [highlightReset, setHighlightReset] = useState(false);
  const [showResetForm, setShowResetForm] = useState(false);

  // Initialize from localStorage on mount
  useEffect(() => {
    try {
      const saved = localStorage.getItem("pigeonpool.rememberEmail");
      const savedEmail = localStorage.getItem("pigeonpool.email");
      if (saved === "true" && savedEmail) {
        setEmail(savedEmail);
        setRememberEmail(true);
      }
    } catch {
      // ignore storage errors (e.g., privacy mode)
    }
  }, []);

  // Keep storage in sync when email or rememberEmail changes
  useEffect(() => {
    try {
      if (rememberEmail) {
        localStorage.setItem("pigeonpool.rememberEmail", "true");
        localStorage.setItem("pigeonpool.email", email);
      } else {
        localStorage.setItem("pigeonpool.rememberEmail", "false");
        localStorage.removeItem("pigeonpool.email");
      }
    } catch {
      // ignore storage errors
    }
  }, [email, rememberEmail]);

  async function handleLogin(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    try {
      const payload = new LoginPayload({ email, password });
      await signIn(payload); // This triggers POST /api/auth/login
      navigate(returnTo, { replace: true });
  } catch (err) {
      const msg = err instanceof Error ? err.message : String(err ?? "");
      const isUnauthorized =
        msg.toLowerCase().includes("unauthorized") ||
        msg.toLowerCase().includes("invalid"); // in case backend returns INVALID_CREDENTIALS

      if (isUnauthorized) {
        setSnack({
          open: true,
          message: "Incorrect email or password. For a first sign-in or a new password, use Reset password below.",
          severity: "error",
        });
        setHighlightReset(true);
      } else {
        setSnack({
          open: true,
          message: msg || "An unexpected error occurred",
          severity: "error",
        });
        setHighlightReset(false);
      }
    } finally {
      setBusy(false);
    }
  }

  if (showResetForm) {
    return <PasswordResetRequestForm onClose={() => setShowResetForm(false)} />;
  }

  return (
    <Box
      sx={{
        width: "100%",
        minHeight: "100dvh",
        display: "flex",
        flexDirection: "column",
        background: (theme) =>
          `linear-gradient(180deg, ${alpha(theme.palette.primary.light, theme.palette.mode === "light" ? 0.18 : 0.12)} 0%, ${theme.palette.background.default} 420px)`,
      }}
    >
      <Box textAlign="center" sx={{ maxWidth: 400, mx: "auto", pt: 4, px: 3 }}>
        <Typography variant="h4" fontWeight={700} gutterBottom sx={{ color: "primary.main" }}>
          Pigeon Pool
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Homing in on the winning picks
        </Typography>
      </Box>

      <Box sx={{ width: "100%", maxWidth: 900, mx: "auto", px: 2, my: 2 }}>
        <Box
          sx={{
            width: "100%",
            height: { xs: 90, sm: 120, md: 140 },
            overflow: "hidden",
            borderRadius: 3,
          }}
        >
          <Box
            component="img"
            src="/signin.png"
            alt="Pigeons watching a football game"
            sx={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
          />
        </Box>
      </Box>

      <Paper
        elevation={4}
        sx={{
          maxWidth: 400,
          mx: "auto",
          my: 4,
          p: 3,
          borderRadius: 3,
          textAlign: "center",
        }}
      >
      {reason === "session_expired" ?
        <Alert severity="info" sx={{ mb: 2 }}>
          Your session timed out. Please sign in again.
        </Alert>
        :
        <Typography variant="body1" gutterBottom>Sign in to your account</Typography>
      }
      <Stack component="form" gap={2} onSubmit={handleLogin}>
        <TextField
          label="Email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          autoFocus
        />
        <TextField
          label="Password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          slotProps={{ htmlInput: { maxLength: PASSWORD_MAX_LENGTH } }}
          required
        />
        <Button type="submit" variant="contained" disabled={busy}>
          {busy ? "Signing in..." : "Sign In"}
        </Button>
        <FormControlLabel
          control={
            <Checkbox
              checked={rememberEmail}
              onChange={(e) => setRememberEmail(e.target.checked)}
              color="primary"
            />
          }
          label="Remember my email on this device"
          sx={{ alignSelf: "flex-start", mt: -1 }}
        />
      </Stack>

      <AppSnackbar
        open={snack.open}
        message={snack.message}
        severity={snack.severity}
        onClose={() => setSnack((s) => ({ ...s, open: false }))}
      />

      <Box mt={2}>
        <Typography
          variant={highlightReset ? "body1" : "body2"}
          fontWeight={highlightReset ? 700 : 400}
          sx={(theme) => highlightReset ? { transition: 'all 0.2s', p: 1, borderRadius: 1, bgcolor: alpha(theme.palette.error.main, 0.1) } : {}}
        >
          Forgot your password?{' '}
          <Link
            href="#"
            underline="hover"
            onClick={e => { e.preventDefault(); setShowResetForm(true); }}
          >
            Reset password
          </Link>
        </Typography>
      </Box>
      </Paper>

      {installPlatform && (
        <Alert
          severity="warning"
          sx={{
            width: "calc(100% - 32px)",
            maxWidth: 600,
            mx: "auto",
            mt: "auto",
            mb: `max(16px, env(safe-area-inset-bottom))`,
            bgcolor: (theme) => alpha(theme.palette.primary.main, theme.palette.mode === "light" ? 0.1 : 0.18),
            border: 1,
            borderColor: "primary.main",
            color: "text.primary",
            "& .MuiAlert-icon": { color: "primary.main" },
          }}
        >
          <Typography variant="body2">
            For a better user experience, install this app to your Home Screen.
          </Typography>
          <Box component="ol" sx={{ my: 0.5, pl: 2.5 }}>
            <Typography component="li" variant="body2" sx={{ mb: 0.5 }}>
              {installPlatform === "ios" ? (
              <>
                Tap the Share icon (<IosShareIcon titleAccess="Share icon" sx={{ fontSize: "1.1rem", verticalAlign: "text-bottom" }} />), then tap Add to Home Screen.
              </>
            ) : (
              <>
                Tap the Menu icon (<MoreVertIcon titleAccess="Menu icon" sx={{ fontSize: "1.1rem", verticalAlign: "text-bottom" }} />) on the upper right, then tap Add to Home screen or Install app.
              </>
              )}
            </Typography>
            <Typography component="li" variant="body2">
              After it’s installed, tap the app icon on your Home Screen to launch the app.
            </Typography>
          </Box>
        </Alert>
      )}
    </Box>
  );
}

