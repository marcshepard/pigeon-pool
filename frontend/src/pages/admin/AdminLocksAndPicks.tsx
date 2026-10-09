// =============================================
// File: src/pages/admin/AdminLocksAndPicks.tsx
// (Refactor of your current Admin.tsx content)
// =============================================
import { useState, useEffect, useMemo, useRef } from "react";
import {
  Alert,
  Box,
  Button,
  Chip,
  FormControlLabel,
  Radio,
  RadioGroup,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from "@mui/material";
import { useSchedule } from "../../hooks/useSchedule";
import { useAuth } from "../../auth/useAuth";
import {
  getGamesForWeek,
  adminGetWeeksLocks,
  adminAdjustWeekLock,
  adminGetWeekPicks,
  adminGetWeekPickStatus,
  adminBulkImportPicks,
} from "../../backend/fetch";
import {
    AdminWeekLock,
    AdminWeekLockUpdate,
    Game,
    PickStatusRow,
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

const PACIFIC_TIME_ZONE = "America/Los_Angeles";
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function pacificDateTime(value: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: PACIFIC_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(value);
  const part = (type: string) => parts.find((p) => p.type === type)?.value;
  return part("year") + "-" + part("month") + "-" + part("day") + "T" + part("hour") + ":" + part("minute");
}

function fromPacificDateTime(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const clock = Date.parse(value + "Z");
  if (!Number.isFinite(clock)) return null;
  let instant = clock;
  for (let pass = 0; pass < 3; pass++) {
    const displayedClock = Date.parse(pacificDateTime(new Date(instant)) + "Z");
    instant += clock - displayedClock;
  }
  const result = new Date(instant);
  // Reject nonexistent local times during the spring DST transition.
  return pacificDateTime(result) === value ? result : null;
}

function recurringLockTime(kickoff: Date | null, weekday: number, time: string): Date | null {
  if (!kickoff) return null;
  const date = new Date(pacificDateTime(kickoff).slice(0, 10) + "T00:00:00Z");
  const daysSinceTuesday = (date.getUTCDay() - 2 + 7) % 7;
  date.setUTCDate(date.getUTCDate() - daysSinceTuesday + (weekday - 2 + 7) % 7);
  return fromPacificDateTime(date.toISOString().slice(0, 10) + "T" + time);
}

function deadlineMeaning(weekday: number, time: string): string {
  const day = WEEKDAYS[weekday];
  if (time === "00:00") return "Picks close at the start of " + day + "—" + WEEKDAYS[(weekday + 6) % 7] + " night.";
  if (time === "12:00") return "Picks close " + day + " at noon.";
  if (time === "23:59") return "Picks close at the end of " + day + ".";
  const [hour, minute] = time.split(":").map(Number);
  return "Picks close " + day + " at " + (hour % 12 || 12) + ":" + String(minute).padStart(2, "0") + " " + (hour < 12 ? "AM" : "PM") + ".";
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

type StatusFilter = "not_submitted" | "submitted" | "all";

/**
 * Pre-lock view: shows only whether each pigeon has entered picks, never the
 * picks themselves, so the commissioner can nag non-submitters without gaining
 * an unfair preview of everyone's margins.
 */
function PickStatus({ week }: { week: number }) {
  const [rows, setRows] = useState<PickStatusRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<StatusFilter>("not_submitted");

  useEffect(() => {
    setLoading(true);
    setError(null);
    adminGetWeekPickStatus(week)
      .then(setRows)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [week]);

  const notSubmitted = rows.filter((r) => !r.submitted);
  const submitted = rows.filter((r) => r.submitted);
  const visible =
    filter === "not_submitted" ? notSubmitted : filter === "submitted" ? submitted : rows;

  return (
    <Box p={3}>
      {loading && <Alert severity="info">Loading…</Alert>}
      {error && <Alert severity="error">{error}</Alert>}
      {!loading && !error && (
        <Stack spacing={2} alignItems="center">
          <ToggleButtonGroup
            size="small"
            exclusive
            value={filter}
            onChange={(_, next: StatusFilter | null) => next && setFilter(next)}
          >
            <ToggleButton value="not_submitted">
              Not submitted ({notSubmitted.length})
            </ToggleButton>
            <ToggleButton value="submitted">Submitted ({submitted.length})</ToggleButton>
            <ToggleButton value="all">All ({rows.length})</ToggleButton>
          </ToggleButtonGroup>

          <TableContainer component={Paper} variant="outlined" sx={{ maxWidth: 480 }}>
            <Table size="small" aria-label={`Pick status for week ${week}`}>
              <TableHead>
                <TableRow>
                  <TableCell align="right" sx={{ width: 72 }}>Number</TableCell>
                  <TableCell>Pigeon</TableCell>
                  <TableCell sx={{ width: 130 }}>Status</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {visible.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={3} align="center">
                      No pigeons match this filter.
                    </TableCell>
                  </TableRow>
                ) : (
                  visible.map((r) => (
                    <TableRow key={r.pigeon_number} hover>
                      <TableCell align="right">{r.pigeon_number}</TableCell>
                      <TableCell sx={{ overflowWrap: "anywhere" }}>{r.pigeon_name}</TableCell>
                      <TableCell>
                        <Chip
                          size="small"
                          variant="outlined"
                          color={r.submitted ? "success" : "warning"}
                          label={r.submitted ? "Submitted" : "Not submitted"}
                        />
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </TableContainer>
        </Stack>
      )}
    </Box>
  );
}

export default function AdminLocksAndPicks() {
  const { me } = useAuth();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [applyToFutureWeeks, setApplyToFutureWeeks] = useState(false);
  const [dialogDateTime, setDialogDateTime] = useState("");
  const [repeatWeekday, setRepeatWeekday] = useState(3);
  const [repeatTime, setRepeatTime] = useState("23:59");
  const { currentWeek } = useSchedule();
  const [selectedWeek, setSelectedWeek] = useState<number | null>(null);
  const [weekLocks, setWeekLocks] = useState<AdminWeekLock[]>([]);
  const [games, setGames] = useState<Game[]>([]);
  const [lockError, setLockError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [lockUpdate, setLockUpdate] = useState<AdminWeekLockUpdate | null>(null);

  // Bulk Import Picks state
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<{ success: boolean; message: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const importWeek = currentWeek ? currentWeek.week : 1;

  const handleImport = async () => {
    if (!importFile) return;
    setImporting(true);
    setImportResult(null);
    try {
      const res = await adminBulkImportPicks(importWeek, importFile);
      setImportResult({ success: true, message: `Imported ${res} picks for week ${importWeek}.` });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Import failed.";
      setImportResult({ success: false, message: msg });
    } finally {
      setImporting(false);
    }
  };

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

  const dialogValue = applyToFutureWeeks
    ? recurringLockTime(firstKickoff, repeatWeekday, repeatTime)
    : fromPacificDateTime(dialogDateTime);
  const previewDateTime = dialogValue ? pacificDateTime(dialogValue) : null;
  const previewWeekday = applyToFutureWeeks
    ? repeatWeekday
    : previewDateTime ? new Date(previewDateTime.slice(0, 10) + "T00:00:00Z").getUTCDay() : null;
  const previewTime = applyToFutureWeeks ? repeatTime : previewDateTime?.slice(11);
  const deadlineLabel = dialogValue?.toLocaleString("en-US", {
    weekday: "long", hour: "numeric", minute: "2-digit", timeZone: PACIFIC_TIME_ZONE,
  });

  // Before a week locks, players must not see each other's picks, so the
  // commissioner only gets submission status. Once locked, the full grid is safe.
  const shownWeek = selectedWeek ?? nextUnstartedWeek;
  const shownWeekLock = weekLocks.find((l) => l.week_number === shownWeek);
  const shownWeekLocked = shownWeekLock != null && shownWeekLock.lock_at.getTime() <= Date.now();

  return (
    <Box sx={{ mt: 4 }}>
      {/* Bulk Import Picks xlsx — only available for the original tenant */}
      {me?.tenant_id === 1 && <Box sx={{ mb: 3, textAlign: "left" }}>
        <Button
          variant="contained"
          color="secondary"
          onClick={() => setImportDialogOpen(true)}
        >
          Import picks xlsx for week {importWeek}
        </Button>
        <Dialog open={importDialogOpen} onClose={importing ? undefined : () => setImportDialogOpen(false)} maxWidth="xs" fullWidth>
          <DialogTitle>Import Picks for Week {importWeek}</DialogTitle>
          <DialogContent>
            <Box sx={{ my: 2 }}>
              <input
                ref={fileInputRef}
                type="file"
                accept=".xlsx"
                style={{ display: "none" }}
                onChange={e => setImportFile(e.target.files?.[0] || null)}
                disabled={importing || !!importResult}
              />
              <Button
                variant="outlined"
                onClick={() => fileInputRef.current?.click()}
                disabled={importing || !!importResult}
                sx={{ mb: 1 }}
              >
                {importFile ? importFile.name : "Choose XLSX file"}
              </Button>
            </Box>
            {importResult && (
              <Alert severity={importResult.success ? "success" : "error"}>{importResult.message}</Alert>
            )}
          </DialogContent>
          <DialogActions>
            {!importResult ? (
              <>
                <Button onClick={() => setImportDialogOpen(false)} disabled={importing}>Cancel</Button>
                <Button
                  variant="contained"
                  onClick={handleImport}
                  disabled={importing || !importFile}
                >
                  {importing ? "Importing..." : "Import"}
                </Button>
              </>
            ) : (
              <Button onClick={() => {
                setImportDialogOpen(false);
                setImportFile(null);
                setImportResult(null);
              }} variant="contained">Dismiss</Button>
            )}
          </DialogActions>
        </Dialog>
      </Box>}
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
                setApplyToFutureWeeks(false);
                const initial = pacificDateTime(new Date(lockRow.lock_at));
                setDialogDateTime(initial);
                setRepeatWeekday(new Date(initial.slice(0, 10) + "T00:00:00Z").getUTCDay());
                setRepeatTime(initial.slice(11));
                setLockError(null);
                setDialogOpen(true);
              }}
            >
              Change
            </Button>
          </Box>
          {lockUpdate && lockUpdate.skipped_weeks.length > 0 && (
            <Alert severity="warning" onClose={() => setLockUpdate(null)} sx={{ mb: 2 }}>
              <Typography variant="body2" fontWeight={700}>
                {lockUpdate.updated_weeks.length > 0
                  ? "Lock times updated. These weeks were left unchanged:"
                  : "No lock times changed."}
              </Typography>
              {lockUpdate.skipped_weeks.map((exception) => {
                const format = (date: Date) => date.toLocaleString("en-US", {
                  weekday: "long", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
                  timeZone: PACIFIC_TIME_ZONE,
                });
                return (
                  <Typography key={exception.week_number} variant="body2" sx={{ mt: 1 }}>
                    {exception.lock_at
                      ? "Leaving week " + exception.week_number + " lock time as " + format(exception.lock_at) + " Pacific Time."
                      : "Week " + exception.week_number + " still has no lock time set."}
                    {exception.reason === "after_kickoff"
                      ? " Its first game is at " + format(exception.first_kickoff) + " Pacific Time, before the requested deadline."
                      : exception.reason === "started"
                        ? " Its games have already started."
                        : " The requested deadline would be in the past."}
                  </Typography>
                );
              })}
            </Alert>
          )}
          {!dialogOpen && lockError && <Alert severity="error">{lockError}</Alert>}
          <Dialog open={dialogOpen} onClose={submitting ? undefined : () => setDialogOpen(false)} maxWidth="sm" fullWidth>
            <DialogTitle>Set New Lock Time</DialogTitle>
            <DialogContent>
              <Stack spacing={2} sx={{ mt: 1 }}>
                {lockError && <Alert severity="error">{lockError}</Alert>}
                <RadioGroup
                  aria-label="Apply lock time to"
                  value={applyToFutureWeeks ? "future" : "single"}
                  onChange={(e) => { setApplyToFutureWeeks(e.target.value === "future"); setLockError(null); }}
                >
                  <FormControlLabel value="single" control={<Radio disabled={submitting} />} label="This week only" />
                  <FormControlLabel value="future" control={<Radio disabled={submitting} />} label="This and future weeks" />
                </RadioGroup>
                {applyToFutureWeeks ? (
                  <Stack spacing={2}>
                    <LabeledSelect
                      label="Day of the week"
                      value={String(repeatWeekday)}
                      onChange={(e) => setRepeatWeekday(Number(e.target.value))}
                      options={WEEKDAYS.map((day, index) => ({ value: String(index), label: day }))}
                      disabled={submitting}
                    />
                    <Stack direction="row" spacing={1}>
                      <LabeledSelect
                        label="Hour"
                        value={String(Number(repeatTime.slice(0, 2)) % 12 || 12)}
                        onChange={(e) => {
                          const hour = Number(e.target.value) % 12 + (Number(repeatTime.slice(0, 2)) >= 12 ? 12 : 0);
                          setRepeatTime(String(hour).padStart(2, "0") + repeatTime.slice(2));
                        }}
                        options={Array.from({ length: 12 }, (_, i) => ({ value: String(i + 1), label: String(i + 1) }))}
                        disabled={submitting}
                        sx={{ flex: 1 }}
                      />
                      <LabeledSelect
                        label="Minute"
                        value={repeatTime.slice(3)}
                        onChange={(e) => setRepeatTime(repeatTime.slice(0, 3) + e.target.value)}
                        options={Array.from({ length: 60 }, (_, i) => ({ value: String(i).padStart(2, "0"), label: String(i).padStart(2, "0") }))}
                        disabled={submitting}
                        sx={{ flex: 1 }}
                      />
                      <LabeledSelect
                        label="AM / PM"
                        value={Number(repeatTime.slice(0, 2)) >= 12 ? "PM" : "AM"}
                        onChange={(e) => {
                          const hour = Number(repeatTime.slice(0, 2)) % 12 + (e.target.value === "PM" ? 12 : 0);
                          setRepeatTime(String(hour).padStart(2, "0") + repeatTime.slice(2));
                        }}
                        options={[{ value: "AM", label: "AM" }, { value: "PM", label: "PM" }]}
                        disabled={submitting}
                        sx={{ flex: 1 }}
                      />
                    </Stack>
                  </Stack>
                ) : (
                  <TextField
                    label="Date and time"
                    disabled={submitting}
                    type="datetime-local"
                    value={dialogDateTime}
                    onChange={(e) => setDialogDateTime(e.target.value)}
                    slotProps={{ input: { inputProps: { max: firstKickoff ? pacificDateTime(firstKickoff) : undefined } } }}
                    fullWidth
                  />
                )}
                <Typography variant="body2" color="text.secondary">All times are Pacific Time.</Typography>
                {previewWeekday !== null && previewTime && (
                  <Alert severity="info">
                    <Typography variant="body2" fontWeight={700}>
                      {deadlineMeaning(previewWeekday, previewTime)}
                    </Typography>
                    <Typography variant="body2">Pacific Time.</Typography>
                    {applyToFutureWeeks ? (
                      <Typography variant="body2" sx={{ mt: 1 }}>
                        Applies to week {selectedWeek} and later
                      </Typography>
                    ) : (
                      <Typography variant="body2" sx={{ mt: 1 }}>
                        Applies to week {selectedWeek} only, on {dialogValue?.toLocaleDateString("en-US", {
                          month: "long", day: "numeric", year: "numeric", timeZone: PACIFIC_TIME_ZONE,
                        })}.
                      </Typography>
                    )}
                  </Alert>
                )}
              </Stack>
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
                    const result = await adminAdjustWeekLock(selectedWeek, dialogValue, applyToFutureWeeks);
                    setLockUpdate(result);
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
                  (!applyToFutureWeeks && dialogValue && new Date(lockRow.lock_at).getTime() === dialogValue.getTime())
                }
                variant="contained"
                color="primary"
              >
                {submitting ? "Saving…" : deadlineLabel ? "Set " + deadlineLabel : "Set lock time"}
              </Button>
            </DialogActions>
          </Dialog>
        </Box>
      )}

      {shownWeekLocked ? (
        <ViewPicks week={shownWeek} />
      ) : (
        <PickStatus week={shownWeek} />
      )}
    </Box>
  );
}