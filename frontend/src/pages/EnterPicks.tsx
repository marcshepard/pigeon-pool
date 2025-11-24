/**
 * Let the user make or edit their picks for a given week.
 */

import { useEffect, useMemo, useState, useRef, useCallback } from "react";
import { useAuth } from "../auth/useAuth";
import { useBeforeUnload, useLocation, useNavigate } from "react-router-dom";
import { Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, FormControl, FormControlLabel, Radio, RadioGroup, Stack, TextField, Typography } from "@mui/material";
import WarningAmberOutlinedIcon from '@mui/icons-material/WarningAmberOutlined';
import { alpha } from "@mui/material/styles";
import { AppSnackbar, Loading, Banner, ConfirmDialog, LabeledSelect } from "../components/CommonComponents";
import { getCurrentWeek, getGamesForWeek, getMyPicksForWeek, setMyPicks } from "../backend/fetch";
import type { Game } from "../backend/types";
import { useAppCache } from "../hooks/useAppCache";
import { PageFit, NORMAL_PAGE_MAX_WIDTH } from "../components/Layout";

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
  
  // Subscribe to currentWeek from Zustand for reactivity
  const currentWeek = useAppCache((s) => s.currentWeek?.data ?? null);
  const setCurrentWeekCache = useAppCache((s) => s.setCurrentWeek);
  
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
  // Track unsaved changes
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  // Track pending week/pigeon changes (for confirmation dialog)
  const [pendingChange, setPendingChange] = useState<{ type: 'week' | 'pigeon', value: number } | null>(null);
  // Track pending navigation (for confirmation dialog)
  const [pendingNavigation, setPendingNavigation] = useState<string | null>(null);
  const navigate = useNavigate();
  const location = useLocation();
  const handleHomeDoubleTap = useDoubleTap(() => setHomeDialogOpen(true));

  // Warn before closing/refreshing browser tab with unsaved changes
  useBeforeUnload(
    useCallback(
      (e) => {
        if (hasUnsavedChanges) {
          e.preventDefault();
          return (e.returnValue = '');
        }
      },
      [hasUnsavedChanges]
    ),
    { capture: true }
  );

  // Intercept navigation attempts when there are unsaved changes
  useEffect(() => {
    if (!hasUnsavedChanges) return;

    // Store the original navigate function
    const originalPushState = window.history.pushState;
    const originalReplaceState = window.history.replaceState;

    // Override history methods to intercept programmatic navigation
    window.history.pushState = function(...args) {
      const targetPath = args[2] as string;
      if (targetPath && targetPath !== location.pathname) {
        // Prevent the navigation and show dialog
        setPendingNavigation(targetPath);
        return;
      }
      return originalPushState.apply(window.history, args);
    };

    window.history.replaceState = function(...args) {
      const targetPath = args[2] as string;
      if (targetPath && targetPath !== location.pathname) {
        setPendingNavigation(targetPath);
        return;
      }
      return originalReplaceState.apply(window.history, args);
    };

    // Also intercept link clicks
    const handleClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const link = target.closest('a');
      
      if (link && link.href) {
        const url = new URL(link.href);
        // Only intercept internal navigation (same origin)
        if (url.origin === window.location.origin) {
          const targetPath = url.pathname;
          if (targetPath !== location.pathname) {
            e.preventDefault();
            e.stopPropagation();
            setPendingNavigation(targetPath);
          }
        }
      }
    };

    document.addEventListener('click', handleClick, true);

    return () => {
      // Restore original functions
      window.history.pushState = originalPushState;
      window.history.replaceState = originalReplaceState;
      document.removeEventListener('click', handleClick, true);
    };
  }, [hasUnsavedChanges, location.pathname]);

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

  // Load current week on mount if not cached, and set default week
  useEffect(() => {
    let cancelled = false;
    
    // If already cached, use it
    if (currentWeek) {
      const defaultWeek = currentWeek.week + 1;
      setWeek(defaultWeek ?? "");
      console.log("EnterPicks: using cached current week, default picks week:", defaultWeek);
      return;
    }
    
    // Otherwise fetch
    (async () => {
      try {
        const cw = await getCurrentWeek();
        console.log("EnterPicks: fetched current week:", cw);
        if (cancelled) return;
        setCurrentWeekCache(cw);
        const defaultWeek = cw.week + 1;
        setWeek(defaultWeek ?? "");
        console.log("EnterPicks: setting default picks week:", defaultWeek);
      } catch (e: unknown) {
        if (!cancelled) {
          setLoadingError(e instanceof Error ? e.message : "Failed to load schedule");
          setSnackbar({ open: true, message: "Failed to load schedule/current", severity: "error" });
        }
      }
    })();
    return () => { cancelled = true; };
  }, [currentWeek, setCurrentWeekCache]);

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
  const handleWeekChange = (newWeek: number) => {
    if (hasUnsavedChanges) {
      setPendingChange({ type: 'week', value: newWeek });
    } else {
      setWeek(newWeek);
      setHasUnsavedChanges(false);
    }
  };

  const handlePigeonChange = (newPigeon: number) => {
    if (hasUnsavedChanges) {
      setPendingChange({ type: 'pigeon', value: newPigeon });
    } else {
      setSelectedPigeon(newPigeon);
      setHasUnsavedChanges(false);
    }
  };

  const confirmDiscardChanges = () => {
    if (pendingChange?.type === 'week') {
      setWeek(pendingChange.value);
    } else if (pendingChange?.type === 'pigeon') {
      setSelectedPigeon(pendingChange.value);
    }
    setHasUnsavedChanges(false);
    setPendingChange(null);
  };

  const handlePick = (gameId: number, value: "home" | "away") => {
    setDraft((d) => {
      const prev = d[gameId] ?? { picked_home: value === "home", predicted_margin: 0 };
      const next = { ...d, [gameId]: { ...prev, picked_home: value === "home" } };
      return next;
    });
    setTouchedPickSide((m) => ({ ...m, [gameId]: true }));
    setHasUnsavedChanges(true);
  };

  const handleMargin = (gameId: number, raw: string) => {
    const digits = raw.replace(/[^0-9]/g, "").slice(0, 2);
    const n = digits === "" ? 0 : Math.max(0, Math.min(99, Number(digits)));
    setDraft((d) => ({ ...d, [gameId]: { ...d[gameId], predicted_margin: n } }));
    setHasUnsavedChanges(true);
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
      // Update lastSubmission to now
      setLastSubmission(new Date().toISOString());
      // Close dialog immediately once submission succeeds
      setSubmitDialog({ open: false, error: null });
      setSnackbar({ open: true, message: "Picks submitted!", severity: "success" });
      setHasUnsavedChanges(false);
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
    <PageFit maxWidth={NORMAL_PAGE_MAX_WIDTH}>
      {/* Navigation blocker dialog */}
      <ConfirmDialog
        open={!!pendingNavigation}
        title="Unsaved changes"
        content="You have unsaved picks. Continue and discard them?"
        confirmText="Yes"
        cancelText="No"
        onConfirm={() => {
          if (pendingNavigation) {
            setHasUnsavedChanges(false);
            navigate(pendingNavigation);
            setPendingNavigation(null);
          }
        }}
        onClose={() => setPendingNavigation(null)}
      />

      {/* Week/Pigeon change confirmation dialog */}
      <ConfirmDialog
        open={!!pendingChange}
        title="Unsaved changes"
        content="You have unsaved picks. Continue and discard them?"
        confirmText="Yes"
        cancelText="No"
        onConfirm={confirmDiscardChanges}
        onClose={() => setPendingChange(null)}
      />

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
            onChange={(e) => handleWeekChange(Number(e.target.value))}
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
                onChange={(e) => handlePigeonChange(Number(e.target.value))}
                options={allOptions}
              />
            );
          })()}
        </Box>
      )}

      {/* Unsaved changes warning banner - always visible above scrollable area */}
      {hasUnsavedChanges && (
        <Banner severity="warning" sx={{ mx: 0.5, mb: 1, display: 'flex', alignItems: 'center', gap: 1 }}>
          <WarningAmberOutlinedIcon sx={{ color: '#f57c00', verticalAlign: 'middle' }} />
          <span> Your changes are not yet submitted</span>
        </Banner>
      )}
      {/* Else show last submission time */}
      {!hasUnsavedChanges && lastSubmission && (
        <Banner severity="info" sx={{ mb: 2 }}>
          Last submission: {formatSubmissionTime(lastSubmission)}
        </Banner>
      )}

      {/* Scrollable picks area below header and selector */}
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
    </PageFit>
  );
}
