/**
 * Year-to-date (client-computed from /results/leaderboard)
 */

import { useEffect, useMemo, useState } from "react";
import { Box, Stack, Typography, Alert, Button } from "@mui/material";
import {
  AppSnackbar,
  PrintArea,
} from "../components/CommonComponents";
import type { Severity } from "../components/CommonComponents";

import { DataGridLite } from "../components/DataGridLite";
import type { ColumnDef } from "../components/DataGridLite";

import { useAuth } from "../auth/useAuth";
import { useYtd } from "../hooks/useYtd";
import type { YtdRow } from "../hooks/useYtd";


export default function YtdPage() {
  const { state } = useAuth();
  const { rows, weeks, loading, error } = useYtd();
  const [snack, setSnack] = useState({ open: false, message: "", severity: "info" as Severity });

  // surface hook errors in the snackbar if you like
  useEffect(() => {
    if (error) setSnack({ open: true, message: error, severity: "error" });
  }, [error]);

  const columns: ColumnDef<YtdRow>[] = useMemo(() => {
    // Precompute tie counts for YEAR (yearRankPts) and RANK (yearRankRet)
    const ptsCounts = new Map<number, number>();
    const retCounts = new Map<number, number>();
    for (const r of rows) {
      ptsCounts.set(r.yearRankPts, (ptsCounts.get(r.yearRankPts) ?? 0) + 1);
      retCounts.set(r.yearRankRet, (retCounts.get(r.yearRankRet) ?? 0) + 1);
    }
    const cols: ColumnDef<YtdRow>[] = [
      {
        key: "pigeon",
        header: "Pigeon",
        pin: "left",
        valueGetter: (r) => r.pigeon_number,
        renderCell: (r) => `${r.pigeon_number} ${r.pigeon_name}`,
      },
    ];

    for (const w of weeks) {
      cols.push({
        key: `w_${w}`,
        header: `W${w}`,
        align: "left",
        valueGetter: (r) => r.byWeek[w]?.points ?? null,
        renderCell: (r) => {
          const points = r.byWeek[w]?.points;
          if (typeof points === "number") {
            const allPoints = weeks
              .map(ww => r.byWeek[ww]?.points)
              .filter((p): p is number => typeof p === "number");
            const isExcluded = allPoints.length >= 2 && points === Math.max(...allPoints);
            return `${points.toFixed(1)}${isExcluded ? "*" : ""}`;
          }
          return "—";
        },
        info: `Points for week ${w} (* = excluded from POINTS)`,
      });
    }

    cols.push(
      { key: "pointsAdj",  header: "POINTS", align: "left",
        valueGetter: (r) => r.pointsAdj, renderCell: (r) => r.pointsAdj.toFixed(1),
        info: "Total weekly position points, excluding the worst week (*)" },
      { key: "yearRankPts", header: "YEAR",   align: "left",
        valueGetter: (r) => r.yearRankPts, renderCell: (r) => {
          const val = r.yearRankPts;
          const tie = (ptsCounts.get(val) ?? 0) > 1;
          const star = val >= 1 && val <= 5 ? "*" : "";
          return `${tie ? "T" : ""}${val}${star}`;
        },
        info: "Ranking for year based on total points (T=Tie, *=Top 5)" },
      { key: "top5",        header: "TOP",    align: "left",
        valueGetter: (r) => r.top5, renderCell: (r) => String(r.top5),
        info: "Number of weekly finishes in the top five" },
      { key: "returnTotal", header: "RETURN", align: "left",
        valueGetter: (r) => r.returnTotal, renderCell: (r) => r.returnTotal.toFixed(2),
        info: "Total return, year-to-date" },
      { key: "yearRankRet", header: "RANK",   align: "left",
        valueGetter: (r) => r.yearRankRet, renderCell: (r) => {
          const val = r.yearRankRet;
          const tie = (retCounts.get(val) ?? 0) > 1;
          return `${tie ? "T" : ""}${val}`;
        },
        info: "Ranking for year based on total return (T=Tie)" },
    );

    return cols;
  }, [weeks, rows]);

  return (
    <Box>
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 2 }}>
        <Typography variant="body1" fontWeight="bold" sx={{ flex: 1, textAlign: "left" }}>Year to Date</Typography>
        <Box sx={{ flex: 1 }} />
        <Box sx={{ flex: 1, textAlign: "right" }}>
          <Button variant="outlined" onClick={() => window.print()}>Print</Button>
        </Box>
      </Stack>

      {loading ? (
        <Alert severity="info">Loading…</Alert>
      ) : (
        <PrintArea className="print-grid-area">
          <DataGridLite<YtdRow>
            rows={rows}
            columns={columns}
            defaultSort={{ key: "pigeon", dir: "asc" }}
            printTitle="Pigeon Pool — Year to Date"
            getRowId={(r) => r.pigeon_number}
            highlightRowId={state.status === "signedIn" ? state.user.pigeon_number : undefined}
            highlightExtraRowIds={state.status === "signedIn" ? state.user.alternates.map(a => a.pigeon_number) : undefined}
          />
        </PrintArea>
      )}

      <AppSnackbar
        open={snack.open}
        message={snack.message}
        severity={snack.severity}
        onClose={() => setSnack(s => ({ ...s, open: false }))}
      />
    </Box>
  );
}
