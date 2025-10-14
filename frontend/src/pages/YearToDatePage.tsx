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

function Notes () {
  return (
    <Box sx={{ maxWidth: 600, mt: 4 }}>
      <Typography variant="body1" gutterBottom>
      Notes
      </Typography>
      <Box component="table" sx={{ width: "100%", borderCollapse: "collapse" }}>
      <tbody>
        <tr>
        <td style={{ fontWeight: "bold", padding: 4, borderBottom: "1px solid #ccc" }}>
          <Typography variant="body1" fontWeight="bold">WEEK *</Typography>
        </td>
        <td style={{ padding: 4, borderBottom: "1px solid #ccc" }}>
          <Typography variant="body1">Score for the week</Typography>
        </td>
        </tr>
        <tr>
        <td style={{ fontWeight: "bold", padding: 4, borderBottom: "1px solid #ccc" }}>
          <Typography variant="body1" fontWeight="bold">POINTS</Typography>
        </td>
        <td style={{ padding: 4, borderBottom: "1px solid #ccc" }}>
          <Typography variant="body1">Total weekly position points, minus worst week (x/o)</Typography>
        </td>
        </tr>
        <tr>
        <td style={{ fontWeight: "bold", padding: 4, borderBottom: "1px solid #ccc" }}>
          <Typography variant="body1" fontWeight="bold">YEAR</Typography>
        </td>
        <td style={{ padding: 4, borderBottom: "1px solid #ccc" }}>
          <Typography variant="body1">Ranking for year based on total points</Typography>
        </td>
        </tr>
        <tr>
        <td style={{ fontWeight: "bold", padding: 4, borderBottom: "1px solid #ccc" }}>
          <Typography variant="body1" fontWeight="bold">TOP</Typography>
        </td>
        <td style={{ padding: 4, borderBottom: "1px solid #ccc" }}>
          <Typography variant="body1">Number of weekly finishes in the top five (*/o)</Typography>
        </td>
        </tr>
        <tr>
        <td style={{ fontWeight: "bold", padding: 4, borderBottom: "1px solid #ccc" }}>
          <Typography variant="body1" fontWeight="bold">RETURN</Typography>
        </td>
        <td style={{ padding: 4, borderBottom: "1px solid #ccc" }}>
          <Typography variant="body1">Total return, year-to-date</Typography>
        </td>
        </tr>
        <tr>
        <td style={{ fontWeight: "bold", padding: 4 }}>
          <Typography variant="body1" fontWeight="bold">RANK</Typography>
        </td>
        <td style={{ padding: 4 }}>
          <Typography variant="body1">Ranking for year based on total return</Typography>
        </td>
        </tr>
      </tbody>
      </Box>
    </Box>
  );
}

export default function YtdPage() {
  const { state } = useAuth();
  const { rows, weeks, loading, error } = useYtd();
  const [snack, setSnack] = useState({ open: false, message: "", severity: "info" as Severity });

  // surface hook errors in the snackbar if you like
  useEffect(() => {
    if (error) setSnack({ open: true, message: error, severity: "error" });
  }, [error]);

  const columns: ColumnDef<YtdRow>[] = useMemo(() => {
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
        valueGetter: (r) => r.byWeek[w]?.rank ?? Number.POSITIVE_INFINITY,
        renderCell: (r) => (r.byWeek[w] ? String(r.byWeek[w].rank) : "—"),
      });
    }

    cols.push(
      { key: "pointsAdj",  header: "POINTS", align: "left",
        valueGetter: (r) => r.pointsAdj, renderCell: (r) => r.pointsAdj.toFixed(1) },
      { key: "yearRankPts", header: "YEAR",   align: "left",
        valueGetter: (r) => r.yearRankPts, renderCell: (r) => String(r.yearRankPts) },
      { key: "top5",        header: "TOP",    align: "left",
        valueGetter: (r) => r.top5, renderCell: (r) => String(r.top5) },
      { key: "returnTotal", header: "RETURN", align: "left",
        valueGetter: (r) => r.returnTotal, renderCell: (r) => r.returnTotal.toFixed(2) },
      { key: "yearRankRet", header: "RANK",   align: "left",
        valueGetter: (r) => r.yearRankRet, renderCell: (r) => String(r.yearRankRet) },
    );

    return cols;
  }, [weeks]);

  return (
    <Box mt={4} mb={2}>
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 2 }}>
        <Typography variant="body1" fontWeight="bold">Year to Date</Typography>
        <Button variant="outlined" onClick={() => window.print()}>Print</Button>
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
          />
        </PrintArea>
      )}

      <AppSnackbar
        open={snack.open}
        message={snack.message}
        severity={snack.severity}
        onClose={() => setSnack(s => ({ ...s, open: false }))}
      />

      <Notes />
    </Box>
  );
}
