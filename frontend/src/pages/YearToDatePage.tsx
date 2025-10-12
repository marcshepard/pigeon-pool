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
import { getResultsAllLeaderboards, getScheduleCurrent } from "../backend/fetch";

type WeekCell = { rank: number; score: number; points: number };

type Row = {
  pigeon_number: number;
  pigeon_name: string;
  byWeek: Record<number, WeekCell>;

  // New summary fields
  pointsTotal: number;  // sum of weekly position points
  pointsWorst: number;  // worst single week position points
  pointsAdj: number;    // POINTS = pointsTotal - pointsWorst (drop worst)
  yearRankPts: number;  // YEAR = rank by pointsAdj (lower is better)

  top5: number;         // TOP = # of weeks with rank <= 5

  returnTotal: number;  // RETURN = sum of weekly payouts (tie-split)
  yearRankRet: number;  // RANK = rank by returnTotal (higher is better)
};

export default function YtdPage() {
  const { state } = useAuth();
  const [rows, setRows] = useState<Row[]>([]);
  const [weeks, setWeeks] = useState<number[]>([]);
  const [snack, setSnack] = useState({ open: false, message: "", severity: "info" as Severity });
  const [loading, setLoading] = useState(false);

  useEffect(() => { void load(); }, []);

async function load() {
  setLoading(true);
  try {
    // Fetch weekly leaderboards + current weeks in parallel
    const [weekly, sched] = await Promise.all([
      getResultsAllLeaderboards(),
      getScheduleCurrent(), // { next_picks_week, live_week }
    ]);

    const liveWeek = sched?.live_week ?? null;

    // Exclude the live (in-progress) week from YTD calcs
    const weeklyFiltered = liveWeek == null
      ? weekly
      : weekly.filter(w => w.week_number !== liveWeek);

    // Weeks present (post-filter)
    const allWeeks = Array.from(new Set(weeklyFiltered.map(w => w.week_number))).sort((a, b) => a - b);
    setWeeks(allWeeks);

    // Group by player
    const byPigeon = new Map<number, Row>();
    for (const w of weeklyFiltered) {
      let r = byPigeon.get(w.pigeon_number);
      if (!r) {
        r = {
          pigeon_number: w.pigeon_number,
          pigeon_name: w.pigeon_name,
          byWeek: {},
          pointsTotal: 0,
          pointsWorst: 0,
          pointsAdj: 0,
          yearRankPts: Number.POSITIVE_INFINITY,
          top5: 0,
          returnTotal: 0,
          yearRankRet: Number.POSITIVE_INFINITY,
        };
        byPigeon.set(w.pigeon_number, r);
      }
      r.byWeek[w.week_number] = { rank: w.rank, score: w.score, points: w.points };
    }

    // Build tie counts per (week, rank) from the filtered set
    const RETURNS_BY_PLACE = [530, 270, 160, 100, 70];
    const tieCountByWeekRank = new Map<number, Map<number, number>>();
    for (const wk of allWeeks) {
      const map = new Map<number, number>();
      const rowsThisWeek = weeklyFiltered.filter(x => x.week_number === wk);
      for (const r of rowsThisWeek) {
        map.set(r.rank, (map.get(r.rank) ?? 0) + 1);
      }
      tieCountByWeekRank.set(wk, map);
    }

    const payoutFor = (rank: number, tieCount: number): number => {
      // Average the occupied places within 1..5
      let pool = 0;
      for (let pos = rank; pos < rank + tieCount; pos++) {
        if (pos >= 1 && pos <= 5) pool += RETURNS_BY_PLACE[pos - 1];
      }
      return tieCount > 0 ? pool / tieCount : 0;
    };

    // Aggregates per player (from filtered weeks only)
    for (const r of byPigeon.values()) {
      const weekCells = Object.values(r.byWeek);
      const numWeeks = weekCells.length;

      r.pointsTotal = weekCells.reduce((s, w) => s + w.points, 0);
      r.pointsWorst = numWeeks >= 2 ? Math.max(...weekCells.map(w => w.points)) : 0;
      r.pointsAdj   = r.pointsTotal - r.pointsWorst;

      r.top5 = weekCells.reduce((s, w) => s + (w.rank <= 5 ? 1 : 0), 0);

      let ret = 0;
      for (const [wkStr, cell] of Object.entries(r.byWeek)) {
        const wk = Number(wkStr);
        const tieCount = tieCountByWeekRank.get(wk)?.get(cell.rank) ?? 1;
        ret += payoutFor(cell.rank, tieCount);
      }
      r.returnTotal = ret;
    }

    // YEAR rank by pointsAdj (lower is better)
    {
      const arr = Array.from(byPigeon.values());
      const sorted = [...arr].sort((a, b) => a.pointsAdj - b.pointsAdj || a.pigeon_number - b.pigeon_number);
      let shown = 0, currRank = 0, prevVal: number | null = null;
      for (const row of sorted) {
        shown++;
        if (prevVal === null || row.pointsAdj !== prevVal) {
          currRank = shown; prevVal = row.pointsAdj;
        }
        row.yearRankPts = currRank;
      }
    }

    // RANK by returnTotal (higher is better)
    {
      const arr = Array.from(byPigeon.values());
      const sorted = [...arr].sort((a, b) => b.returnTotal - a.returnTotal || a.pigeon_number - b.pigeon_number);
      let shown = 0, currRank = 0, prevVal: number | null = null;
      for (const row of sorted) {
        shown++;
        if (prevVal === null || row.returnTotal !== prevVal) {
          currRank = shown; prevVal = row.returnTotal;
        }
        row.yearRankRet = currRank;
      }
    }

    setRows(Array.from(byPigeon.values()));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e ?? "");
    setSnack({ open: true, message: msg || "Failed to load YTD", severity: "error" });
  } finally {
    setLoading(false);
  }
}

  // Columns -------------------------------------------------------------------
  const columns: ColumnDef<Row>[] = useMemo(() => {
    const cols: ColumnDef<Row>[] = [
      {
        key: "pigeon",
        header: "Pigeon",
        pin: "left",
        valueGetter: (r) => r.pigeon_number,
        renderCell: (r) => `${r.pigeon_number} ${r.pigeon_name}`,
      },
    ];

    // Per-week rank columns (W1..Wn)
    for (const w of weeks) {
      cols.push({
        key: `w_${w}`,
        header: `W${w}`,
        align: "left",
        valueGetter: (r) => r.byWeek[w]?.rank ?? Number.POSITIVE_INFINITY,
        renderCell: (r) => {
          const cell = r.byWeek[w];
          return cell ? String(cell.rank) : "—";
        },
      });
    }

    // Replace summary columns with the requested set:
    // POINTS (one decimal), YEAR (by points), TOP (int), RETURN (two decimals), RANK (by return)
    cols.push(
      {
        key: "pointsAdj",
        header: "POINTS",
        align: "left",
        valueGetter: (r) => r.pointsAdj,
        renderCell: (r) => r.pointsAdj.toFixed(1),
      },
      {
        key: "yearRankPts",
        header: "YEAR",
        align: "left",
        valueGetter: (r) => r.yearRankPts,
        renderCell: (r) => String(r.yearRankPts),
      },
      {
        key: "top5",
        header: "TOP",
        align: "left",
        valueGetter: (r) => r.top5,
        renderCell: (r) => String(r.top5),
      },
      {
        key: "returnTotal",
        header: "RETURN",
        align: "left",
        valueGetter: (r) => r.returnTotal,
        renderCell: (r) => r.returnTotal.toFixed(2),
      },
      {
        key: "yearRankRet",
        header: "RANK",
        align: "left",
        valueGetter: (r) => r.yearRankRet,
        renderCell: (r) => String(r.yearRankRet),
      }
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
            <DataGridLite<Row>
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
