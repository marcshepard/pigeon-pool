// =============================================
// File: src/pages/admin/AdminLocksAndPicks.tsx
// (Refactor of your current Admin.tsx content)
// =============================================
import { useState, useEffect, useMemo } from "react";
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  Typography,
} from "@mui/material";
import { useSchedule } from "../../hooks/useSchedule";
import {
    getGamesForWeek,
    adminGetWeeksLocks,
    adminAdjustWeekLock,
    adminGetWeekPicks,
} from "../../backend/fetch";
import {
    AdminWeekLock,
    Game,
    WeekPicksRow,
} from "../../backend/types";
import { LabeledSelect, PickCell } from "../../components/CommonComponents";
import { DataGridLite, type ColumnDef } from "../../components/DataGridLite";

function formatDateTimeNoYear(dt: Date) {
  const dateStr = dt.toLocaleString("en-US", {
    month: "2-digit",
    day: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
    timeZone: "America/Los_Angeles",
  });
  return dateStr.replace(/^(\d{2})\/(\d{2})\/\d{4},\s*/, "$1/$2, ");
}

function ViewPicks({ week }: { week: number }) {
  const [picks, setPicks] = useState<WeekPicksRow[]>([]);
  const [games, setGames] = useState<Game[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    Promise.all([adminGetWeekPicks(week), getGamesForWeek(week)])
      .then(([p, g]) => {
        setPicks(p);
        setGames(g);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [week]);

  const rows = useMemo(() => {
    const byPigeon: Record<
      number,
      {
        pigeon_number: number;
        pigeon_name: string;
        picks: Record<string, { signed: number; label: string; home_abbr: string; away_abbr: string }>;
      }
    > = {};
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
            <Box>
              {g.away_abbr} @ {g.home_abbr}
            </Box>
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

export default function AdminLocksAndPicks() {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [dialogValue, setDialogValue] = useState<Date | null>(null);
  const { currentWeek } = useSchedule();
  const [selectedWeek, setSelectedWeek] = useState<number | null>(null);
  const [weekLocks, setWeekLocks] = useState<AdminWeekLock[]>([]);
  const [games, setGames] = useState<Game[]>([]);
  const [lockError, setLockError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (currentWeek?.week) {
      setSelectedWeek(currentWeek.status === "scheduled" ? currentWeek.week : currentWeek.week + 1);
    }
  }, [currentWeek]);

  useEffect(() => {
    if (selectedWeek) {
      Promise.all([
        adminGetWeeksLocks(),
        getGamesForWeek(selectedWeek),
      ]).then(([locks, g]) => {
        setWeekLocks(locks);
        setGames(g);
      });
    }
  }, [selectedWeek]);

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
  const isFutureWeek = selectedWeek != null && selectedWeek > currentWeek.week;
  const isCurrentScheduled = selectedWeek === currentWeek.week && currentWeek.status === "scheduled";
  const eligible = isFutureWeek || isCurrentScheduled;
  const lockRow = weekLocks.find((l) => l.week_number === selectedWeek);
  const firstKickoff = games.length > 0 ? new Date(games[0].kickoff_at) : null;

  return (
    <Box sx={{ mt: 4 }}>
      {/* Text + Week selector on one line */}
      <Box sx={{ display: "flex", justifyContent: "center", alignItems: "center", gap: 2, my: 1 }}>
        <Typography variant="body1">Picks for</Typography>
        <LabeledSelect
          label="Week"
          value={selectedWeek ? String(selectedWeek) : ""}
          onChange={(e) => setSelectedWeek(Number(e.target.value))}
          options={
            nextUnstartedWeek <= 18
              ? Array.from({ length: 18 - nextUnstartedWeek + 1 }, (_, i) => nextUnstartedWeek + i).map((w) => ({ value: String(w), label: `Week ${w}` }))
              : []
          }
          sx={{ minWidth: 200 }}
        />
      </Box>

      {/* Admin lock control */}
      {eligible && lockRow && (
        <Box sx={{ alignContent: "center", mx: "auto" }}>
          <Box sx={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 2, my: 2 }}>
            <Typography variant="body1">Picks lock at {formatDateTimeNoYear(new Date(lockRow.lock_at))}</Typography>
            <Button
              variant="outlined"
              size="small"
              onClick={() => {
                setDialogValue(new Date(lockRow.lock_at));
                setDialogOpen(true);
              }}
            >
              Change
            </Button>
          </Box>
          {lockError && <Alert severity="error">{lockError}</Alert>}
          <Dialog open={dialogOpen} onClose={() => setDialogOpen(false)}>
            <DialogTitle sx={{ textAlign: "center" }}>Set New Lock Time</DialogTitle>
            <DialogContent>
              <Box sx={{ mt: 2 }}>
                <TextField
                  label="Lock Time"
                  type="datetime-local"
                  value={
                    dialogValue
                      ? (() => {
                          const dt = new Date(dialogValue.getTime() - dialogValue.getTimezoneOffset() * 60000);
                          return dt.toISOString().slice(0, 16);
                        })()
                      : ""
                  }
                  onChange={(e) => {
                    const val = e.target.value;
                    setDialogValue(val ? new Date(val) : null);
                  }}
                  slotProps={{
                    input: {
                      inputProps: {
                        min: (() => {
                          const base = new Date("2025-09-02T00:00:00-07:00");
                          base.setDate(base.getDate() + 7 * ((selectedWeek ?? 1) - 1));
                          return base.toISOString().slice(0, 16);
                        })(),
                        max: firstKickoff
                          ? (() => {
                              const dt = new Date(firstKickoff.getTime() - firstKickoff.getTimezoneOffset() * 60000);
                              return dt.toISOString().slice(0, 16);
                            })()
                          : undefined,
                      },
                    },
                  }}
                  fullWidth
                />
              </Box>
            </DialogContent>
            <DialogActions>
              <Button onClick={() => setDialogOpen(false)} disabled={submitting}>
                Cancel
              </Button>
              <Button
                onClick={async () => {
                  if (!dialogValue || !selectedWeek) return;
                  setLockError(null);
                  setSubmitting(true);
                  try {
                    await adminAdjustWeekLock(selectedWeek, dialogValue);
                    setDialogOpen(false);
                    setLockError(null);
                    const locks = await adminGetWeeksLocks();
                    setWeekLocks(locks);
                  } catch (e: unknown) {
                    setLockError(e instanceof Error ? e.message : String(e));
                  } finally {
                    setSubmitting(false);
                  }
                }}
                disabled={
                  submitting ||
                  !dialogValue ||
                  (dialogValue && new Date(lockRow.lock_at).getTime() === dialogValue.getTime())
                }
                variant="contained"
                color="primary"
              >
                Confirm
              </Button>
            </DialogActions>
          </Dialog>
        </Box>
      )}

      <ViewPicks week={selectedWeek ?? nextUnstartedWeek} />
    </Box>
  );
}