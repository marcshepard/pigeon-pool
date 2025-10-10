/**
 * Let the user make or edit their picks for a given week.
 */

import { useEffect, useMemo, useState } from "react";
import {
  Box,
  Typography,
  Stack,
  Alert,
  FormControl,
  RadioGroup,
  FormControlLabel,
  Radio,
  TextField,
  Button,
  Select,
  MenuItem,
  InputLabel,
} from "@mui/material";
import { getScheduleCurrent, getGamesForWeek, getMyPicksForWeek, upsertPicksBulk } from "../backend/fetch";
import { AppSnackbar, Loading } from "../components/CommonComponents";
import type { Game, ScheduleCurrent } from "../backend/types";

type PickDraft = {
  picked_home: boolean | null; // null = not chosen yet
  predicted_margin: number;    // >= 0
};

export default function PicksPage() {
  const [current, setCurrent] = useState<ScheduleCurrent | null>(null);
  const [week, setWeek] = useState<number | null>(null);
  const [games, setGames] = useState<Game[] | null>(null);
  const [draft, setDraft] = useState<Record<number, PickDraft>>({});
  const [loading, setLoading] = useState(false);
  const [loadingError, setLoadingError] = useState<string>("");
  const [snackbar, setSnackbar] = useState<{
    open: boolean;
    message: string;
    severity?: "success" | "error" | "info" | "warning";
  }>({ open: false, message: "" });

  // Load schedule/current once
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const sc = await getScheduleCurrent();
        if (cancelled) return;
        setCurrent(sc);
        // Default to next_picks_week (if null, pick the next reasonable option)
          let defaultWeek = 1;
          if (typeof sc.next_picks_week === "number" && sc.next_picks_week >= 1) {
            defaultWeek = sc.next_picks_week;
          }
          setWeek(defaultWeek);
      } catch (e: unknown) {
        if (!cancelled) {
          const message = e instanceof Error ? e.message : "Failed to load schedule";
          setLoadingError(message);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Compute the selectable future weeks (next_picks_week..18). If next is null, start at 1.
  const futureWeeks = useMemo(() => {
    const start =
      current?.next_picks_week && current.next_picks_week >= 1
        ? current.next_picks_week
        : 1;
    return Array.from({ length: 18 - start + 1 }, (_, i) => start + i);
  }, [current?.next_picks_week]);

  // Fetch games whenever `week` changes
  useEffect(() => {
    if (!week) return;
    let cancelled = false;
    setLoading(true);
    setGames(null);
    setDraft({});
    setLoadingError("");

    // Fetch games and user's picks in parallel
    Promise.all([getGamesForWeek(week), getMyPicksForWeek(week)])
      .then(([gs, picks]) => {
        if (cancelled) return;
        // Sort by kickoff_at ascending, then by game_id
        const sorted = [...gs].sort((a, b) => {
          const at = new Date(a.kickoff_at).getTime();
          const bt = new Date(b.kickoff_at).getTime();
          if (at !== bt) return at - bt;
          return a.game_id - b.game_id;
        });
        // Map picks by game_id for quick lookup
        const picksByGame: Record<number, { picked_home: boolean; predicted_margin: number }> = {};
        for (const p of picks) {
          picksByGame[p.game_id] = {
            picked_home: p.picked_home,
            predicted_margin: p.predicted_margin,
          };
        }
        // Initialize draft with picks if present, else defaults
        const initialDraft: Record<number, PickDraft> = {};
        for (const g of sorted) {
          if (picksByGame[g.game_id]) {
            initialDraft[g.game_id] = {
              picked_home: picksByGame[g.game_id].picked_home,
              predicted_margin: picksByGame[g.game_id].predicted_margin,
            };
          } else {
            initialDraft[g.game_id] = { picked_home: true, predicted_margin: 3 };
          }
        }
        setGames(sorted);
        setDraft(initialDraft);
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          const message = e instanceof Error ? e.message : "Failed to load games or picks";
          setLoadingError(message);
        }
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [week]);

  const handlePick = (gameId: number, value: "home" | "away") => {
    setDraft((d) => ({
      ...d,
      [gameId]: {
        ...d[gameId],
        picked_home: value === "home",
      },
    }));
  };

  const handleMargin = (gameId: number, value: string) => {
    // Accept only up to 2 digits, or empty string
    let n = 0;
    if (value === "") {
      n = 0;
    } else {
      n = Math.max(0, Math.min(99, Number(value.replace(/[^0-9]/g, ""))));
    }
    setDraft((d) => ({
      ...d,
      [gameId]: {
        ...d[gameId],
        predicted_margin: n,
      },
    }));
  };

  const handleSubmit = async () => {
    if (!week || !games) return;
  // setSubmitStatus("submitting");
  // setErr(null);
    // Validate: all games must have a pick and margin
    const incomplete = games.find((g) => {
      const d = draft[g.game_id];
      return !d || d.picked_home === null || isNaN(d.predicted_margin) || d.predicted_margin < 0;
    });
    if (incomplete) {
      setSnackbar({
        open: true,
        message: "Please make a pick and margin for every game.",
        severity: "warning",
      });
  // setSubmitStatus("idle");
      return;
    }
    const picks = games.map((g) => ({
      game_id: g.game_id,
      picked_home: draft[g.game_id].picked_home!,
      predicted_margin: draft[g.game_id].predicted_margin,
    }));
    try {
      await upsertPicksBulk({ week_number: week, picks });
  // setSubmitStatus("success");
      setSnackbar({
        open: true,
        message: "Picks submitted!",
        severity: "success",
      });
      // Optionally, reload picks to reflect any server-side changes
      const newPicks = await getMyPicksForWeek(week);
      const picksByGame: Record<number, { picked_home: boolean; predicted_margin: number }> = {};
      for (const p of newPicks) {
        picksByGame[p.game_id] = {
          picked_home: p.picked_home,
          predicted_margin: p.predicted_margin,
        };
      }
      setDraft((prev) => {
        const updated: Record<number, PickDraft> = { ...prev };
        for (const g of games) {
          if (picksByGame[g.game_id]) {
            updated[g.game_id] = {
              picked_home: picksByGame[g.game_id].picked_home,
              predicted_margin: picksByGame[g.game_id].predicted_margin,
            };
          }
        }
        return updated;
      });
    } catch (e: unknown) {
      let msg = "Failed to submit picks";
      if (e instanceof Error) msg = e.message;
  // setErr(msg);
      setSnackbar({
        open: true,
        message: msg,
        severity: "error",
      });
  // setSubmitStatus("idle");
      return;
    }
  // setTimeout(() => setSubmitStatus("idle"), 2000);
  };

  const titleWeek =
    week ?? current?.next_picks_week ?? (futureWeeks.length ? futureWeeks[0] : 1);

  return (
    <Box sx={{ p: { xs: 2, md: 3 }, maxWidth: 900, mx: "auto" }}>
      <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 2, gap: 2 }}>
        <Typography variant="body1" fontWeight="bold">
          Enter your picks for week {titleWeek}
        </Typography>

        <FormControl size="small" sx={{ minWidth: 160 }}>
          <InputLabel id="week-select-label">Week number</InputLabel>
          <Select
            labelId="week-select-label"
            label="Future Week"
            value={week ?? ""}
            onChange={(e) => setWeek(Number(e.target.value))}
          >
            {futureWeeks.map((w) => (
              <MenuItem key={w} value={w}>
                Week {w}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
      </Stack>

      <AppSnackbar
        open={snackbar.open}
        message={snackbar.message}
        severity={snackbar.severity}
        onClose={() => setSnackbar((s) => ({ ...s, open: false }))}
      />

      {loading && (
        <Loading error={loadingError} />
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
                    <Typography variant="body2" color="text.secondary">
                      {when}
                    </Typography>
                  </Box>

                  <Stack direction="row" spacing={3} alignItems="center" sx={{ width: { xs: "100%", sm: "auto" } }}>
                    {/* Pick side */}
                    <FormControl component="fieldset">
                      <RadioGroup
                        row
                        value={d?.picked_home === null ? "" : d?.picked_home ? "home" : "away"}
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
                      inputProps={{ inputMode: "numeric", pattern: "\\d{1,2}", maxLength: 2 }}
                      value={
                        typeof d?.predicted_margin === "number" && d.predicted_margin >= 0
                          ? String(d.predicted_margin)
                          : ""
                      }
                      onChange={(e) => {
                        // Only allow up to 2 digits, numeric only
                        const val = e.target.value.replace(/[^0-9]/g, "").slice(0, 2);
                        handleMargin(g.game_id, val);
                      }}
                      sx={{ width: 100 }}
                    />
                  </Stack>
                </Stack>
              </Box>
            );
          })}

          <Box sx={{ display: "flex", justifyContent: "flex-end", mt: 1 }}>
            <Button variant="contained" size="large" onClick={handleSubmit}>
              Submit Picks
            </Button>
          </Box>
        </Stack>
      )}
    </Box>
  );
}
