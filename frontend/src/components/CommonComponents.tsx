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
  GlobalStyles,
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
import type { BoxProps } from "@mui/material";

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

  // Ensure default sort applies once the desired column exists
  React.useEffect(() => {
    const hasCurrent = sortKey && orderedCols.some(c => c.key === sortKey);
    const wantKey = defaultSort?.key ?? null;
    const wantDir = defaultSort?.dir ?? "asc";

    if (!hasCurrent && wantKey && orderedCols.some(c => c.key === wantKey)) {
      setSortKey(wantKey);
      setSortDir(wantDir);
    }
  }, [orderedCols, sortKey, defaultSort?.key, defaultSort?.dir]);

  const sortedRows = useMemo(() => {
    if (!allowSort || !sortKey) return rows;
    const col = orderedCols.find(c => c.key === sortKey);
    if (!col || !col.valueGetter) return rows;
    const getVal = col.valueGetter;
    const cmp = col.sortComparator ?? defaultComparator;

    return [...rows].sort((ra, rb) => {
      const a = getVal(ra);
      const b = getVal(rb);
      const s = cmp(a, b, ra, rb);
      return sortDir === "asc" ? s : -s;
    });
  }, [rows, sortKey, sortDir, allowSort, orderedCols]);

  const headerCell = (c: ColumnDef<T>) => {
    const isSorted = sortKey === c.key;
    const sortable = allowSort && (c.sortable ?? true) && !!c.valueGetter;

    const caret = isSorted ? (sortDir === "asc" ? "^" : "v") : "";

    const onToggle = () => {
      if (!sortable) return;
      if (!isSorted) {
        setSortKey(c.key);
        setSortDir("asc");
      } else {
        setSortDir((d) => (d === "asc" ? "desc" : "asc"));
      }
    };

    return (
      <TableCell
        key={c.key}
        align={c.align ?? "left"}
        component="th"
        scope="col"
        onClick={onToggle}
        onKeyDown={(e) => {
          if (!sortable) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggle();
          }
        }}
        tabIndex={sortable ? 0 : -1}
        sx={{
          position: "sticky",
          top: 0,
          zIndex: 2,
          backgroundColor: "background.default",
          fontWeight: 600,
          cursor: sortable ? "pointer" : "default",
          userSelect: "none",
          px: 0.5,
          py: 0.25,
          whiteSpace: "nowrap",
          ...(c.width ? { width: c.width, minWidth: c.width } : {}),
          ...(c.pin === "left"  && { left: 0,  zIndex: 5, boxShadow: "inset -1px 0 0 rgba(0,0,0,0.12)" }),
          ...(c.pin === "right" && { right: 0, zIndex: 5, boxShadow: "inset  1px 0 0 rgba(0,0,0,0.12)" }),
        }}
        aria-sort={isSorted ? (sortDir === "asc" ? "ascending" : "descending") : "none"}
      >
        <span>
          {c.header}
          {sortable && isSorted ? (
            <span
              style={{
                marginLeft: 4,
                fontSize: "1.05em",   // bump size; tweak to taste (e.g. 1.15em)
                fontWeight: 700,       // bold
                letterSpacing: "-0.02em",
                verticalAlign: "baseline",
                opacity: 0.95,
              }}
            >
              {caret}
            </span>
          ) : null}
        </span>
      </TableCell>
    );
  };

  const renderRow = (row: T, idx: number, pinned?: "top") => {
    // Even/odd zebra flag for body rows
    const isAlt = zebra && !pinned && idx % 2 === 1;
    const key = getRowId ? getRowId(row, idx) : idx;

    return (
      <TableRow key={key}>
        {orderedCols.map((c) => (
          <TableCell
            key={c.key}
            align={c.align ?? "left"}
            sx={{
              position: c.pin ? "sticky" : "static",
              left: c.pin === "left" ? 0 : undefined,
              right: c.pin === "right" ? 0 : undefined,
              zIndex: c.pin ? 1 : 0,

              // ✅ Use a SOLID background for zebra rows so pinned cells don't bleed
              // light: grey[100] approximates the usual hover overlay on paper
              // dark: grey[800]/[900] gives a subtle, solid alternate row
              backgroundColor: (theme) =>
                isAlt
                  ? (theme.palette.mode === "light"
                      ? theme.palette.grey[100]
                      : theme.palette.grey[800])
                  : theme.palette.background.paper,

              // widths only if provided
              ...(c.width ? { width: c.width, minWidth: c.width } : {}),

              // compact & no text bleed
              px: 0.5,
              py: 0.25,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",

              // keep pinned shadows; bg remains the SAME solid zebra color
              ...(c.pin === "left"  && { left: 0,  zIndex: 5, boxShadow: "inset -1px 0 0 rgba(0,0,0,0.12)" }),
              ...(c.pin === "right" && { right: 0, zIndex: 5, boxShadow: "inset  1px 0 0 rgba(0,0,0,0.12)" }),
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

        // Compactification
        "& .MuiTableRow-root": { height: "auto" },                 // no fixed row height
        "& .MuiTableCell-root": { px: 0.5, py: 0.25, lineHeight: 1.1, fontSize: "0.85rem" },
        "& .MuiTableCell-head": { fontSize: "0.85rem", fontWeight: 600, lineHeight: 1.1 },
        "& .MuiIconButton-root": { p: 0.25 },                      // shrink sort button padding
        "& .MuiSvgIcon-root": { fontSize: "0.9rem" },              // smaller sort chevron

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

      <Table
        size={dense ? "small" : "medium"}
        stickyHeader
        sx={{ tableLayout: "auto" }}
      >
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