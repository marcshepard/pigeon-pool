/**
 * Show year-to-date statistics
 */

import { useEffect, useMemo, useState } from "react";
import { Box, Stack, Typography, Alert, Button } from "@mui/material";
import {
  AppSnackbar,
  DataGridLite,
  PrintOnlyStyles,
  PrintArea,
} from "../components/CommonComponents";
import type { ColumnDef, Severity } from "../components/CommonComponents";
import { getResultsYtd } from "../backend/fetch";

type Row = {
  pigeon_number: number;
  pigeon_name: string;
  byWeek: Record<number, { rank: number; score: number }>;
  pointsYtd: number;
  yearRank: number; // computed client-side by pointsYtd asc
};

export default function YtdPage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [weeks, setWeeks] = useState<number[]>([]);
  const [snack, setSnack] = useState({ open: false, message: "", severity: "info" as Severity });
  const [loading, setLoading] = useState(false);

  useEffect(() => { load(); }, []);
  async function load() {
    setLoading(true);
    try {
      const data = await getResultsYtd();
      const allWeeks = Array.from(new Set(data.flatMap(d => d.weeks_locked))).sort((a, b) => a - b);

      // prepare base without yearRank
      const temp: Row[] = data.map(d => {
        const byWeek: Row["byWeek"] = {};
        for (const bw of d.by_week) {
          byWeek[bw.week_number] = { rank: bw.rank, score: bw.score };
        }
        return {
          pigeon_number: d.pigeon_number,
          pigeon_name: d.pigeon_name,
          byWeek,
          pointsYtd: d.total_points_ytd,
          yearRank: Number.POSITIVE_INFINITY,
        };
      });

      // compute YEAR rank by pointsYtd asc (ties get same number)
      const sorted = [...temp].sort((a, b) => a.pointsYtd - b.pointsYtd || a.pigeon_number - b.pigeon_number);
      let rank = 0, prevPts: number | null = null, shown = 0;
      const counts: Record<number, number> = {};
      for (const r of sorted) {
        shown++;
        if (prevPts === null || r.pointsYtd !== prevPts) {
          rank = shown;
          prevPts = r.pointsYtd;
        }
        r.yearRank = rank;
        counts[rank] = (counts[rank] ?? 0) + 1;
      }

      // apply tie prefix formatting at render time via counts
      setRows(temp);
      setWeeks(allWeeks);
      setTieCounts(counts);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e ?? "");
      setSnack({ open: true, message: msg || "Failed to load YTD", severity: "error" });
    } finally {
      setLoading(false);
    }
  }

  // rank tie counts (for "T" rendering)
  const [tieCounts, setTieCounts] = useState<Record<number, number>>({});

  const columns: ColumnDef<Row>[] = useMemo(() => {
    const cols: ColumnDef<Row>[] = [
      {
        key: "pigeon",
        header: "Pigeon",
        pin: "left",
        valueGetter: (r) => r.pigeon_number, // sort by pigeon number
        renderCell: (r) => `${r.pigeon_number} ${r.pigeon_name}`, // render pigeon number + name
      },
    ];

    // week columns (rank cells)
    for (const w of weeks) {
      cols.push({
        key: `w_${w}`,
        header: `W${w}`,
        align: "left",
        valueGetter: (r) => r.byWeek[w]?.rank ?? Number.POSITIVE_INFINITY,
        renderCell: (r) => {
          const rk = r.byWeek[w]?.rank;
          if (rk == null) return "—";
          // (Optional) if you have per-week tie info, you could prefix "T"; here we just show number.
          return String(rk);
        },
      });
    }

    // summary columns
    cols.push(
      {
        key: "pointsYtd",
        header: "POINTS",
        align: "left",
        valueGetter: (r) => r.pointsYtd,
        renderCell: (r) => r.pointsYtd,
      },
      {
        key: "yearRank",
        header: "YEAR",
        align: "left",
        valueGetter: (r) => r.yearRank,
        renderCell: (r) => {
          const rk = r.yearRank;
          const tied = tieCounts[rk] > 1;
          return tied ? `T${rk}` : String(rk);
        },
      }
    );

    return cols;
  }, [weeks, tieCounts]);

  return (
    <>
      {/* Make only .print-area printable (landscape, small margins) */}
      <PrintOnlyStyles areaClass="print-area" landscape margin="8mm" />

      <Box>
        {/* This toolbar won't print because it's outside PrintArea */}
        <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 2 }}>
          <Typography variant="body1" fontWeight="bold">Year to Date</Typography>
          <Button variant="outlined" onClick={() => window.print()}>Print</Button>
        </Stack>

        {loading ? (
          <Alert severity="info">Loading…</Alert>
        ) : (
          <PrintArea>
            <DataGridLite<Row>
              rows={rows}
              columns={columns}
              defaultSort={{ key: "pigeon", dir: "asc" }}
              printTitle="Pigeon Pool — Year to Date"
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

