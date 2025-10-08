import { useState } from "react";
import { Box, Button, Stack, TextField, Typography, Alert } from "@mui/material";
import { apiRequestPasswordReset } from "../backend/fetch";
import type { PasswordResetRequest } from "../backend/types";

export default function PasswordResetRequestForm({ onClose }: { onClose?: () => void }) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const payload: PasswordResetRequest = { email };
      await apiRequestPasswordReset(payload);
      setSent(true);
    } catch {
      setError("There was a problem sending the reset email. Please try again later.");
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <Box sx={{ maxWidth: 400, mx: "auto", mt: 2, p: 3, textAlign: "center" }}>
        <Alert severity="success" sx={{ mb: 2 }}>
          If that email address is registered in Pigeon Pool, a password reset link has been sent. The link will be valid for 1 hour. Please check your spam folder if you don't see it.
        </Alert>
        {onClose && (
          <Button variant="outlined" onClick={onClose}>Back to Login</Button>
        )}
      </Box>
    );
  }

  return (
    <Box sx={{ maxWidth: 400, mx: "auto", mt: 2, p: 3, textAlign: "center" }}>
      <Typography variant="h5" gutterBottom>Reset Password</Typography>
      <Typography variant="body2" gutterBottom>
        Enter your email address and we'll send you a link to reset your password.
      </Typography>
      <Stack component="form" gap={2} onSubmit={handleSubmit}>
        <TextField
          label="Email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={e => setEmail(e.target.value)}
          required
          autoFocus
        />
        <Button type="submit" variant="contained" disabled={busy}>
          {busy ? "Sending..." : "Send Reset Link"}
        </Button>
      </Stack>
      {error && <Alert severity="error" sx={{ mt: 2 }}>{error}</Alert>}
      {onClose && (
        <Button variant="text" sx={{ mt: 2 }} onClick={onClose}>Back to Login</Button>
      )}
    </Box>
  );
}
