/**
 * Let the user make or edit their picks for a given week.
 */

import { useEffect, useMemo, useState } from "react";
import {
  Box, Stack, Typography, FormControl, InputLabel, Select, MenuItem,
  Alert, Button, RadioGroup, FormControlLabel, Radio, TextField
} from "@mui/material";
import { AppSnackbar, Loading } from "../components/CommonComponents";
import { getScheduleCurrent, getGamesForWeek, getMyPicksForWeek, setMyPicks } from "../backend/fetch";
import type { ScheduleCurrent, Game } from "../backend/types";

// UI-only type for in-progress edits per game (keyed by game_id elsewhere)
type PickDraft = {
  picked_home: boolean;      // true = home, false = away
  predicted_margin: number;  // 0–99
};

export default function PicksPage() {
  const [current, setCurrent] = useState<ScheduleCurrent | null>(null);
  const [week, setWeek] = useState<number | "">("");
  const [games, setGames] = useState<Game[] | null>(null);
  const [draft, setDraft] = useState<Record<number, PickDraft>>({});
  const [loading, setLoading] = useState(false);
  const [loadingError, setLoadingError] = useState<string>("");
  const [snackbar, setSnackbar] = useState<{ open: boolean; message: string; severity?: "success" | "error" | "info" | "warning"; }>({ open: false, message: "" });

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

    // Validate: every game has a draft entry
    const missing = games.find((g) => !draft[g.game_id]);
    if (missing) {
      setSnackbar({ open: true, message: "Please make a pick and margin for every game.", severity: "warning" });
      return;
    }

    // Prepare payload
    const picks = games.map((g) => ({
      game_id: g.game_id,
      picked_home: draft[g.game_id].picked_home,
      predicted_margin: draft[g.game_id].predicted_margin,
    }));

    try {
      await setMyPicks({ week_number: week, picks });
      setSnackbar({ open: true, message: "Picks submitted!", severity: "success" });

      // Re-fetch picks to reflect server-side normalization, if any
      const newPicks = await getMyPicksForWeek(week);
      const byGame: Record<number, PickDraft> = {};
      for (const p of newPicks) byGame[p.game_id] = { picked_home: p.picked_home, predicted_margin: p.predicted_margin };
      setDraft((prev) => {
        const updated: Record<number, PickDraft> = { ...prev };
        for (const g of games) if (byGame[g.game_id]) updated[g.game_id] = byGame[g.game_id];
        return updated;
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Failed to submit picks";
      setSnackbar({ open: true, message: msg, severity: "error" });
    }
  };

  const titleWeek = typeof week === "number"
    ? week
    : current?.next_picks_week ?? (futureWeeks.length ? futureWeeks[0] : 1);


  return (
    <Box sx={{ maxWidth: 900, mx: "auto", height: '100vh', display: 'flex', flexDirection: 'column' }}>
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
          <FormControl size="small">
            <InputLabel id="week-select-label">Week</InputLabel>
            <Select
              labelId="week-select-label"
              label="Week"
              value={week}
              onChange={(e) => setWeek(Number(e.target.value))}
            >
              {futureWeeks.map((w) => (
                <MenuItem key={w} value={w}>Week {w}</MenuItem>
              ))}
            </Select>
          </FormControl>

          {/* Title (center) */}
          <Typography variant="body1" fontWeight="bold" sx={{ flex: 1, textAlign: "center" }}>
            Enter picks
          </Typography>

          {/* Submit button (right) */}
          <Box sx={{ display: "flex", justifyContent: "flex-end" }}>
            <Button variant="contained" size="large" onClick={handleSubmit}>
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
          <Alert severity="error" sx={{ mb: 2 }}>
            {loadingError}
          </Alert>
        )}

        {!loading && games && games.length === 0 && (
          <Alert severity="info" sx={{ mb: 2 }}>
            No games found for week {titleWeek}.
          </Alert>
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

              return (
                <Box key={g.game_id} sx={{ border: "1px solid", borderColor: "divider", borderRadius: 2, p: 2 }}>
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
                          value={d?.picked_home ? "home" : "away"}
                          onChange={(_, val) => handlePick(g.game_id, val as "home" | "away")}
                        >
                          <FormControlLabel value="away" control={<Radio />} label={g.away_abbr} />
                          <FormControlLabel value="home" control={<Radio />} label={g.home_abbr} />
                        </RadioGroup>
                      </FormControl>

                      {/* Margin */}
                      <TextField
                        label="Margin"
                        type="text"
                        size="small"
                        value={String(d?.predicted_margin ?? 0)}
                        onChange={(e) => handleMargin(g.game_id, e.target.value)}
                        sx={{ width: 100 }}
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
    </Box>
  );
}
