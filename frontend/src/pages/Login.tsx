/**
 * Login page component.
 */

// src/pages/Login.tsx
import { useState } from "react";
import { Box, Button, Stack, TextField, Typography, Link } from "@mui/material";
import { AppSnackbar } from "../components/CommonComponents";
import PasswordResetRequestForm from "./PasswordResetRequestForm";
import { useAuth } from "../auth/useAuth";
import { LoginPayload } from "../backend/types";
import { useNavigate } from "react-router-dom";

export default function LoginPage() {
  const { signIn } = useAuth();  // pulls in apiLogin via context
  const navigate = useNavigate();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  const [snack, setSnack] = useState({
    open: false,
    message: "",
    severity: "info" as "success" | "error" | "info" | "warning",
  });
  const [showReset, setShowReset] = useState(false);
  const [showResetForm, setShowResetForm] = useState(false);

  async function handleLogin(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    try {
      const payload = new LoginPayload({ email, password });
      await signIn(payload); // <-- this triggers POST /api/auth/login
      navigate("/", { replace: true });
  } catch (err) {
      // Check for 401 Unauthorized (invalid login)
      let status: unknown = undefined;
      let message: unknown = undefined;
      if (typeof err === "object" && err !== null) {
        if ("status" in err) status = (err as { status?: unknown }).status;
        if ("message" in err) message = (err as { message?: unknown }).message;
      }
      if (status === 401 || (typeof message === "string" && message.toLowerCase().includes("401"))) {
        setSnack({
          open: true,
          message: "Incorrect email or password. Please try again.",
          severity: "error",
        });
        setShowReset(true);
      } else {
        const fallback = err instanceof Error ? err.message : "An unexpected error occurred";
        setSnack({ open: true, message: fallback, severity: "error" });
        setShowReset(false);
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
      <Typography variant="body1" gutterBottom>Sign in to your account</Typography>
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

      {showReset && (
        <Box mt={2}>
          <Typography variant="body2" color="text.secondary">
            Forgot your password?{' '}
            <Link href="#" underline="hover" onClick={e => { e.preventDefault(); setShowResetForm(true); }}>
              Reset password
            </Link>
          </Typography>
        </Box>
      )}
    </Box>
  );
}

