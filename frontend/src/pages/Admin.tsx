/**
 * Admin Page (for Andy)
 */

import { useState, useEffect, useMemo } from "react";
import { Typography, Box, Tabs, Tab, Alert } from "@mui/material";
import { useSchedule } from "../hooks/useSchedule";
import { adminGetWeekPicks, getGamesForWeek } from "../backend/fetch";
import { WeekPicksRow, Game } from "../backend/types";
import { DataGridLite } from "../components/DataGridLite";
import type { ColumnDef } from "../components/DataGridLite";
import { PickCell, LabeledSelect } from "../components/CommonComponents";

export default function AdminPage() {
  const [tab, setTab] = useState(0);
  const [selectedPigeon, setSelectedPigeon] = useState<string>("");
  const { schedule } = useSchedule();
  const nextWeek = schedule?.next_picks_week;
  const [picks, setPicks] = useState<WeekPicksRow[]>([]);
  const [games, setGames] = useState<Game[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Only show grid for nextWeek (no week picker, no print, no tabs)

  // Fetch picks and games for selected week
  useEffect(() => {
    if (nextWeek == null) return;
    setLoading(true);
    setError(null);
    Promise.all([
      adminGetWeekPicks(nextWeek),
      getGamesForWeek(nextWeek)
    ])
      .then(([p, g]) => {
        setPicks(p);
        setGames(g);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [nextWeek]);

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

  // Dynamic columns for each game
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
        renderCell: (r) => r.pigeon_name,
      },
    ];
    for (const g of games) {
      const key = `g_${g.game_id}`;
      let subLabel = "";
      if (g.status === "scheduled") {
        subLabel = "Not started";
      } else if (g.status === "in_progress") {
        if (g.home_score != null && g.away_score != null) {
          const signed = g.home_score - g.away_score;
          subLabel = signed === 0
            ? "Live: TIE 0"
            : `Live: ${signed >= 0 ? g.home_abbr : g.away_abbr} ${Math.abs(signed)}`;
        } else {
          subLabel = "Live";
        }
      } else if (g.status === "final" && g.home_score != null && g.away_score != null) {
        const signed = g.home_score - g.away_score;
        subLabel = signed === 0 ? "TIE 0" : `${signed >= 0 ? g.home_abbr : g.away_abbr} ${Math.abs(signed)}`;
      }
      cols.push({
        key,
        header: (
          <Box sx={{ textAlign: "left", lineHeight: 1.15 }}>
            <Box>{g.away_abbr} @ {g.home_abbr}</Box>
            {subLabel && (
              <Typography variant="caption" sx={{ display: "block" }}>{subLabel}</Typography>
            )}
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

  if (nextWeek == null) {
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

  return (
    <Box maxWidth={1200} mx="auto">
      <Typography variant="body1" gutterBottom align="center" fontWeight={700}>
        Admin page
      </Typography>
      <Typography variant="body1" align="center" mb={2}>
        View or edit picks for week {nextWeek}
      </Typography>
      <Typography variant="body1" align="center" mb={2}>
        At midnight on Tuesday, week {nextWeek} picks become uneditable and this page will let you view and edit the {nextWeek + 1} picks instead
      </Typography>
      <Tabs value={tab} onChange={(_, v) => setTab(v)} centered sx={{ mb: 2 }}>
        <Tab label="View Picks" />
        <Tab label="Edit Picks" />
      </Tabs>
        {tab === 0 && (
          <>
            {loading && <Alert severity="info">Loading…</Alert>}
            {error && <Alert severity="error">{error}</Alert>}
            <Box p={3}>
              <DataGridLite
                rows={rows}
                columns={columns}
                emptyMessage="No picks found"
                getRowId={(row) => row.pigeon_number}
                printTitle={`Admin Picks — Week ${nextWeek}`}
                autoScrollHighlightOnSort={true}
              />
            </Box>
          </>
        )}
      {tab === 1 && (
        <Box p={3} textAlign="center">
          <LabeledSelect
            label="Select Pigeon"
            value={selectedPigeon}
            onChange={(e) => setSelectedPigeon(e.target.value as string)}
            options={Array.from(new Set(picks.map(p => `${p.pigeon_number}|${p.pigeon_name}`))).map(str => {
              const [num, name] = str.split("|");
              return { value: String(num), label: `${num} ${name}` };
            })}
            sx={{ minWidth: 240 }}
          />
        </Box>
      )}
    </Box>
  );
}