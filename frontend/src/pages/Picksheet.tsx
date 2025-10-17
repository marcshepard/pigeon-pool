/**
 * Show picks and results
 */

import { useEffect, useMemo, useState } from "react";
import { Box, Stack, Typography, Alert, Button, MenuItem, Select, FormControl, InputLabel } from "@mui/material";
import { AppSnackbar, PickCell, PrintOnlyStyles, PrintArea, PrintGridStyles } from "../components/CommonComponents";
import type { Severity } from "../components/CommonComponents";
import { DataGridLite } from "../components/DataGridLite";
import type { ColumnDef } from "../components/DataGridLite";
import { useAuth } from "../auth/useAuth";
import { useResults, type ResultsRow } from "../hooks/useResults";
import { useSchedule } from "../hooks/useSchedule";

export default function PicksheetPage() {
  const { state } = useAuth();
  const { lockedWeeks } = useSchedule();
  const [week, setWeek] = useState<number | null>(null);
  const [snack, setSnack] = useState({ open: false, message: "", severity: "info" as Severity });

  // choose default week when lockedWeeks loaded
  useEffect(() => {
    if (week == null && lockedWeeks.length) {
      setWeek(lockedWeeks[lockedWeeks.length - 1]);
    }
  }, [lockedWeeks, week]);

  // Cache-backed data for the selected week
  const { rows, games, weekState, consensusRow, loading, error } = useResults(week);

  useEffect(() => {
    if (error) setSnack({ open: true, message: error, severity: "error" });
  }, [error]);

  // Always bring the highlighted user row into view when rows or week change
  useEffect(() => {
    if (state.status !== "signedIn") return;
    if (!rows.length) return;
    const el = document.querySelector('.user-row');
    if (el instanceof HTMLElement) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [rows, state.status, week]);

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

    if (weekState !== "not started") {
      cols.push({
        key: "points",
        header: "Score",
        align: "left",
        valueGetter: (r) => (r.points ?? Number.POSITIVE_INFINITY),
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
      if (weekState !== "not started") {
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
              <Box component="span" sx={{ display: "block", fontSize: ".85em", fontWeight: 400, color: "text.secondary" }}>
                {subLabel}
              </Box>
            )}
          </Box>
        ),
        align: "left",
        sortable: true,
        valueGetter: (r) => r.picks[key]?.signed ?? 0,
        renderCell: (r) => {
          const cell = r.picks[key];
          return cell ? <PickCell label={cell.label} signed={cell.signed} /> : "—";
        },
      });
    }

    return cols;
  }, [games, weekState]);

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
                : weekState === "completed"
                  ? "Final results"
                  : weekState === "not started"
                    ? "Picks"
                    : "Partial results"}
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
            {weekState !== "not started" && 
              <Typography variant="body1" sx={{ mb: 1 }}>
                Numbers in parentheses indicate the player's score for each completed game. For example, you would see "PHI 3 (4)" if Phil was picked to win by 3 and won by 7.
              </Typography>
            }
            <PrintArea className="print-grid-area">
              <DataGridLite<ResultsRow>
                key={`grid-${weekState}`}
                rows={rows}
                columns={columns}
                pinnedTopRows={[]}
                pinnedBottomRows={
                  consensusRow ? [consensusRow] : []
                }
                defaultSort={
                  weekState === "not started"
                    ? { key: "pigeon_name", dir: "asc" }
                    : { key: "points", dir: "asc" }
                }
                printTitle={`Results — Week ${week ?? ""}`}
                getRowId={(r) => r.pigeon_number}
                highlightRowId={state.status === "signedIn" ? state.user.pigeon_number : undefined}
                autoScrollHighlightOnSort
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
