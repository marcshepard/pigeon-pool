/**
 * Let the user make or edit their picks for a given week.
 */

import { useEffect, useMemo, useState, useRef } from "react";
import { Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, FormControl, FormControlLabel, Radio, RadioGroup, Stack, TextField, Typography } from "@mui/material";
import { alpha } from "@mui/material/styles";
import { AppSnackbar, Loading, Banner, ConfirmDialog, LabeledSelect } from "../components/CommonComponents";
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
import { getScheduleCurrent, getGamesForWeek, getMyPicksForWeek, setMyPicks } from "../backend/fetch";
import type { ScheduleCurrent, Game } from "../backend/types";

// UI-only type for in-progress edits per game (keyed by game_id elsewhere)
type PickDraft = {
  picked_home: boolean;      // true = home, false = away
  predicted_margin: number;  // 0–99
};

export default function EnterPicksPage() {
  const [current, setCurrent] = useState<ScheduleCurrent | null>(null);
  const [week, setWeek] = useState<number | "">("");
  const [games, setGames] = useState<Game[] | null>(null);
  const [draft, setDraft] = useState<Record<number, PickDraft>>({});
  const [loading, setLoading] = useState(false);
  const [loadingError, setLoadingError] = useState<string>("");
  const [snackbar, setSnackbar] = useState<{ open: boolean; message: string; severity?: "success" | "error" | "info" | "warning"; }>({ open: false, message: "" });
  const [confirmState, setConfirmState] = useState<{ open: boolean; message: string; pending: null | (() => Promise<void>) }>({ open: false, message: "", pending: null });
  const [homeDialogOpen, setHomeDialogOpen] = useState(false);
  const [submitDialog, setSubmitDialog] = useState<{ open: boolean; error: string | null }>({ open: false, error: null });
  const handleHomeDoubleTap = useDoubleTap(() => setHomeDialogOpen(true));

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
        const sc = await getScheduleCurrent();
        if (cancelled) return;
        setCurrent(sc);
        const defaultWeek = typeof sc.next_picks_week === "number" && sc.next_picks_week >= 1 ? sc.next_picks_week : 1;
        setWeek(defaultWeek);
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
    const start = current?.next_picks_week && current.next_picks_week >= 1 ? current.next_picks_week : 1;
    return Array.from({ length: 18 - start + 1 }, (_, i) => start + i);
  }, [current?.next_picks_week]);

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

        const [gs, picks] = await Promise.all([
          getGamesForWeek(week),
          getMyPicksForWeek(week), // now returns v_picks_filled rows
        ]);
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
  }, [week]);

  // — handlers —
  const handlePick = (gameId: number, value: "home" | "away") => {
    setDraft((d) => ({ ...d, [gameId]: { ...d[gameId], picked_home: value === "home" } }));
  };

  const handleMargin = (gameId: number, raw: string) => {
    const digits = raw.replace(/[^0-9]/g, "").slice(0, 2);
    const n = digits === "" ? 0 : Math.max(0, Math.min(99, Number(digits)));
    setDraft((d) => ({ ...d, [gameId]: { ...d[gameId], predicted_margin: n } }));
  };

  const handleSubmit = async () => {
    if (typeof week !== "number" || !games) return;


    // Validate: every game has a draft entry and non-zero margin
    const missing = games.find((g) => !draft[g.game_id]);
    if (missing) {
      setSnackbar({ open: true, message: "Please make a pick and margin for every game.", severity: "warning" });
      return;
    }
    const zeroMargin = games.find((g) => draft[g.game_id]?.predicted_margin === 0);
    if (zeroMargin) {
      setSnackbar({ open: true, message: "All picks must have non-zero margins", severity: "warning" });
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
      await setMyPicks({ week_number: week, picks });
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
      const newPicks = await getMyPicksForWeek(week);
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

  const titleWeek = typeof week === "number"
    ? week
    : current?.next_picks_week ?? (futureWeeks.length ? futureWeeks[0] : 1);


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

          {/* Title (center) */}
          <Typography
            variant="body1"
            fontWeight="bold"
            sx={{ flex: 1, textAlign: "center", userSelect: "none", cursor: "default" }}
            onDoubleClick={handleHomeDialog}
            onTouchEnd={(e) => {
              // Prevent generating a subsequent dblclick event on mobile
              e.preventDefault();
              e.stopPropagation();
              handleHomeDoubleTap();
            }}
          >
            Enter picks
          </Typography>
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

      {/* Scrollable picks area below header */}
      <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto', px: 0.5, pt: 2 }}>

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
            No games found for week {titleWeek}.
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
                          value={d && d.predicted_margin > 0 ? (d.picked_home ? "home" : "away") : ""}
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
                          isError ? (isZero ? "Required" : "Max 50") : (isWarn ? "Very large" : " ")
                        }
                        sx={{
                          width: 100,
                          '& .MuiFormHelperText-root': { mt: 0.25 },
                          backgroundColor: (theme) =>
                            isError
                              ? alpha(theme.palette.error.main, 0.06)
                              : isWarn
                                ? alpha(theme.palette.warning.main, 0.06)
                                : undefined,
                          transition: 'background 0.2s',
                          '& .MuiOutlinedInput-notchedOutline': {
                            borderColor: (theme) => (isWarn ? theme.palette.warning.main : undefined),
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
