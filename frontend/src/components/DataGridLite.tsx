/**
 * DataGridLite lite component, sortable table with pinned columns
 */

import { useMemo, useState, useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { Box, Table, TableHead, TableRow, TableCell, TableBody } from "@mui/material";
import TableSortLabel from "@mui/material/TableSortLabel";
import type { Theme } from "@mui/material/styles";

import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import IconButton from "@mui/material/IconButton";
import { InfoPopover } from "./CommonComponents";

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
  info?: ReactNode; // Optional info/hint for header
  /** When true, null/undefined values always sort to the bottom regardless of sort direction */
  nullsLastAlways?: boolean;
};

export type DataGridLiteProps<T> = {
  rows: T[];
  columns: ColumnDef<T>[];
  pinnedTopRows?: T[];
  pinnedBottomRows?: T[];
  defaultSort?: { key: string; dir: "asc" | "desc" };
  allowSort?: boolean;
  dense?: boolean;
  zebra?: boolean; // when true, alternate row backgrounds
  emptyMessage?: string;
  printTitle?: string;
  /** Provide a stable id for rows to avoid using indices */
  getRowId?: (row: T, index: number) => string | number;
  /** If provided, the row with this id will be highlighted */
  highlightRowId?: string | number;
  /** Additionally highlight these rows (e.g., alternates); does not auto-scroll */
  highlightExtraRowIds?: Array<string | number>;
  /** When true, automatically scroll the highlighted row into view after sort changes */
  autoScrollHighlightOnSort?: boolean;
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
  pinnedBottomRows = [],
  defaultSort,
  allowSort = true,
  dense = true,
  zebra = true,
  emptyMessage = "No rows",
  printTitle,
  getRowId,
  highlightRowId,
  highlightExtraRowIds,
  autoScrollHighlightOnSort = false,
}: DataGridLiteProps<T>) {
  const extraIdsSet = useMemo(() => new Set(highlightExtraRowIds ?? []), [highlightExtraRowIds]);
  const [sortKey, setSortKey] = useState<string | null>(defaultSort?.key ?? null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">(defaultSort?.dir ?? "asc");
  const containerRef = useRef<HTMLDivElement | null>(null);

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

  // Re-apply default sort whenever it changes and the target column exists.
  // Won't clobber user-chosen sort unless defaultSort itself changes.
  const defKey = defaultSort?.key ?? null;
  const defDir = defaultSort?.dir ?? "asc";
    useEffect(() => {
    const hasCurrent = sortKey && orderedCols.some(c => c.key === sortKey);
    if (!hasCurrent && defKey && orderedCols.some(c => c.key === defKey)) {
      setSortKey(defKey);
      setSortDir(defDir);
    }
  }, [orderedCols, sortKey, defKey, defDir]);
  useEffect(() => {
    if (!defKey) return;
    const hasTarget = orderedCols.some(c => c.key === defKey);
    const differs = sortKey !== defKey || sortDir !== defDir;
    if (hasTarget && differs) {
      setSortKey(defKey);
      setSortDir(defDir);
    }
  }, [defKey, defDir, orderedCols, sortKey, sortDir]);


  const sortedRows = useMemo(() => {
    if (!allowSort || !sortKey) return rows;
    const col = orderedCols.find(c => c.key === sortKey);
    if (!col || !col.valueGetter) return rows;
    const getVal = col.valueGetter;
    const cmp = col.sortComparator ?? defaultComparator;

    return [...rows].sort((ra, rb) => {
      const a = getVal(ra);
      const b = getVal(rb);

      if (col.nullsLastAlways && (a == null || b == null)) {
        // Always push nulls/undefined to bottom regardless of direction
        if (a == null && b == null) return 0;
        if (a == null) return 1;
        if (b == null) return -1;
      }

      const s = cmp(a, b, ra, rb);
      return sortDir === "asc" ? s : -s;
    });
  }, [rows, sortKey, sortDir, allowSort, orderedCols]);

  // When sorting changes, optionally scroll the highlighted row into view
  useEffect(() => {
    if (!autoScrollHighlightOnSort) return;
    if (!containerRef.current) return;
    if (highlightRowId === undefined || highlightRowId === null) return;
    const el = containerRef.current.querySelector('.user-row');
    if (el instanceof HTMLElement) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [sortKey, sortDir, autoScrollHighlightOnSort, highlightRowId]);

  // State for info popover
  const [infoAnchor, setInfoAnchor] = useState<null | HTMLElement>(null);
  const [infoContent, setInfoContent] = useState<ReactNode>(null);

  const headerCell = (c: ColumnDef<T>) => {
    const isSorted = sortKey === c.key;
    const sortable = allowSort && (c.sortable ?? true) && !!c.valueGetter;

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
        sx={{
          position: "sticky",
          top: 0,
          zIndex: 10,
          fontWeight: 600,
          cursor: sortable ? "pointer" : "default",
          userSelect: "none",
          px: 0.5,
          py: 0.25,
          whiteSpace: "nowrap",
          backgroundColor: (theme) =>
            isSorted
              ? (theme.palette.mode === 'light'
                  ? theme.palette.grey[100]
                  : theme.palette.grey[900])
              : theme.palette.background.paper,
          ...(c.width ? { width: c.width, minWidth: c.width } : {}),
          ...(c.pin === "left"  && { left: 0,  zIndex: 12, boxShadow: "inset -1px 0 0 rgba(0,0,0,0.12)" }),
          ...(c.pin === "right" && { right: 0, zIndex: 12, boxShadow: "inset  1px 0 0 rgba(0,0,0,0.12)" }),
        }}
        aria-sort={isSorted ? (sortDir === "asc" ? "ascending" : "descending") : "none"}
      >
        <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
          {sortable ? (
            <TableSortLabel
              active={isSorted}
              direction={isSorted ? sortDir : 'asc'}
              onClick={(e) => {
                e.stopPropagation();
                onToggle();
              }}
              hideSortIcon={!isSorted}
            >
              {c.header}
            </TableSortLabel>
          ) : (
            <span>{c.header}</span>
          )}
          {c.info && (
            <IconButton
              size="small"
              className="print-hide"
              sx={{ ml: 0.25, p: 0.25 }}
              onClick={(e) => {
                e.stopPropagation();
                setInfoAnchor(e.currentTarget);
                setInfoContent(c.info);
              }}
              aria-label="Column info"
            >
              <InfoOutlinedIcon fontSize="small" />
            </IconButton>
          )}
        </Box>
      </TableCell>
    );
  };




  const renderRow = (row: T, idx: number) => {
    // Row key
    const key = getRowId ? getRowId(row, idx) : idx;

    // Determine row background (highlight takes precedence over zebra)
    const isHighlighted = highlightRowId !== undefined && highlightRowId !== null && key === highlightRowId;
    const isExtraHighlighted = !isHighlighted && extraIdsSet.has(key);
    const isAlt = zebra && !isHighlighted && (idx % 2 === 1);
    const rowBg = (theme: Theme) => {
      // Use yellow shades for better visibility
      if (isHighlighted) return "#fff59d"; // primary: brighter yellow (Yellow 200)
      if (isExtraHighlighted) return "#fff9c4"; // alternate: softer yellow (Yellow 100)
      if (isAlt) return theme.palette.mode === "light" ? theme.palette.grey[200] : theme.palette.grey[900];
      // Explicit solid background for non-striped, non-highlighted rows
      return theme.palette.background.paper;
    };

    const rowClass = isHighlighted
      ? "user-row"
      : isExtraHighlighted
        ? "alt-user-row"
        : isAlt
          ? "striped-row"
          : undefined;
    return (
      <TableRow
        key={key}
        className={rowClass}
        sx={{ backgroundColor: rowBg }}
      >
        {orderedCols.map((c) => (
          <TableCell
            key={c.key}
            align={c.align ?? "left"}
            className={rowClass}
            sx={{
              backgroundColor: rowBg,
              position: c.pin ? "sticky" : "static",
              left: c.pin === "left" ? 0 : undefined,
              right: c.pin === "right" ? 0 : undefined,
              // Body pinned cells should be above non-pinned body cells, but below headers
              zIndex: c.pin ? 2 : 1,
              ...(c.width ? { width: c.width, minWidth: c.width } : {}),
              px: 0.5,
              py: 0.25,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              ...(c.pin === "left"  && { left: 0,  zIndex: 2, boxShadow: "inset -1px 0 0 rgba(0,0,0,0.12)" }),
              ...(c.pin === "right" && { right: 0, zIndex: 2, boxShadow: "inset  1px 0 0 rgba(0,0,0,0.12)" }),
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
      ref={containerRef}
      sx={{
        border: 1,
        borderColor: "divider",
        borderRadius: 2,
        overflow: "auto",
        maxHeight: "75vh",

        "& .MuiTableRow-root": { height: "auto" },
        "& .MuiTableCell-root": { px: 0.5, py: 0.25, lineHeight: 1.1, fontSize: "0.85rem" },
        "& .MuiTableCell-head": { fontSize: "0.85rem", fontWeight: 600, lineHeight: 1.1 },
        "& .MuiIconButton-root": { p: 0.25 },
        "& .MuiSvgIcon-root": { fontSize: "0.9rem" },

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
          {pinnedTopRows.map((r, i) => renderRow(r, i))}
          {sortedRows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={orderedCols.length} align="center">
                {emptyMessage}
              </TableCell>
            </TableRow>
          ) : (
            sortedRows.map((r, i) => renderRow(r, i + pinnedTopRows.length))
          )}
          {pinnedBottomRows.map((r, i) => renderRow(r, i + pinnedTopRows.length + sortedRows.length))}
        </TableBody>
      </Table>

      <InfoPopover
        anchorEl={infoAnchor}
        onClose={() => setInfoAnchor(null)}
      >
        {infoContent}
      </InfoPopover>
    </Box>
  );
//
}
