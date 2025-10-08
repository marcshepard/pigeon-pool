/**
 * Common reusable components for forms and UI elements.
 */

import { useState } from "react";
import type { ReactNode } from "react";
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  IconButton,
  InputAdornment,
  Paper,
  Snackbar,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import Visibility from "@mui/icons-material/Visibility";
import VisibilityOff from "@mui/icons-material/VisibilityOff";

export function FormCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Box sx={{ display: "grid", placeItems: "center", minHeight: "100dvh", p: 2 }}>
      <Paper sx={{ p: 3, width: "100%", maxWidth: 420 }} elevation={2}>
        <Stack gap={2}>
          <Typography variant="h5">{title}</Typography>
          {children}
        </Stack>
      </Paper>
    </Box>
  );
}

export function PasswordField({
  value,
  onChange,
  label = "Password",
  autoFocus = false,
}: {
  value: string;
  onChange: (v: string) => void;
  label?: string;
  autoFocus?: boolean;
}) {
  const [show, setShow] = useState(false);
  return (
    <TextField
      label={label}
      type={show ? "text" : "password"}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      autoComplete="current-password"
      autoFocus={autoFocus}
      InputProps={{
        endAdornment: (
          <InputAdornment position="end">
            <IconButton aria-label="toggle password visibility" onClick={() => setShow((s) => !s)} edge="end">
              {show ? <VisibilityOff /> : <Visibility />}
            </IconButton>
          </InputAdornment>
        ),
      }}
      required
    />
  );
}

export function BusyButton({
  children,
  loading,
  ...btnProps
}: { children: ReactNode; loading?: boolean } & Parameters<typeof Button>[0]) {
  return (
    <Button {...btnProps} disabled={loading || btnProps.disabled}>
      {loading && <CircularProgress size={18} sx={{ mr: 1 }} />}
      {children}
    </Button>
  );
}

export function ErrorAlert({ message }: { message: string | null }) {
  if (!message) return null;
  return <Alert severity="error" variant="outlined">{message}</Alert>;
}

/**
 * AppSnackbar – bottom snackbar with MUI Alert for success / error / info / warning
 */
export function AppSnackbar(props: {
  open: boolean;
  message: string;
  severity?: "success" | "error" | "info" | "warning";
  autoHideDuration?: number;
  onClose?: () => void;
}) {
  const { open, message, severity = "info", autoHideDuration = 4000, onClose } = props;

  return (
    <Snackbar
      open={open}
      onClose={onClose}
      autoHideDuration={autoHideDuration}
      anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
    >
      <Alert onClose={onClose} severity={severity} variant="filled" sx={{ width: "100%" }}>
        {message}
      </Alert>
    </Snackbar>
  );
}

/**
 * Loading – centered spinner by default; if `error` is provided, show an error message instead.
 */
export function Loading({ error }: { error?: string }) {
  if (error) {
    return (
      <Box sx={{ display: "grid", placeItems: "center", minHeight: "40vh", p: 2, textAlign: "center" }}>
        <Alert severity="error" variant="outlined">{error}</Alert>
      </Box>
    );
  }
  return (
    <Box sx={{ display: "grid", placeItems: "center", minHeight: "40vh", p: 2, textAlign: "center" }}>
      <CircularProgress />
      <Typography variant="body2" sx={{ mt: 1, color: "text.secondary" }}>
        Loading…
      </Typography>
    </Box>
  );
}