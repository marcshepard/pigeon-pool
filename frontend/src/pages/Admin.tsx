/**
 * Admin Page (for Andy)
 */

import { useState, useEffect, useMemo } from "react";
import { Typography, Box, Tabs, Tab, Alert, Stack, Button, FormControl, FormControlLabel, RadioGroup, Radio, TextField } from "@mui/material";
import { alpha } from "@mui/material/styles";
import { useSchedule } from "../hooks/useSchedule";
import { adminGetWeekPicks, getGamesForWeek, adminGetPigeonPicksForWeek, adminSetPigeonPicks } from "../backend/fetch";
import { WeekPicksRow, Game, PickOut } from "../backend/types";
import { DataGridLite } from "../components/DataGridLite";
import type { ColumnDef } from "../components/DataGridLite";
import { PickCell, LabeledSelect } from "../components/CommonComponents";

export default function AdminPage() {
  const [tab, setTab] = useState(0);
  const { schedule } = useSchedule();
  const nextWeek = schedule?.next_picks_week;
  const [selectedWeek, setSelectedWeek] = useState<number | null>(null);
  // Initialize selected week when schedule is available
  useEffect(() => {
    if (typeof nextWeek === "number") setSelectedWeek(nextWeek);
  }, [nextWeek]);

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
      {/* Text + Week selector on one line */}
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 2, my: 2 }}>
        <Typography variant="body1">View or update pigeon's picks for</Typography>
        <LabeledSelect
          label="Week"
          value={selectedWeek ? String(selectedWeek) : ""}
          onChange={(e) => setSelectedWeek(Number(e.target.value))}
          options={Array.from({ length: 18 - (nextWeek ?? 1) + 1 }, (_, i) => (nextWeek ?? 1) + i)
            .map((w) => ({ value: String(w), label: `Week ${w}` }))}
          sx={{ minWidth: 200 }}
        />
      </Box>
      <Typography variant="body1" align="center" mb={2}>
        Note: picks become uneditable when the week locks (currently Tuesday at midnight), even by admins
      </Typography>
      <Tabs value={tab} onChange={(_, v) => setTab(v)} centered sx={{ mb: 2 }}>
        <Tab label="View Picks" />
        <Tab label="Edit Picks" />
      </Tabs>

      {tab === 0 && selectedWeek != null && <ViewPicksTab week={selectedWeek} />}
      {tab === 1 && selectedWeek != null && <EditPicksTab week={selectedWeek} />}
    </Box>
  );
}

