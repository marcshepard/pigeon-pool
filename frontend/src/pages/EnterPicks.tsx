/**
 * Let the user make or edit their picks for a given week.
 */

import { useEffect, useMemo, useState, useRef } from "react";
// Auto-refresh hook
function useAutoRefresh(
  shouldRefresh: boolean,
  refreshFn: () => void,
  intervalMinutes: number
) {
  const timerRef = useRef<number | null>(null);
  useEffect(() => {
    function startTimer() {
      if (shouldRefresh && document.visibilityState === "visible") {
        timerRef.current = window.setInterval(refreshFn, intervalMinutes * 60 * 1000);
      }
    }
    function stopTimer() {
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = null;
    }
    function handleVisibilityChange() {
      if (document.visibilityState === "visible") startTimer();
      else stopTimer();
    }
    stopTimer();
    startTimer();
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      stopTimer();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [shouldRefresh, refreshFn, intervalMinutes]);
}
import { useAuth } from "../auth/useAuth";
import { Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, FormControl, FormControlLabel, Radio, RadioGroup, Stack, TextField, Typography } from "@mui/material";
import { alpha } from "@mui/material/styles";
import { AppSnackbar, Loading, Banner, ConfirmDialog, LabeledSelect } from "../components/CommonComponents";
import { getCurrentWeek, getGamesForWeek, getMyPicksForWeek, setMyPicks } from "../backend/fetch";
import type { CurrentWeek, Game } from "../backend/types";

// Utility: detect double tap on mobile
function useDoubleTap(callback: () => void, ms = 300) {
  const lastTap = useRef<number>(0);
  return () => {
    const now = Date.now();
    if (now - lastTap.current < ms) {
      callback();
    }
    lastTap.current = now;
  };
}

// UI-only type for in-progress edits per game (keyed by game_id elsewhere)
type PickDraft = {
  picked_home: boolean;      // true = home, false = away
  predicted_margin: number;  // 0–99
};

// Helper to format last submission time as m/d h:m(am/pm)
function formatSubmissionTime(dt: string): string {
  const d = new Date(dt);
  const month = d.getMonth() + 1;
  const day = d.getDate();
  let hour = d.getHours();
  const min = d.getMinutes();
  const ampm = hour >= 12 ? "pm" : "am";
  hour = hour % 12;
  if (hour === 0) hour = 12;
  const minStr = min < 10 ? `0${min}` : String(min);
  return `${month}/${day} ${hour}:${minStr}${ampm}`;
}

export default function EnterPicksPage() {
  // State declarations
  const [lastSubmission, setLastSubmission] = useState<string | null>(null);
  const { me } = useAuth();
  const [selectedPigeon, setSelectedPigeon] = useState<number | null>(null);
  const [currentWeek, setCurrentWeek] = useState<CurrentWeek | null>(null);
  const [week, setWeek] = useState<number | "">("");
  const [games, setGames] = useState<Game[] | null>(null);
  const [draft, setDraft] = useState<Record<number, PickDraft>>({});
  const [loading, setLoading] = useState(false);
  const [loadingError, setLoadingError] = useState<string>("");
  const [snackbar, setSnackbar] = useState<{ open: boolean; message: string; severity?: "success" | "error" | "info" | "warning"; }>({ open: false, message: "" });
  const [confirmState, setConfirmState] = useState<{ open: boolean; message: string; pending: null | (() => Promise<void>) }>({ open: false, message: "", pending: null });
  const [homeDialogOpen, setHomeDialogOpen] = useState(false);
  const [submitDialog, setSubmitDialog] = useState<{ open: boolean; error: string | null }>({ open: false, error: null });
  const [touchedPickSide, setTouchedPickSide] = useState<Record<number, boolean>>({});
  const handleHomeDoubleTap = useDoubleTap(() => setHomeDialogOpen(true));

  // Determine if any game is in progress (kickoff passed, not final)
  const now = Date.now();
  const gamesInProgress = useMemo(() =>
    (games ?? []).some(g => {
      const kickoff = new Date(g.kickoff_at).getTime();
      return kickoff <= now && g.status !== "final";
    }),
    [games, now]
  );

  // Dialog for auto-update info
  const [autoUpdateDialogOpen, setAutoUpdateDialogOpen] = useState(false);
  // Auto-refresh interval from .env (required)
  const interval = Number(import.meta.env.VITE_AUTO_REFRESH_INTERVAL_MINUTES);
  // Auto-refresh games if in progress
  useAutoRefresh(gamesInProgress, () => {
    if (typeof week !== "number" || week < 1) return;
    (async () => {
      try {
        setLoading(true);
        setLoadingError("");
        setGames(null);
        setDraft({});
        setTouchedPickSide({});
        const [gs, picks] = await Promise.all([
          getGamesForWeek(week),
          getMyPicksForWeek(week, selectedPigeon ?? me?.pigeon_number),
        ]);
        const maxCreated = picks
          .map(p => p.created_at)
          .filter((dt): dt is string => !!dt)
          .sort()
          .reverse()[0] ?? null;
        setLastSubmission(maxCreated);
        const sorted = [...gs].sort((a, b) => {
          const at = new Date(a.kickoff_at).getTime();
          const bt = new Date(b.kickoff_at).getTime();
          return at !== bt ? at - bt : a.game_id - b.game_id;
        });
        const initial: Record<number, PickDraft> = {};
        for (const p of picks) {
          initial[p.game_id] = { picked_home: p.picked_home, predicted_margin: p.predicted_margin };
        }
        setGames(sorted);
        setDraft(initial);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : "Failed to load games or picks";
        setLoadingError(msg);
        setSnackbar({ open: true, message: msg, severity: "error" });
      } finally {
        setLoading(false);
      }
    })();
  }, interval);

  // ...removed duplicate declarations...

  // Auto-refresh games if in progress
  useAutoRefresh(gamesInProgress, () => {
    // Re-fetch games for the current week and pigeon
    if (typeof week !== "number" || week < 1) return;
    (async () => {
      try {
        setLoading(true);
        setLoadingError("");
        setGames(null);
        setDraft({});
        setTouchedPickSide({});
        const [gs, picks] = await Promise.all([
          getGamesForWeek(week),
          getMyPicksForWeek(week, selectedPigeon ?? me?.pigeon_number),
        ]);
        const maxCreated = picks
          .map(p => p.created_at)
          .filter((dt): dt is string => !!dt)
          .sort()
          .reverse()[0] ?? null;
        setLastSubmission(maxCreated);
        const sorted = [...gs].sort((a, b) => {
          const at = new Date(a.kickoff_at).getTime();
          const bt = new Date(b.kickoff_at).getTime();
          return at !== bt ? at - bt : a.game_id - b.game_id;
        });
        const initial: Record<number, PickDraft> = {};
        for (const p of picks) {
          initial[p.game_id] = { picked_home: p.picked_home, predicted_margin: p.predicted_margin };
        }
        setGames(sorted);
        setDraft(initial);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : "Failed to load games or picks";
        setLoadingError(msg);
        setSnackbar({ open: true, message: msg, severity: "error" });
      } finally {
        setLoading(false);
      }
    })();
  }, interval);
  // ...existing code...

  const handleHomeDialog = () => {
    setHomeDialogOpen(true);
  };
  const handleHomeDialogConfirm = () => {
    if (!games) return;
    // Set all picks to home by 3 (overwrite for all current games)
    setDraft(() => {
      const next: Record<number, PickDraft> = {};
      for (const g of games) {
        next[g.game_id] = { picked_home: true, predicted_margin: 3 };
      }
      return next;
    });
    setTimeout(() => {
      setHomeDialogOpen(false);
    }, 250);
  };

  // Load schedule/current once and pick a default week
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cw = await getCurrentWeek();
        console.log("EnterPicks: useEffect got current week:", cw);
        if (cancelled) return;
        setCurrentWeek(cw);
        const defaultWeek = cw.week + 1;
        setWeek(defaultWeek ?? "");
        console.log("EnterPicks: useEffect setting default picks week:", defaultWeek);
      } catch (e: unknown) {
        if (!cancelled) {
          setLoadingError(e instanceof Error ? e.message : "Failed to load schedule");
          setSnackbar({ open: true, message: "Failed to load schedule/current", severity: "error" });
        }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Future week options (next_picks_week..18), fallback start=1
  const futureWeeks = useMemo(() => {
    if (!currentWeek) return [];
    const start = currentWeek.week + 1;
    console.log("EnterPicks: useMemo using start week:", start);
    if (start == null) return [];
    const end = 18;
    const count = Math.max(0, end - start + 1);
    return Array.from({ length: count }, (_, i) => start + i);
  }, [currentWeek]);

  // Fetch games and filled picks whenever `week` changes
  useEffect(() => {
    if (typeof week !== "number" || week < 1) return;
    let cancelled = false;

    (async () => {
      try {
        setLoading(true);
        setLoadingError("");
        setGames(null);
        setDraft({});
        setTouchedPickSide({});

        const [gs, picks] = await Promise.all([
          getGamesForWeek(week),
          getMyPicksForWeek(week, selectedPigeon ?? me?.pigeon_number),
        ]);
        // Find latest created_at
        const maxCreated = picks
          .map(p => p.created_at)
          .filter((dt): dt is string => !!dt)
          .sort()
          .reverse()[0] ?? null;
        setLastSubmission(maxCreated);
        if (cancelled) return;

        // sort games by kickoff then game_id
        const sorted = [...gs].sort((a, b) => {
          const at = new Date(a.kickoff_at).getTime();
          const bt = new Date(b.kickoff_at).getTime();
          return at !== bt ? at - bt : a.game_id - b.game_id;
        });

        // Initialize draft directly from returned picks (already filled)
        const initial: Record<number, PickDraft> = {};
        for (const p of picks) {
          initial[p.game_id] = { picked_home: p.picked_home, predicted_margin: p.predicted_margin };
        }

        setGames(sorted);
        setDraft(initial);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : "Failed to load games or picks";
        if (!cancelled) {
          setLoadingError(msg);
          setSnackbar({ open: true, message: msg, severity: "error" });
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [week, selectedPigeon, me?.pigeon_number]);

  // — handlers —
  const handlePick = (gameId: number, value: "home" | "away") => {
    setDraft((d) => {
      const prev = d[gameId] ?? { picked_home: value === "home", predicted_margin: 0 };
      const next = { ...d, [gameId]: { ...prev, picked_home: value === "home" } };
      return next;
    });
    setTouchedPickSide((m) => ({ ...m, [gameId]: true }));
  };

  const handleMargin = (gameId: number, raw: string) => {
    const digits = raw.replace(/[^0-9]/g, "").slice(0, 2);
    const n = digits === "" ? 0 : Math.max(0, Math.min(99, Number(digits)));
    setDraft((d) => ({ ...d, [gameId]: { ...d[gameId], predicted_margin: n } }));
  };

  const handleSubmit = async () => {
    if (typeof week !== "number" || !games) return;


    // Helper to determine if a team has been explicitly chosen
    const isTeamChosen = (gid: number) => {
      const d = draft[gid];
      if (!d) return false;
      // If a saved pick exists (margin > 0), consider chosen. Otherwise require user touch.
      return d.predicted_margin > 0 || !!touchedPickSide[gid];
    };

    // Validate: each game must have a chosen team and a non-zero margin
    const zeroMargin = games.find((g) => draft[g.game_id]?.predicted_margin === 0);
    if (zeroMargin) {
      setSnackbar({ open: true, message: "All picks must have non-zero margins", severity: "warning" });
      return;
    }
    const missingTeam = games.find((g) => !isTeamChosen(g.game_id));
    if (missingTeam) {
      setSnackbar({ open: true, message: "Please make a pick and margin for every game.", severity: "warning" });
      return;
    }

    // New rule: any number > 50 should hard-fail submit
    const overFifty = games.find((g) => (draft[g.game_id]?.predicted_margin ?? 0) > 50);
    if (overFifty) {
      setSnackbar({ open: true, message: "Margins must be 50 or less.", severity: "warning" });
      return;
    }

    // New rule: if any number > 29, get confirmation before submitting
    const anyOverTwentyNine = games.some((g) => (draft[g.game_id]?.predicted_margin ?? 0) > 29);
    if (anyOverTwentyNine) {
      // Defer the actual submit until user confirms
      const performSubmit = async () => {
        // Re-enter the function beyond confirmation
        await actuallySubmit();
      };
      setConfirmState({
        open: true,
        message: "You have one or more spreads greater than 29. Are you sure you want to submit?",
        pending: performSubmit,
      });
      return;
    }

    await actuallySubmit();
  };

  const actuallySubmit = async () => {
    if (typeof week !== "number" || !games) return;
    // Prepare payload
    const picks = games.map((g) => ({
      game_id: g.game_id,
      picked_home: draft[g.game_id].picked_home,
      predicted_margin: draft[g.game_id].predicted_margin,
    }));

    try {
      // Show submitting dialog
      setSubmitDialog({ open: true, error: null });
  // Always pass selected pigeon (falls back to primary)
  await setMyPicks({ week_number: week, picks }, selectedPigeon ?? me?.pigeon_number);
      // Close dialog immediately once submission succeeds
      setSubmitDialog({ open: false, error: null });
      setSnackbar({ open: true, message: "Picks submitted!", severity: "success" });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Failed to submit picks";
      // Keep dialog open and show error
      setSubmitDialog({ open: true, error: msg });
      return;
    }

    // Re-fetch picks to reflect server-side normalization, if any (best-effort)
    try {
  const newPicks = await getMyPicksForWeek(week, selectedPigeon ?? me?.pigeon_number);
      const byGame: Record<number, PickDraft> = {};
      for (const p of newPicks) byGame[p.game_id] = { picked_home: p.picked_home, predicted_margin: p.predicted_margin };
      setDraft((prev) => {
        const updated: Record<number, PickDraft> = { ...prev };
        for (const g of games) if (byGame[g.game_id]) updated[g.game_id] = byGame[g.game_id];
        return updated;
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to refresh picks after submission";
      setSnackbar({ open: true, message: msg, severity: "error" });
    }
  };

  return (
    <Box sx={{ maxWidth: 900, mx: "auto", height: '100vh', display: 'flex', flexDirection: 'column' }}>
      {/* Confirmation dialog for >29 spreads */}
      <ConfirmDialog
        open={confirmState.open}
        title="Confirm submission"
        content={confirmState.message}
        confirmText="Submit"
        cancelText="Cancel"
        onConfirm={async () => {
          const pending = confirmState.pending;
          setConfirmState({ open: false, message: "", pending: null });
          if (pending) await pending();
        }}
        onClose={() => setConfirmState({ open: false, message: "", pending: null })}
      />
      {/* Fixed header within the picks page */}
      <Box
        sx={{
          position: "sticky",
          top: 0,
          left: 0,
          width: "100%",
          zIndex: 2,
          bgcolor: "background.paper",
          py: 1.5,
        }}
      >
        <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={2}>
          {/* Week selector (left) */}
          <LabeledSelect
            label="Week"
            value={String(week)}
            onChange={(e) => setWeek(Number(e.target.value))}
            options={futureWeeks.map((w) => ({ value: String(w), label: `Week ${w}` }))}
          />

          {/* Center: title w/ easter egg for fast "home team by 3" selection */}
          <Box sx={{ flex: 1, textAlign: "center" }}>
            <Typography
              variant="body1"
              fontWeight="bold"
              sx={{ userSelect: "none", cursor: "default" }}
              onDoubleClick={handleHomeDialog}
              onTouchEnd={(e) => {
                e.preventDefault();
                e.stopPropagation();
                handleHomeDoubleTap();
              }}
            >
              Enter picks
            </Typography>
          </Box>
      {/* Hidden dialog for home-by-3 */}
      <ConfirmDialog
        open={homeDialogOpen}
        title="Auto-select home teams by 3?"
        content={null}
        confirmText="Yes"
        cancelText="No"
        onConfirm={handleHomeDialogConfirm}
        onClose={() => setHomeDialogOpen(false)}
      />

          {/* Submit button (right) */}
          <Box sx={{ display: "flex", justifyContent: "flex-end" }}>
            <Button variant="contained" size="large" onClick={handleSubmit} disabled={submitDialog.open && !submitDialog.error}>
              Submit
            </Button>
          </Box>
        </Stack>
      </Box>


    {/* Pigeon selector below header if user is admin OR has alternates */}
    {me && (me.is_admin || (me.alternates && me.alternates.length > 0)) && (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 1 }}>
          {(() => {
            // Known pigeons: primary + alternates
            const knownNumbers = [me.pigeon_number, ...me.alternates.map(a => a.pigeon_number)];
            const knownOptions = [
              { value: String(me.pigeon_number), label: `${me.pigeon_number} ${me.pigeon_name}` },
              ...me.alternates.map(a => ({ value: String(a.pigeon_number), label: `${a.pigeon_number} ${a.pigeon_name}` }))
            ];
            const allOptions = [...knownOptions];
            if (me.is_admin) {
              // Add all numbers 1-68 not in knownNumbers
              for (let i = 1; i <= 68; ++i) {
                if (!knownNumbers.includes(i)) {
                  allOptions.push({ value: String(i), label: String(i) });
                }
              }
            }
            return (
              <LabeledSelect
                label="Pigeon"
                value={selectedPigeon ? String(selectedPigeon) : String(me.pigeon_number)}
                onChange={(e) => setSelectedPigeon(Number(e.target.value))}
                options={allOptions}
                sx={{ minWidth: 160 }}
              />
            );
          })()}
        </Box>
      )}

      {/* Auto-update info */}
      {gamesInProgress && (
        <Box sx={{ mb: 1 }}>
          <Typography variant="body1">
            Scores are <span style={{ textDecoration: 'underline', cursor: 'pointer', color: '#1976d2' }} onClick={() => setAutoUpdateDialogOpen(true)}>auto-updated</span>
          </Typography>
        </Box>
      )}
      {/* Auto-update dialog */}
      {autoUpdateDialogOpen && (
        <Box sx={{ position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh', bgcolor: 'rgba(0,0,0,0.3)', zIndex: 1300, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Box sx={{ bgcolor: 'background.paper', p: 3, borderRadius: 2, boxShadow: 3, minWidth: 300 }}>
            <Typography variant="h6" gutterBottom>Auto-updated Scores</Typography>
            <Typography variant="body1" gutterBottom>
              There is currently a lag of up to 30 minutes from live scores – we'll be optimizing this in the future.
            </Typography>
            <Button variant="contained" onClick={() => setAutoUpdateDialogOpen(false)}>Close</Button>
          </Box>
        </Box>
      )}
      {/* Scrollable picks area below header and selector */}
      <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto', px: 0.5, pt: 2 }}>
        {/* Last submission time */}
        {lastSubmission && (
          <Banner severity="info" sx={{ mb: 2 }}>
            Last submission: {formatSubmissionTime(lastSubmission)}
          </Banner>
        )}

        <AppSnackbar
          open={snackbar.open}
          message={snackbar.message}
          severity={snackbar.severity}
          onClose={() => setSnackbar((s) => ({ ...s, open: false }))}
        />

        {loading && <Loading error={loadingError} />}

        {!loading && loadingError && (
          <Banner severity="error" sx={{ mb: 2 }}>
            {loadingError}
          </Banner>
        )}

        {!loading && games && games.length === 0 && (
          <Banner severity="info" sx={{ mb: 2 }}>
            No games found
          </Banner>
        )}

        {!loading && games && games.length > 0 && (
          <Stack spacing={2}>
            {games.map((g) => {
              const d = draft[g.game_id];
              const kickoff = new Date(g.kickoff_at);
              const when = kickoff.toLocaleString(undefined, {
                weekday: "short",
                month: "short",
                day: "numeric",
                hour: "numeric",
                minute: "2-digit",
              });

              // Validation styling states
              const margin = d?.predicted_margin ?? 0;
              const isZero = margin === 0;
              const isOverFifty = margin > 50;
              const isWarn = margin > 29 && margin <= 50;
              const isError = isZero || isOverFifty;
              const teamChosen = d ? (d.predicted_margin > 0 || !!touchedPickSide[g.game_id]) : false;
              const needPickTeam = margin > 0 && !teamChosen;

              return (
                <Box
                  key={g.game_id}
                  sx={{
                    border: "1px solid",
                    borderColor: "divider",
                    borderRadius: 2,
                    p: 2,
                  }}
                >
                  <Stack
                    direction={{ xs: "column", sm: "row" }}
                    justifyContent="space-between"
                    alignItems={{ xs: "flex-start", sm: "center" }}
                    spacing={1.5}
                  >
                    <Box>
                      <Typography variant="subtitle1" fontWeight="bold">
                        {g.away_abbr} @ {g.home_abbr}
                      </Typography>
                      <Typography variant="body2" color="text.secondary">{when}</Typography>
                    </Box>

                    <Stack direction="row" spacing={3} alignItems="center" sx={{ width: { xs: "100%", sm: "auto" } }}>
                      {/* Pick side */}
                      <FormControl component="fieldset">
                        <RadioGroup
                          row
                          value={d && (d.predicted_margin > 0 || !!touchedPickSide[g.game_id]) ? (d.picked_home ? "home" : "away") : ""}
                          onChange={(_, val) => handlePick(g.game_id, val as "home" | "away")}
                        >
                          <FormControlLabel value="away" control={<Radio />} label={g.away_abbr} />
                          <FormControlLabel value="home" control={<Radio />} label={g.home_abbr} />
                        </RadioGroup>
                      </FormControl>

                      {/* Margin */}
                      <TextField
                        label="Spread"
                        type="text"
                        size="small"
                        value={isZero ? "" : String(margin)}
                        onChange={(e) => {
                          // If blank, treat as 0; else, use handler as before
                          const val = e.target.value.trim();
                          if (val === "") {
                            setDraft((d) => ({ ...d, [g.game_id]: { ...d[g.game_id], predicted_margin: 0 } }));
                          } else {
                            handleMargin(g.game_id, val);
                          }
                        }}
                        error={isError}
                        helperText={
                          isError
                            ? (isZero ? "Required" : "Max 50")
                            : needPickTeam
                              ? "pick a team"
                              : (isWarn ? "Very large" : " ")
                        }
                        sx={{
                          width: 100,
                          '& .MuiFormHelperText-root': { mt: 0.25 },
                          backgroundColor: (theme) =>
                            isError
                              ? alpha(theme.palette.error.main, 0.06)
                              : (needPickTeam || isWarn)
                                ? alpha(theme.palette.warning.main, 0.06)
                                : undefined,
                          transition: 'background 0.2s',
                          '& .MuiOutlinedInput-notchedOutline': {
                            borderColor: (theme) => ((needPickTeam || isWarn) ? theme.palette.warning.main : undefined),
                          },
                        }}
                        InputProps={{
                          // Let MUI error state handle error border color
                        }}
                        slotProps={{
                          input: {
                            inputProps: {
                              inputMode: "numeric",
                              pattern: "\\d{1,2}",
                              maxLength: 2,
                            },
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

      {/* Submitting dialog – shows spinner, and shows error if submission failed */}
      <Dialog
        open={submitDialog.open}
        onClose={() => {
          if (submitDialog.error) setSubmitDialog({ open: false, error: null });
        }}
        maxWidth="xs"
        fullWidth
        disableEscapeKeyDown={!submitDialog.error}
      >
        <DialogTitle sx={{ textAlign: 'center' }}>
          {submitDialog.error ? 'Submission failed' : 'Submitting picks…'}
        </DialogTitle>
        <DialogContent>
          <Loading error={submitDialog.error ?? undefined} />
        </DialogContent>
        {submitDialog.error && (
          <DialogActions sx={{ justifyContent: 'center', pt: 0 }}>
            <Button onClick={() => setSubmitDialog({ open: false, error: null })} variant="contained">Close</Button>
          </DialogActions>
        )}
      </Dialog>
    </Box>
  );
}
