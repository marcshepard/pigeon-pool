/**
 * Admin Page (for Andy)
 */

import { useState, useEffect, useMemo } from "react";
import { Typography, Box, Alert } from "@mui/material";
import { useSchedule } from "../hooks/useSchedule";
import { adminGetWeekPicks, getGamesForWeek } from "../backend/fetch";
import { WeekPicksRow, Game } from "../backend/types";
import { DataGridLite } from "../components/DataGridLite";
import type { ColumnDef } from "../components/DataGridLite";
import { PickCell, LabeledSelect } from "../components/CommonComponents";

export default function AdminPage() {
  const { currentWeek } = useSchedule();
  const [selectedWeek, setSelectedWeek] = useState<number | null>(null);
  // Initialize selected week when schedule is available
  useEffect(() => {
    if (currentWeek?.week) {
      setSelectedWeek(currentWeek.status === "scheduled" ? currentWeek.week : currentWeek.week + 1);
    }
  }, [currentWeek]);

  if (currentWeek == null) {
    return (
      <Box maxWidth={800} mx="auto">
        <Typography variant="body1" gutterBottom align="center" fontWeight={700}>
          Admin page
        </Typography>
        <Typography variant="body1" align="center" mb={2}>
          The season is over, so there is nothing to admin
        </Typography>
      </Box>
    );
  }

  const nextUnstartedWeek = currentWeek.status === "scheduled" ? currentWeek.week : currentWeek.week + 1;

  return (
    <Box maxWidth={1200} mx="auto">
      <Typography variant="body1" gutterBottom align="center" fontWeight={700}>
        Admin page
      </Typography>
      {/* Text + Week selector on one line */}
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 2, my: 2 }}>
        <Typography variant="body1">View pigeon picks for</Typography>
        <LabeledSelect
          label="Week"
          value={selectedWeek ? String(selectedWeek) : ""}
          onChange={(e) => setSelectedWeek(Number(e.target.value))}
          options={
            nextUnstartedWeek <= 18 ?
            Array.from({ length: 18 - nextUnstartedWeek + 1 }, (_, i) => nextUnstartedWeek + i).map((w) => ({ value: String(w), label: `Week ${w}` }))
            : []
          }
          sx={{ minWidth: 200 }}
        />
      </Box>
      <ViewPicks week={selectedWeek ?? nextUnstartedWeek} />
    </Box>
  );
}

// =============================
// View Picks
// =============================
function ViewPicks({ week }: { week: number }) {
  const [picks, setPicks] = useState<WeekPicksRow[]>([]);
  const [games, setGames] = useState<Game[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    Promise.all([adminGetWeekPicks(week), getGamesForWeek(week)])
      .then(([p, g]) => { setPicks(p); setGames(g); })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [week]);

  // Group picks by player
  const rows = useMemo(() => {
    const byPigeon: Record<number, { pigeon_number: number; pigeon_name: string; picks: Record<string, { signed: number; label: string; home_abbr: string; away_abbr: string }> }> = {};
    for (const p of picks) {
      const key = `g_${p.game_id}`;
      const signed = p.picked_home ? +p.predicted_margin : -p.predicted_margin;
      const team = p.picked_home ? p.home_abbr : p.away_abbr;
      let label = p.predicted_margin === 0 ? "" : `${team} ${p.predicted_margin}`;
      if (label && p.home_score != null && p.away_score != null) {
        if (p.status === "final" || p.status === "in_progress") {
          const actualSigned = p.home_score - p.away_score;
          const diff = Math.abs(signed - actualSigned);
          const wrongWinner = actualSigned === 0 || (signed >= 0) !== (actualSigned > 0);
          const sc = diff + (wrongWinner ? 7 : 0);
          label = `${label} (${sc})`;
        }
      }
      if (!byPigeon[p.pigeon_number]) {
        byPigeon[p.pigeon_number] = {
          pigeon_number: p.pigeon_number,
          pigeon_name: p.pigeon_name,
          picks: {},
        };
      }
      byPigeon[p.pigeon_number].picks[key] = { signed, label, home_abbr: p.home_abbr, away_abbr: p.away_abbr };
    }
    return Object.values(byPigeon);
  }, [picks]);

  type PlayerRow = {
    pigeon_number: number;
    pigeon_name: string;
    picks: Record<string, { signed: number; label: string; home_abbr: string; away_abbr: string }>;
  };

  const columns: ColumnDef<PlayerRow>[] = useMemo(() => {
    const cols: ColumnDef<PlayerRow>[] = [
      {
        key: "pigeon_name",
        header: "Player",
        pin: "left",
        renderCell: (r) => `${r.pigeon_number} ${r.pigeon_name}`,
      },
    ];
    for (const g of games) {
      const key = `g_${g.game_id}`;
      cols.push({
        key,
        header: (
          <Box sx={{ textAlign: "left", lineHeight: 1.15 }}>
            <Box>{g.away_abbr} @ {g.home_abbr}</Box>
          </Box>
        ),
        align: "left",
        sortable: true,
        nullsLastAlways: true,
        renderCell: (r) => {
          const cell = r.picks[key];
          return cell ? <PickCell label={cell.label} signed={cell.signed} /> : "—";
        },
      });
    }
    return cols;
  }, [games]);

  return (
    <>
      {loading && <Alert severity="info">Loading…</Alert>}
      {error && <Alert severity="error">{error}</Alert>}
      <Box p={3}>
        <DataGridLite
          rows={rows}
          columns={columns}
          emptyMessage="No picks found"
          getRowId={(row) => row.pigeon_number}
          printTitle={`Admin Picks — Week ${week}`}
          autoScrollHighlightOnSort={true}
        />
      </Box>
    </>
  );
}
