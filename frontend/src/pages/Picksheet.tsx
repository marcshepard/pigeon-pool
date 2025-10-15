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
  const { rows, games, weekState, consensusRow, resultRow, loading, error } = useResults(week);

  useEffect(() => {
    if (error) setSnack({ open: true, message: error, severity: "error" });
  }, [error]);

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
      cols.push({
        key,
        header: <Box sx={{ textAlign: "left" }}>{g.away_abbr} @ {g.home_abbr}</Box>,
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
                Bracketed numbers indicate points from completed games. For example, you might see "PHI 3 (4)" if they were picked by 3 and won by 7.
              </Typography>
            }
            <PrintArea className="print-grid-area">
              <DataGridLite<ResultsRow>
                rows={rows}
                columns={columns}
                pinnedTopRows={[]}
                pinnedBottomRows={
                  consensusRow && resultRow ? [consensusRow, resultRow]
                  : consensusRow ? [consensusRow]
                  : resultRow ? [resultRow]
                  : []
                }
                defaultSort={{ key: "pigeon_name", dir: "asc" }}
                printTitle={`Results — Week ${week ?? ""}`}
                getRowId={(r) => r.pigeon_number}
                highlightRowId={state.status === "signedIn" ? state.user.pigeon_number : undefined}
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
