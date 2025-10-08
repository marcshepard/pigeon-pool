import { useState } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { Box, Button, Stack, TextField, Typography, Alert } from "@mui/material";
import { apiConfirmPasswordReset } from "../backend/fetch";
import type { PasswordResetConfirm } from "../backend/types";

export default function PasswordResetConfirmPage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const token = searchParams.get("token") || "";

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    if (!token) {
      setError("Missing or invalid reset token.");
      return;
    }
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    setBusy(true);
    try {
      const payload: PasswordResetConfirm = { token, new_password: password };
      await apiConfirmPasswordReset(payload);
      setSuccess(true);
    } catch {
      setError("Reset failed. The link may have expired or is invalid.");
    } finally {
      setBusy(false);
    }
  }

  if (success) {
    return (
      <Box sx={{ maxWidth: 400, mx: "auto", mt: 2, p: 3, textAlign: "center" }}>
        <Alert severity="success" sx={{ mb: 2 }}>
          Your password has been reset. You may now sign in with your new password.
        </Alert>
        <Button variant="contained" onClick={() => navigate("/login")}>Go to Login</Button>
      </Box>
    );
  }

  return (
    <Box sx={{ maxWidth: 400, mx: "auto", mt: 2, p: 3, textAlign: "center" }}>
      <Typography variant="h5" gutterBottom>Set a New Password</Typography>
      <Typography variant="body2" gutterBottom>
        Enter your new password below. Password must be at least 8 characters.
      </Typography>
      <Stack component="form" gap={2} onSubmit={handleSubmit}>
        <TextField
          label="New Password"
          type="password"
          value={password}
          onChange={e => setPassword(e.target.value)}
          required
          autoFocus
        />
        <TextField
          label="Confirm Password"
          type="password"
          value={confirm}
          onChange={e => setConfirm(e.target.value)}
          required
        />
        <Button type="submit" variant="contained" disabled={busy}>
          {busy ? "Resetting..." : "Reset Password"}
        </Button>
      </Stack>
      {error && <Alert severity="error" sx={{ mt: 2 }}>{error}</Alert>}
    </Box>
  );
}
