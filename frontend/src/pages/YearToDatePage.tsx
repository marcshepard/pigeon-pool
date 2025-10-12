/**
 * Year-to-date (client-computed from /results/leaderboard)
 */

import { useEffect, useMemo, useState } from "react";
import { Box, Stack, Typography, Alert, Button } from "@mui/material";
import {
  AppSnackbar,
  PrintOnlyStyles,
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
    <>
      <PrintOnlyStyles areaClass="print-area" landscape margin="8mm" />
      <Box>
        <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 2 }}>
          <Typography variant="body1" fontWeight="bold">Year to Date</Typography>
          <Button variant="outlined" onClick={() => window.print()}>Print</Button>
        </Stack>

        {loading ? (
          <Alert severity="info">Loading…</Alert>
        ) : (
          <PrintArea>
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
      </Box>
    </>
  );
}
