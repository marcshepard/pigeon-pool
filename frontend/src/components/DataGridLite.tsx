/**
 * DataGridLite lite component, sortable table with pinned columns
 */

import { useMemo, useState, useEffect } from "react";
import type { ReactNode } from "react";
import { Box, Table, TableHead, TableRow, TableCell, TableBody } from "@mui/material";

export type ColumnDef<T> = {
  key: string;
  header: ReactNode;
  width?: number | string;
  align?: "left" | "center" | "right";
  sortable?: boolean;                   // default true
  valueGetter?: (row: T) => unknown;    // used for sorting
  renderCell?: (row: T) => ReactNode;
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

  const orderedCols = useMemo(() => {
    const left = columns.filter(c => c.pin === "left");
    const mid  = columns.filter(c => !c.pin);
    const right= columns.filter(c => c.pin === "right");
    return [...left, ...mid, ...right];
  }, [columns]);

  // Ensure default sort applies once the desired column exists
  useEffect(() => {
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
//
}
