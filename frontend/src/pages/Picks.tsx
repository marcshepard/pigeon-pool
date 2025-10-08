/**
 * Let the user make or edit their picks for a given week.
 */

import { useEffect, useMemo, useState } from "react";
import {
  Box,
  Typography,
  Stack,
  CircularProgress,
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
import { getScheduleCurrent, getGamesForWeek } from "../backend/fetch";
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
  const [err, setErr] = useState<string | null>(null);

  // Load schedule/current once
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const sc = await getScheduleCurrent();
        if (cancelled) return;
        setCurrent(sc);
        // Default to next_picks_week (if null, pick the next reasonable option)
        const defaultWeek =
          Number.isInteger(sc.next_picks_week) && sc.next_picks_week! >= 1
            ? (sc.next_picks_week as number)
            : // fallback: if season not started or unknown, choose 1
              1;
        setWeek(defaultWeek);
      } catch (e: any) {
        if (!cancelled) setErr(e?.message ?? "Failed to load schedule");
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
    setErr(null);
    setGames(null);
    setDraft({});
    getGamesForWeek(week)
      .then((gs) => {
        if (cancelled) return;
        // Sort by kickoff_at ascending, then by game_id
        const sorted = [...gs].sort((a, b) => {
          const at = new Date(a.kickoff_at).getTime();
          const bt = new Date(b.kickoff_at).getTime();
          if (at !== bt) return at - bt;
          return a.game_id - b.game_id;
        });
        // Initialize draft defaults
        const initialDraft: Record<number, PickDraft> = {};
        for (const g of sorted) {
          initialDraft[g.game_id] = { picked_home: null, predicted_margin: 0 };
        }
        setGames(sorted);
        setDraft(initialDraft);
      })
      .catch((e: any) => !cancelled && setErr(e?.message ?? "Failed to load games"))
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
    const n = Math.max(0, Number.isNaN(Number(value)) ? 0 : Math.floor(Number(value)));
    setDraft((d) => ({
      ...d,
      [gameId]: {
        ...d[gameId],
        predicted_margin: n,
      },
    }));
  };

  const handleSubmit = () => {
    // For now, just show the draft in console and alert.
    // Later, map this to your /picks/bulk payload.
    // payload: { week_number: week!, picks: [{ game_id, picked_home, predicted_margin }, ...] }
    console.log("Draft picks", { week, draft });
    alert("Submit not implemented yet.");
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

      {err && (
        <Alert severity="error" sx={{ mb: 2 }}>
          {err}
        </Alert>
      )}

      {loading && (
        <Stack alignItems="center" sx={{ py: 6 }}>
          <CircularProgress />
        </Stack>
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
                      type="number"
                      size="small"
                      inputProps={{ min: 0, step: 1 }}
                      value={d?.predicted_margin ?? 0}
                      onChange={(e) => handleMargin(g.game_id, e.target.value)}
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