// =============================
// View Picks Tab
// =============================
function ViewPicksTab({ week }: { week: number }) {
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

// =============================
// Edit Picks Tab
// =============================
function EditPicksTab({ week }: { week: number }) {
  const [selectedPigeon, setSelectedPigeon] = useState<string>("");
  const [games, setGames] = useState<Game[]>([]);
  const [pigeonOptions, setPigeonOptions] = useState<Array<{ value: string; label: string }>>([]);
  type PickDraft = { picked_home: boolean; predicted_margin: number };
  const [draft, setDraft] = useState<Record<number, PickDraft>>({});
  const [editLoading, setEditLoading] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  // Load games and derive pigeon options from admin week picks
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [gs, weekPicks] = await Promise.all([
          getGamesForWeek(week),
          adminGetWeekPicks(week),
        ]);
        if (cancelled) return;
        setGames(gs);
        const opts = Array.from(new Set(weekPicks.map(p => `${p.pigeon_number}|${p.pigeon_name}`)))
          .map(str => {
            const [num, name] = str.split("|");
            return { value: String(num), label: `${num} ${name}` };
          });
        setPigeonOptions(opts);
      } catch (e) {
        setEditError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [week]);

  // Load selected pigeon's picks
  useEffect(() => {
    if (!selectedPigeon) return;
    setEditLoading(true);
    setEditError(null);
    adminGetPigeonPicksForWeek(week, Number(selectedPigeon))
      .then((po: PickOut[]) => {
        const initial: Record<number, PickDraft> = {};
        for (const p of po) initial[p.game_id] = { picked_home: p.picked_home, predicted_margin: p.predicted_margin };
        setDraft(initial);
      })
      .catch((e) => setEditError(e instanceof Error ? e.message : String(e)))
      .finally(() => setEditLoading(false));
  }, [week, selectedPigeon]);

  return (
    <Box p={3}>
      <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={2} sx={{ mb: 2 }}>
        <LabeledSelect
          label="Pigeon"
          value={selectedPigeon}
          onChange={(e) => setSelectedPigeon(e.target.value as string)}
          options={pigeonOptions}
          sx={{ minWidth: 260 }}
        />
        <Button
          variant="contained"
          disabled={!selectedPigeon || editLoading || !games.length}
          onClick={async () => {
            if (!selectedPigeon || !games.length) return;
            const missing = games.find((g) => !draft[g.game_id]);
            if (missing) { setEditError("Please make a pick and margin for every game."); return; }
            const zero = games.find((g) => (draft[g.game_id]?.predicted_margin ?? 0) === 0);
            if (zero) { setEditError("All picks must have non-zero margins."); return; }
            setEditError(null);
            try {
              await adminSetPigeonPicks({
                week_number: week,
                picks: games.map((g) => ({
                  game_id: g.game_id,
                  picked_home: draft[g.game_id].picked_home,
                  predicted_margin: draft[g.game_id].predicted_margin,
                })),
              }, Number(selectedPigeon));
            } catch (e) {
              setEditError(e instanceof Error ? e.message : String(e));
            }
          }}
        >
          Submit
        </Button>
      </Stack>

      {editLoading && <Alert severity="info">Loading pigeon picks…</Alert>}
      {editError && <Alert severity="error">{editError}</Alert>}

      {selectedPigeon && games.length > 0 && (
        <Stack spacing={2}>
          {games.map((g) => {
            const d = draft[g.game_id];
            const kickoff = new Date(g.kickoff_at);
            const when = kickoff.toLocaleString(undefined, {
              weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
            });
            const margin = d?.predicted_margin ?? 0;
            const isZero = margin === 0;
            const isOverFifty = margin > 50;
            const isWarn = margin > 29 && margin <= 50;
            const isError = isZero || isOverFifty;
            return (
              <Box key={g.game_id} sx={{ border: "1px solid", borderColor: "divider", borderRadius: 2, p: 2 }}>
                <Stack direction={{ xs: "column", sm: "row" }} justifyContent="space-between" alignItems={{ xs: "flex-start", sm: "center" }} spacing={1.5}>
                  <Box>
                    <Typography variant="subtitle1" fontWeight="bold">{g.away_abbr} @ {g.home_abbr}</Typography>
                    <Typography variant="body2" color="text.secondary">{when}</Typography>
                  </Box>
                  <Stack direction="row" spacing={3} alignItems="center" sx={{ width: { xs: "100%", sm: "auto" } }}>
                    <FormControl component="fieldset">
                      <RadioGroup
                        row
                        value={d && margin > 0 ? (d.picked_home ? "home" : "away") : ""}
                        onChange={(_, val) => setDraft((old) => ({ ...old, [g.game_id]: { ...old[g.game_id], picked_home: (val as string) === "home" } }))}
                      >
                        <FormControlLabel value="away" control={<Radio />} label={g.away_abbr} />
                        <FormControlLabel value="home" control={<Radio />} label={g.home_abbr} />
                      </RadioGroup>
                    </FormControl>
                    <TextField
                      label="Spread"
                      type="text"
                      size="small"
                      value={isZero ? "" : String(margin)}
                      onChange={(e) => {
                        const digits = e.target.value.replace(/[^0-9]/g, "").slice(0, 2);
                        const n = digits === "" ? 0 : Math.max(0, Math.min(99, Number(digits)));
                        setDraft((old) => ({ ...old, [g.game_id]: { ...old[g.game_id], predicted_margin: n } }));
                      }}
                      error={isError}
                      helperText={isError ? (isZero ? "Required" : "Max 50") : (isWarn ? "Very large" : " ")}
                      sx={{
                        width: 100,
                        '& .MuiFormHelperText-root': { mt: 0.25 },
                        backgroundColor: (theme) =>
                          isError ? alpha(theme.palette.error.main, 0.06)
                          : isWarn ? alpha(theme.palette.warning.main, 0.06)
                          : undefined,
                        transition: 'background 0.2s',
                        '& .MuiOutlinedInput-notchedOutline': {
                          borderColor: (theme) => (isWarn ? theme.palette.warning.main : undefined),
                        },
                      }}
                      slotProps={{
                        input: {
                          inputProps: { inputMode: "numeric", pattern: "\\d{1,2}", maxLength: 2 },
                        },
                      }}
                    />
                  </Stack>
                </Stack>
              </Box>
            );
          })}
        </Stack>
      )}
    </Box>
  );
}