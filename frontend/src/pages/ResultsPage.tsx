/**
 * Show picks and results
 */

import { useEffect, useMemo, useState } from "react";
import { Box, Stack, Typography, Alert, Button, MenuItem, Select, FormControl, InputLabel } from "@mui/material";
import {
  AppSnackbar,
  PickCell,
  PrintOnlyStyles,
  PrintArea,
} from "../components/CommonComponents";
import type { Severity } from "../components/CommonComponents";
import { DataGridLite } from "../components/DataGridLite";
import type { ColumnDef } from "../components/DataGridLite";
import {
  getResultsWeekPicks,
  getResultsWeekLeaderboard,
  getScheduleCurrent,
} from "../backend/fetch";

type Row = {
  pigeon_number: number;
  pigeon_name: string;
  picks: Record<string, { signed: number; label: string; home_abbr: string; away_abbr: string }>;
  points: number | null;
  rank: number | null;
};

export default function ResultsPage() {
  const [week, setWeek] = useState<number | null>(1);
  const [liveWeek, setLiveWeek] = useState<number | null>(null);
  const [lockedWeeks, setLockedWeeks] = useState<number[]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const [games, setGames] = useState<{ game_id: number; home_abbr: string; away_abbr: string }[]>([]);
  const [snack, setSnack] = useState({ open: false, message: "", severity: "info" as Severity });
  const [loading, setLoading] = useState(false);

  useEffect(() => {
  let cancelled = false;
  (async () => {
    try {
      const sc = await getScheduleCurrent(); // { next_picks_week: number | null, live_week?: number | null }
      // If next_picks_week is n, locked weeks are 1..(n-1)
      // If null (season over), all 1..18 are locked
      const cutoff = sc.next_picks_week;
      const weeks =
        cutoff == null
          ? Array.from({ length: 18 }, (_, i) => i + 1)
          : Array.from({ length: Math.max(0, cutoff - 1) }, (_, i) => i + 1);

      if (!cancelled) {
        setLockedWeeks(weeks);
        setWeek(weeks.length ? weeks[weeks.length - 1] : null); // most recent locked
        setLiveWeek(sc.live_week ?? null); // Currently live week (locked but ongoing) - null between MNF and TNF
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e ?? "");
      setSnack({ open: true, message: msg || "Failed to load schedule status", severity: "error" });
    }
  })();
  return () => { cancelled = true; };
}, []);

  useEffect(() => {
    if (week == null) return;
    if (!lockedWeeks.includes(week)) return; // safety
    load(week);
  }, [week, lockedWeeks]);


  async function load(w: number) {
    setLoading(true);
    try {
      const [picks, lb] = await Promise.all([
        getResultsWeekPicks(w),
        getResultsWeekLeaderboard(w),
      ]);

      // shape: per game metadata
      const gameOrder = [...new Map(
        picks.map(p => [p.game_id, { game_id: p.game_id, home_abbr: p.home_abbr, away_abbr: p.away_abbr}])
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
            points: lbr?.score ?? null,
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
    <>
      {/* Print only the grid (landscape, compact margins) */}
      <PrintOnlyStyles areaClass="print-area" landscape margin="8mm" />

      <Box>
        {/* Toolbar + controls won't print (they're outside the PrintArea) */}
        <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 2 }}>
          <Typography variant="body1" fontWeight="bold">
            {week == null
              ? "Loading results…"
              : liveWeek === week ? "Partial results" : "Results"}
          </Typography>
          <Stack direction="row" gap={1} alignItems="center">
            <FormControl size="small" disabled={lockedWeeks.length === 0}>
              <InputLabel>Week</InputLabel>
              <Select
                label="Week"
                value={lockedWeeks.length === 0 ? "" : week ?? ""}
                onChange={(e) => setWeek(Number(e.target.value))}
                sx={{ minWidth: 120 }}
              >
                {lockedWeeks.map((w) => (
                  <MenuItem key={w} value={w}>
                    Week {w}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            <Button variant="outlined" onClick={() => window.print()}>
              Print
            </Button>
          </Stack>
        </Stack>

        {loading ? (
          <Alert severity="info">Loading…</Alert>
        ) : (
          <PrintArea>
            <DataGridLite<Row>
              rows={rows}
              columns={columns}
              pinnedTopRows={consensusRow ? [consensusRow] : []}
              defaultSort={{ key: "pigeon", dir: "asc" }}
              printTitle={`Results — Week ${week}`}
            />
          </PrintArea>
        )}

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

