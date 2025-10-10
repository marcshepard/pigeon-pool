/**
 * Show picks and results
 */

import { useEffect, useMemo, useState } from "react";
import { Box, Stack, Typography, Alert, Button, MenuItem, Select, FormControl, InputLabel } from "@mui/material";
import { AppSnackbar, DataGridLite, PickCell } from "../components/CommonComponents";
import { getResultsWeekPicks, getResultsWeekLeaderboard } from "../backend/fetch";
import type { ColumnDef, Severity } from "../components/CommonComponents";

type Row = {
  pigeon_number: number;
  pigeon_name: string;
  picks: Record<string, { signed: number; label: string; home_abbr: string; away_abbr: string }>;
  points: number | null;
  rank: number | null;
};

export default function ResultsPage() {
  const [week, setWeek] = useState<number>(1);
  const [rows, setRows] = useState<Row[]>([]);
  const [games, setGames] = useState<{ game_id: number; home_abbr: string; away_abbr: string; kickoff_at: string }[]>([]);
  const [snack, setSnack] = useState({ open: false, message: "", severity: "info" as Severity });
  const [loading, setLoading] = useState(false);

  useEffect(() => { load(week); }, [week]);

  async function load(w: number) {
    setLoading(true);
    try {
      const [picks, lb] = await Promise.all([
        getResultsWeekPicks(w),
        getResultsWeekLeaderboard(w),
      ]);

      // shape: per game metadata
      const gameOrder = [...new Map(
        picks.map(p => [p.game_id, { game_id: p.game_id, home_abbr: p.home_abbr, away_abbr: p.away_abbr, kickoff_at: p.kickoff_at }])
      ).values()];
      setGames(gameOrder);

      // leaderboard map
      const lbByPigeon = new Map(lb.map((r) => [r.pigeon_number, r]));

      // group by pigeon
      const byPigeon = new Map<number, Row>();
      for (const p of picks) {
        const key = `g_${p.game_id}`;
        const signed = p.picked_home ? +p.predicted_margin : -p.predicted_margin;
        const team = p.picked_home ? p.home_abbr : p.away_abbr;
        const label = `${team} +${p.predicted_margin}`;
        let row = byPigeon.get(p.pigeon_number);
        if (!row) {
          const lbr = lbByPigeon.get(p.pigeon_number);
          row = {
            pigeon_number: p.pigeon_number,
            pigeon_name: p.pigeon_name,
            picks: {},
            points: lbr?.total_points ?? null,
            rank: lbr?.rank ?? null,
          };
          byPigeon.set(p.pigeon_number, row);
        }
        row.picks[key] = { signed, label, home_abbr: p.home_abbr, away_abbr: p.away_abbr };
      }
      setRows([...byPigeon.values()]);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e ?? "");
      setSnack({ open: true, message: msg || "Failed to load results", severity: "error" });
    } finally {
      setLoading(false);
    }
  }

  // Build columns
  const columns: ColumnDef<Row>[] = useMemo(() => {
    const cols: ColumnDef<Row>[] = [
      {
        key: "pigeon_name",
        header: "Pigeon",
        pin: "left",
        width: 140,
        valueGetter: (r) => r.pigeon_number, // sort by pigeon number
        renderCell: (r) => `${r.pigeon_number} ${r.pigeon_name}`, // render pigeon number + name
      },
    ];

    for (const g of games) {
      const key = `g_${g.game_id}`;
      cols.push({
        key,
        header: (
          <Box sx={{ textAlign: "center" }}>
            <div>{g.away_abbr} @ {g.home_abbr}</div>
            <div style={{ opacity: 0.7, fontSize: 12 }}>{new Date(g.kickoff_at).toLocaleString()}</div>
          </Box>
        ),
        align: "center",
        sortable: true,
        valueGetter: (r) => r.picks[key]?.signed ?? 0,
        renderCell: (r) => {
          const cell = r.picks[key];
          if (!cell) return "—";
          return (
            <PickCell
              label={cell.label}
              signed={cell.signed}
              tooltip={`${cell.away_abbr} @ ${cell.home_abbr} — ${cell.label}`}
            />
          );
        },
      });
    }

    // Points & Rank pinned right
    cols.push(
      {
        key: "points",
        header: "Points",
        align: "right",
        width: 90,
        valueGetter: (r) => (r.points ?? Number.POSITIVE_INFINITY),
        renderCell: (r) => (r.points ?? "—"),
      },
      {
        key: "rank",
        header: "Rank",
        align: "center",
        width: 80,
        valueGetter: (r) => (r.rank ?? Number.POSITIVE_INFINITY),
        renderCell: (r) => (r.rank ?? "—"),
      }
    );

    return cols;
  }, [games]);

  // Consensus pinned-top row
  const consensusRow: Row | null = useMemo(() => {
    if (!rows.length) return null;
    const out: Row = {
      pigeon_number: 0,
      pigeon_name: "Consensus",
      picks: {},
      points: null,
      rank: null,
    };
    for (const g of games) {
      const key = `g_${g.game_id}`;
      let sum = 0, n = 0;
      for (const r of rows) {
        const v = r.picks[key]?.signed;
        if (typeof v === "number") { sum += v; n += 1; }
      }
      const mean = n ? sum / n : 0;
      const team = mean >= 0 ? g.home_abbr : g.away_abbr;
      const label = `${team} +${Math.round(Math.abs(mean))}`;
      out.picks[key] = { signed: mean, label, home_abbr: g.home_abbr, away_abbr: g.away_abbr };
    }
    return out;
  }, [rows, games]);

  return (
    <Box sx={{ p: 2 }}>
      <Stack direction="row" justifyContent="space-between" alignItems="center" className="print-hide" sx={{ mb: 2 }}>
        <Typography variant="h6">Results — Week {week}</Typography>
        <Stack direction="row" gap={1} alignItems="center">
          <FormControl size="small">
            <InputLabel>Week</InputLabel>
            <Select label="Week" value={week} onChange={(e) => setWeek(Number(e.target.value))} sx={{ minWidth: 120 }}>
              {Array.from({ length: 18 }, (_, i) => i + 1).map(w => <MenuItem key={w} value={w}>Week {w}</MenuItem>)}
            </Select>
          </FormControl>
          <Button variant="outlined" onClick={() => window.print()}>Print</Button>
        </Stack>
      </Stack>

      {loading ? (
        <Alert severity="info">Loading…</Alert>
      ) : (
        <DataGridLite<Row>
          rows={rows}
          columns={columns}
          pinnedTopRows={consensusRow ? [consensusRow] : []}
          defaultSort={{ key: "pigeon", dir: "asc" }}
          printTitle={`Results — Week ${week}`}
        />
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

