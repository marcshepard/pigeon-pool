/**
 * Show picks and results
 */

import { useEffect, useMemo, useState } from "react";
import { Box, Stack, Typography, Alert, Button, MenuItem, Select, FormControl, InputLabel, Checkbox, FormControlLabel } from "@mui/material";
import { AppSnackbar, PickCell, PrintOnlyStyles, PrintArea, PrintGridStyles, PointsText } from "../components/CommonComponents";
import type { Severity } from "../components/CommonComponents";
import { DataGridLite } from "../components/DataGridLite";
import type { ColumnDef } from "../components/DataGridLite";
import { useAuth } from "../auth/useAuth";
import { useResults, type ResultsRow } from "../hooks/useResults";
import { useSchedule } from "../hooks/useSchedule";

export default function PicksheetPage() {
  // Auto-scroll toggle state, persisted in localStorage
  const AUTO_SCROLL_KEY = "autoScrollToPicks";
  const [autoScroll, setAutoScroll] = useState(() => {
    const v = localStorage.getItem(AUTO_SCROLL_KEY);
    return v === null ? true : v === "true";
  });

  // Persist autoScroll to localStorage
  useEffect(() => {
    localStorage.setItem(AUTO_SCROLL_KEY, String(autoScroll));
  }, [autoScroll]);
  const { state } = useAuth();
  const { lockedWeeks } = useSchedule();
  const [ week, setWeek ] = useState<number | null>(null);
  const [ snack, setSnack ] = useState({ open: false, message: "", severity: "info" as Severity });

  // choose default week when lockedWeeks loaded
  useEffect(() => {
    if (week == null && lockedWeeks.length) {
      setWeek(lockedWeeks[lockedWeeks.length - 1]);
    }
  }, [lockedWeeks, week]);

  // Cache-backed data for the selected week
  const { rows, games, currentWeek, consensusRow, loading, error } = useResults(week);

  useEffect(() => {
    if (error) setSnack({ open: true, message: error, severity: "error" });
  }, [error]);

  // Always bring the highlighted user row into view when rows or week change
  useEffect(() => {
    if (!autoScroll) return;
    if (state.status !== "signedIn") return;
    if (!rows.length) return;
    const el = document.querySelector('.user-row');
    if (el instanceof HTMLElement) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [rows, state.status, week, autoScroll]);

  // Columns ----------------------------------------------------------
  const columns: ColumnDef<ResultsRow>[] = useMemo(() => {
    const cols: ColumnDef<ResultsRow>[] = [
      {
        key: "pigeon_name",
        header: "Pigeon",
        pin: "left",
        valueGetter: (r) => r.pigeon_number,
        renderCell: (r) => `${r.pigeon_number} ${r.pigeon_name}`,
      },
    ];

    if (currentWeek?.status !== "scheduled") {
      cols.push({
        key: "points",
        header: "Score",
        align: "left",
        // If user has no picks at all (points null), sort as 800 so they're bottom on asc
        // Display remains "—" for null
        valueGetter: (r) => (r.points == null ? 800 : r.points),
        renderCell: (r) => (r.points ?? "—"),
      });
      cols.push({
        key: "rank",
        header: "Rank",
        align: "left",
        valueGetter: (r) => (r.rank ?? Number.POSITIVE_INFINITY),
        renderCell: (r) => (r.rank ?? "—"),
      });
    }

    for (const g of games) {
      const key = `g_${g.game_id}`;
      // Build a sub-label under the matchup: Not started | Live: TEAM M | Final score
      // Only show when the week has started (i.e., not in "not started" state)
      let subLabel: string = "";
      if (currentWeek?.status !== "scheduled") {
        if (g.status === "scheduled") {
          subLabel = "Not started";
        } else if (g.status === "in_progress") {
          // Show running margin like finals but with Live: prefix
          if (g.home_score != null && g.away_score != null) {
            const signed = g.home_score - g.away_score; // +home, -away, 0 tie
            subLabel = signed === 0
              ? "Live: TIE 0"
              : `Live: ${signed >= 0 ? g.home_abbr : g.away_abbr} ${Math.abs(signed)}`;
          } else {
            subLabel = "Live";
          }
        } else if (g.status === "final" && g.home_score != null && g.away_score != null) {
          const signed = g.home_score - g.away_score; // +home, -away, 0 tie
          subLabel = signed === 0 ? "TIE 0" : `${signed >= 0 ? g.home_abbr : g.away_abbr} ${Math.abs(signed)}`;
        }
      }

      cols.push({
        key,
        header: (
          <Box sx={{ textAlign: "left", lineHeight: 1.15 }}>
            <Box>{g.away_abbr} @ {g.home_abbr}</Box>
            {subLabel && (
              <PointsText sx={{ display: "block" }}>{subLabel}</PointsText>
            )}
          </Box>
        ),
        align: "left",
        sortable: true,
        nullsLastAlways: true,
        // For sorting: treat no pick or placeholder 0 as missing (null)
        valueGetter: (r) => {
          const v = r.picks[key]?.signed;
          return (v == null || v === 0) ? null : v;
        },
        renderCell: (r) => {
          const cell = r.picks[key];
          return cell ? <PickCell label={cell.label} signed={cell.signed} /> : "—";
        },
      });
    }

    return cols;
  }, [games, currentWeek]);

  return (
    <>
      <PrintOnlyStyles areaClass="print-area" landscape margin="8mm" />
      <PrintGridStyles />

      <Box>
        <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 2 }}>
          {/* Week picker */}
          <Box flex={1} display="flex" alignItems="center">
            <FormControl size="small" disabled={lockedWeeks.length === 0}>
              <InputLabel>Week</InputLabel>
              <Select
                label="Week"
                value={lockedWeeks.length === 0 ? "" : week ?? ""}
                onChange={(e) => setWeek(Number(e.target.value))}
              >
                {lockedWeeks.map((w) => (
                  <MenuItem key={w} value={w}>Week {w}</MenuItem>
                ))}
              </Select>
            </FormControl>
          </Box>

          {/* Title */}
          <Box flex={1} display="flex" justifyContent="center" alignItems="center">
            <Typography variant="body1" fontWeight="bold">
              {week == null
                ? "Loading results…"
                : week == currentWeek?.week ? 
                  (currentWeek?.status === "final"
                    ? "Final results"
                    : currentWeek?.status === "scheduled"
                      ? "Picks"
                      : "Partial results")
                    : "Final results"
              }
            </Typography>
          </Box>

          {/* Print */}
          <Box flex={1} display="flex" justifyContent="flex-end" alignItems="center">
            <Button variant="outlined" onClick={() => window.print()}>Print</Button>
          </Box>
        </Stack>

        {loading ?
          <Alert severity="info">Loading…</Alert>
        : <>
            <FormControlLabel
              control={
                <Checkbox
                  checked={autoScroll}
                  onChange={e => setAutoScroll(e.target.checked)}
                  size="small"
                />
              }
              label={<Typography variant="body2">Auto-scroll to my picks</Typography>}
              sx={{ mr: 2, mb: 0 }}
            />
            <PrintArea className="print-grid-area">
              <DataGridLite<ResultsRow>
                key={`grid-${currentWeek}`}
                rows={rows}
                columns={columns}
                pinnedTopRows={[]}
                pinnedBottomRows={
                  consensusRow ? [consensusRow] : []
                }
                defaultSort={
                  currentWeek?.status === "scheduled"
                    ? { key: "pigeon_name", dir: "asc" }
                    : { key: "points", dir: "asc" }
                }
                printTitle={`Results — Week ${week ?? ""}`}
                getRowId={(r) => r.pigeon_number}
                highlightRowId={state.status === "signedIn" ? state.user.pigeon_number : undefined}
                autoScrollHighlightOnSort={autoScroll}
              />
            </PrintArea>
          </>
        }

        <AppSnackbar
          open={snack.open}
          message={snack.message}
          severity={snack.severity}
          onClose={() => setSnack((s) => ({ ...s, open: false }))}
        />
      </Box>
    </>
  );
}
