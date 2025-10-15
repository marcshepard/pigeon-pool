/**
 * Common reusable components for forms and UI elements.
 */

import type { ReactNode } from "react";
import { useState } from "react";

import {
  Alert,
  Box,
  Button,
  CircularProgress,
  GlobalStyles,
  IconButton,
  InputAdornment,
  Paper,
  Snackbar,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import type { BoxProps } from "@mui/material";
import type { SxProps, Theme } from "@mui/material/styles";
import { alpha } from "@mui/material/styles";
import Dialog from "@mui/material/Dialog";
import DialogTitle from "@mui/material/DialogTitle";
import DialogContent from "@mui/material/DialogContent";
import DialogActions from "@mui/material/DialogActions";

import Visibility from "@mui/icons-material/Visibility";
import VisibilityOff from "@mui/icons-material/VisibilityOff";

// Centralized print styles for grids (striping, user row, fit, portrait)
export function PrintGridStyles() {
  return (
    <GlobalStyles
      styles={{
        '@media print': {
          '.striped-row td, .striped-row th': {
            backgroundColor: '#f5f5f5 !important',
            WebkitPrintColorAdjust: 'exact',
            printColorAdjust: 'exact',
          },
          '.user-row td, .user-row th': {
            backgroundColor: '#ffe082 !important',
            WebkitPrintColorAdjust: 'exact',
            printColorAdjust: 'exact',
          },
          '.print-grid-area': {
            width: '100vw',
            maxWidth: '100vw',
            overflow: 'visible',
          },
          '@page': {
            size: 'portrait',
            margin: '0.5in',
          },
          '.no-print': { display: 'none !important' },
        },
      }}
    />
  );
}

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
export type Severity = "success" | "error" | "info" | "warning";
export function AppSnackbar(props: {
  open: boolean;
  message: string;
  severity?: Severity;
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
 * Banner – subtle inline message with a colored left border and soft background.
 * Use instead of MUI Alert for a cleaner, flatter look inline with the page.
 */
export function Banner({
  severity = "info",
  children,
  sx,
}: {
  severity?: Severity;
  children: ReactNode;
  sx?: SxProps<Theme>;
}) {
  const baseSx: SxProps<Theme> = (theme) => {
    const color = theme.palette[severity].main;
    return {
      p: 1.25,
      px: 2,
      borderLeftWidth: 4,
      borderLeftStyle: "solid",
      borderLeftColor: color,
      backgroundColor: alpha(color, 0.06),
    };
  };
  return (
    <Paper variant="outlined" sx={sx ? [baseSx, sx] as SxProps<Theme> : baseSx}>
      <Typography variant="body2">{children}</Typography>
    </Paper>
  );
}

/**
 * ConfirmDialog – simple confirmation dialog with title, body, and actions.
 */
export function ConfirmDialog({
  open,
  title = "Confirm",
  content,
  confirmText = "Confirm",
  cancelText = "Cancel",
  onConfirm,
  onClose,
}: {
  open: boolean;
  title?: string;
  content: ReactNode;
  confirmText?: string;
  cancelText?: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>{title}</DialogTitle>
      <DialogContent>
        <Typography variant="body2" sx={{ mt: 0.5 }}>{content}</Typography>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} color="inherit">{cancelText}</Button>
        <BusyButton onClick={onConfirm} variant="contained">{confirmText}</BusyButton>
      </DialogActions>
    </Dialog>
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

export function PickCell({
  label,
}: {
  label: string;
  signed: number;
  max?: number;
}) {
  return (
    <Box sx={{ position: "relative", display: "inline-block", minWidth: 70 }}>
      {/* Removed colored bar background */}
      <Box sx={{ position: "relative", textAlign: "left", fontVariantNumeric: "tabular-nums" }}>
        {label}
      </Box>
    </Box>
  );
}

/**
 * Components for printing just parts of a page
 */

/**
 * Injects global CSS so only elements inside `.print-area` are printed.
 * Options let you tweak paper orientation and margins per page.
 */
export function PrintOnlyStyles({
  areaClass = "print-area",
  landscape = true,
  margin = "10mm",
}: {
  areaClass?: string;
  landscape?: boolean;
  margin?: string;
}) {
  // Keep selectors dynamic so you can change the class if needed
  const areaSel = `.${areaClass}`;
  return (
    <GlobalStyles
      styles={{
        "@media print": {
          "body *": { visibility: "hidden" },
          [`${areaSel}, ${areaSel} *`]: { visibility: "visible" },
          [areaSel]: { position: "absolute", left: 0, top: 0, width: "100%" },
          "@page": { size: landscape ? "landscape" : "auto", margin },
        },
      }}
    />
  );
}

/**
 * Convenience wrapper that applies the correct class to the content that should print.
 * Use together with <PrintOnlyStyles/>.
 */
export function PrintArea({
  className,
  areaClass = "print-area",
  ...props
}: BoxProps & { areaClass?: string }) {
  const cls = className ? `${areaClass} ${className}` : areaClass;
  return <Box className={cls} {...props} />;
}