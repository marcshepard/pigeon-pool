/**
 * Common reusable components for forms and UI elements.
 */

import type { ReactNode } from "react";
import React, { useMemo, useState } from "react";

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
  Table,
  TableHead,
  TableRow,
  TableCell,
  TableBody,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";

import ArrowUpwardIcon from "@mui/icons-material/ArrowUpward";
// components/PickCell.tsx

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

/**
 * Data grid for rendering tabular data; sortable, printable
 */
// components/DataGridLite.tsx
export type ColumnDef<T> = {
  key: string;
  header: React.ReactNode;
  width?: number | string;
  align?: "left" | "center" | "right";
  sortable?: boolean;                   // default true
  valueGetter?: (row: T) => unknown;    // used for sorting
  renderCell?: (row: T) => React.ReactNode;
  sortComparator?: (a: unknown, b: unknown, rowA: T, rowB: T) => number;
  pin?: "left" | "right";
};

export type DataGridLiteProps<T> = {
  rows: T[];
  columns: ColumnDef<T>[];
  pinnedTopRows?: T[];
  defaultSort?: { key: string; dir: "asc" | "desc" };
  allowSort?: boolean;
  dense?: boolean;
  zebra?: boolean;
  emptyMessage?: string;
  printTitle?: string;
  /** Provide a stable id for rows to avoid using indices */
  getRowId?: (row: T, index: number) => string | number;
};

function defaultComparator(a: unknown, b: unknown) {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  const sa = String(a);
  const sb = String(b);
  return sa.localeCompare(sb);
}

export function DataGridLite<T>({
  rows,
  columns,
  pinnedTopRows = [],
  defaultSort,
  allowSort = true,
  dense = true,
  zebra = true,
  emptyMessage = "No rows",
  printTitle,
  getRowId,
}: DataGridLiteProps<T>) {
  const [sortKey, setSortKey] = useState<string | null>(defaultSort?.key ?? null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">(defaultSort?.dir ?? "asc");

  const orderedCols = React.useMemo(() => {
    const left = columns.filter(c => c.pin === "left");
    const mid  = columns.filter(c => !c.pin);
    const right= columns.filter(c => c.pin === "right");
    return [...left, ...mid, ...right];
  }, [columns]);

  const sortedRows = useMemo(() => {
    if (!allowSort || !sortKey) return rows;
    const col = orderedCols.find(c => c.key === sortKey);
    if (!col || !col.valueGetter) return rows; // no-op if not sortable
    const getVal = col.valueGetter;
    const cmp = col.sortComparator ?? defaultComparator;

    const result = [...rows].sort((ra, rb) => {
      const a = getVal(ra);
      const b = getVal(rb);
      const s = cmp(a, b, ra, rb);
      return sortDir === "asc" ? s : -s;
    });
    return result;
  }, [rows, sortKey, sortDir, allowSort, orderedCols]);

  const headerCell = (c: ColumnDef<T>) => {
    const isSorted = sortKey === c.key;
    const sortable = allowSort && (c.sortable ?? true) && !!c.valueGetter;
    return (
      <TableCell
        key={c.key}
        align={c.align ?? "left"}
        sx={{
          position: "sticky",
          top: 0,
          zIndex: 2,
          backgroundColor: "background.default",
          fontWeight: 600,
          width: c.width,
          minWidth: c.width,
          ...(c.pin === "left" ? { left: 0, zIndex: 3 } : {}),
          ...(c.pin === "right" ? { right: 0, zIndex: 3 } : {}),
        }}
        aria-sort={isSorted ? (sortDir === "asc" ? "ascending" : "descending") : "none"}
      >
        <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
          <Box component="span">{c.header}</Box>
          {sortable && (
            <Tooltip title={isSorted ? `Sorted ${sortDir}` : "Sort"}>
              <IconButton
                size="small"
                onClick={() => {
                  if (!isSorted) {
                    setSortKey(c.key);
                    setSortDir("asc");
                  } else {
                    setSortDir(d => (d === "asc" ? "desc" : "asc"));
                  }
                }}
                aria-label="sort"
                sx={{ ml: 0.5 }}
              >
                <ArrowUpwardIcon
                  fontSize="inherit"
                  sx={{
                    transform: `rotate(${isSorted && sortDir === "desc" ? 180 : 0}deg)`,
                    transition: "transform .15s",
                    opacity: 0.9,
                  }}
                />
              </IconButton>
            </Tooltip>
          )}
        </Box>
      </TableCell>
    );
  };

  const renderRow = (row: T, idx: number, pinned?: "top") => {
    const bg = zebra && !pinned ? (idx % 2 === 0 ? "background.paper" : "action.hover") : "background.paper";
    const key = getRowId ? getRowId(row, idx) : idx;
    return (
      <TableRow key={key} sx={{ backgroundColor: bg }}>
        {orderedCols.map((c) => (
          <TableCell
            key={c.key}
            align={c.align ?? "left"}
            sx={{
              position: (c.pin ? "sticky" : "static"),
              left: c.pin === "left" ? 0 : undefined,
              right: c.pin === "right" ? 0 : undefined,
              zIndex: c.pin ? 1 : 0,
              backgroundColor: c.pin ? "background.paper" : undefined,
              width: c.width,
              minWidth: c.width,
              whiteSpace: "nowrap",
            }}
          >
            {c.renderCell ? c.renderCell(row) : ""}
          </TableCell>
        ))}
      </TableRow>
    );
  };

  return (
    <Box
      className="print-container"
      sx={{
        border: 1,
        borderColor: "divider",
        borderRadius: 2,
        overflow: "auto",
        maxHeight: "75vh",
        ".print-hide": { "@media print": { display: "none !important" } },
        "@media print": {
          border: "none",
          maxHeight: "unset",
          overflow: "visible",
        },
      }}
    >
      {printTitle && (
        <Box className="print-only" sx={{ display: "none", "@media print": { display: "block", mb: 1 } }}>
          <strong>{printTitle}</strong>
        </Box>
      )}
      <Table size={dense ? "small" : "medium"} stickyHeader>
        <TableHead>
          <TableRow>{orderedCols.map(headerCell)}</TableRow>
        </TableHead>
        <TableBody>
          {pinnedTopRows.map((r, i) => renderRow(r, i, "top"))}
          {sortedRows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={orderedCols.length} align="center">
                {emptyMessage}
              </TableCell>
            </TableRow>
          ) : (
            sortedRows.map((r, i) => renderRow(r, i + pinnedTopRows.length))
          )}
        </TableBody>
      </Table>
    </Box>
  );
}

export function PickCell({
  label,
  signed,          // positive = home, negative = away
  max = 30,        // scale the bar length
  tooltip,
}: {
  label: string;
  signed: number;
  max?: number;
  tooltip?: string;
}) {
  const pct = Math.min(1, Math.abs(signed) / max);
  return (
    <Tooltip title={tooltip ?? label}>
      <Box sx={{ position: "relative", display: "inline-block", minWidth: 70 }}>
        <Box
          sx={{
            position: "absolute",
            top: "50%",
            left: "50%",
            height: 6,
            width: `${pct * 100}%`,
            transform: `translate(${signed >= 0 ? "0" : "-100"}%, -50%)`,
            backgroundColor: signed >= 0 ? "success.light" : "error.light",
            opacity: 0.4,
            borderRadius: 1,
          }}
        />
        <Box sx={{ position: "relative", textAlign: "center", fontVariantNumeric: "tabular-nums" }}>
          {label}
        </Box>
      </Box>
    </Tooltip>
  );
}
