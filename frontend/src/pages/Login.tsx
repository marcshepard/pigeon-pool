/**
 * Login page component.
 */

// src/pages/Login.tsx
import { useState } from "react";
import { Alert, Box, Button, Stack, TextField, Typography, Link } from "@mui/material";
import { AppSnackbar } from "../components/CommonComponents";
import PasswordResetRequestForm from "./PasswordResetRequestForm";
import { useAuth } from "../auth/useAuth";
import { LoginPayload } from "../backend/types";
import { useNavigate, useSearchParams } from "react-router-dom";

export default function LoginPage() {
  const { signIn } = useAuth();  // pulls in apiLogin via context
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const reason = searchParams.get("reason");
  const returnToParam = searchParams.get("returnTo") || "/";
  const returnTo = returnToParam.startsWith("/") ? returnToParam : "/";   // only allow same-origin relative paths

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  const [snack, setSnack] = useState({
    open: false,
    message: "",
    severity: "info" as "success" | "error" | "info" | "warning",
  });
  const [showResetForm, setShowResetForm] = useState(false);

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
          message: "Incorrect email or password. Please try again.",
          severity: "error",
        });
      } else {
        setSnack({
          open: true,
          message: msg || "An unexpected error occurred",
          severity: "error",
        });
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
      alignContent="flex-start"
      textAlign="center"
      sx={{ maxWidth: 400, mx: "auto", mt: 2, p: 3 }}
    >
      <Typography variant="h4" gutterBottom>Pigeon Pool</Typography>
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
          required
        />
        <Button type="submit" variant="contained" disabled={busy}>
          {busy ? "Signing in..." : "Sign In"}
        </Button>
      </Stack>

      <AppSnackbar
        open={snack.open}
        message={snack.message}
        severity={snack.severity}
        onClose={() => setSnack((s) => ({ ...s, open: false }))}
      />

      <Box mt={2}>
        <Typography variant="body2" color="text.secondary">
          Forgot your password?{' '}
          <Link href="#" underline="hover" onClick={e => { e.preventDefault(); setShowResetForm(true); }}>
            Reset password
          </Link>
        </Typography>
      </Box>
    </Box>
  );
}

