/**
 * MNF possible outcomes (that Andy sends Sunday nights)
 */

// src/pages/MnfOutcomesPage.tsx
import React, { useMemo } from "react";
import { Box, Typography, Stack, Table, TableHead, TableRow, TableCell, TableBody, Divider } from "@mui/material";
import { useSchedule } from "../hooks/useSchedule";
import { useResults } from "../hooks/useResults";
import { useMnfOutcomes } from "../hooks/useMnfOutcomes"; // the hook you asked for (aka useMnfWhatIf)
import type { GameMeta } from "../hooks/useAppCache";

function isSunday(dt: Date) { return dt.getDay() === 0; } // 0=Sun
function isMonday(dt: Date) { return dt.getDay() === 1; } // 1=Mon

function endOfLocalMondayForWeek(games: GameMeta[]): Date | null {
  // Prefer a Monday game to anchor the Monday date.
  const mondayGame = games.find(g => {
    if (!g.kickoff_at) return false;
    const d = new Date(g.kickoff_at);
    return isMonday(d);
  });
  if (mondayGame) {
    const d = new Date(mondayGame.kickoff_at!);
    const end = new Date(d); end.setHours(23, 59, 59, 999);
    return end;
  }
  // Fallback: derive Monday from any game by finding the Sunday of that week, then +1 day.
  if (games.length) {
    const any = new Date(games[0].kickoff_at!);
    const sunday = new Date(any);
    // shift back to Sunday
    const delta = (sunday.getDay() + 7 - 0) % 7; // days since Sunday
    sunday.setHours(0,0,0,0);
    sunday.setDate(sunday.getDate() - delta);
    const monday = new Date(sunday);
    monday.setDate(monday.getDate() + 1);
    monday.setHours(23,59,59,999);
    return monday;
  }
  return null;
}

function allSundayGamesFinal(games: GameMeta[]): boolean {
  const sundayGames = games.filter(g => {
    if (!g.kickoff_at) return false;
    return isSunday(new Date(g.kickoff_at));
  });
  if (sundayGames.length === 0) return false; // conservative: don't show early
  return sundayGames.every(g => g.status === "final");
}

export default function MnfOutcomesPage() {
  // Week selector logic
  const { schedule, lockedWeeks, loading: scheduleLoading } = useSchedule();
  const liveWeek = schedule?.live_week ?? null;

  // Default week: liveWeek if available, else last locked week
  const [week, setWeek] = React.useState<number | "">("");
  React.useEffect(() => {
    if (week === "" && lockedWeeks.length) {
      setWeek(liveWeek ?? lockedWeeks[lockedWeeks.length - 1]);
    }
  }, [lockedWeeks, liveWeek, week]);

  const { rows, games, weekState, loading, error } = useResults(typeof week === "number" ? week : null);
  const whatIf = useMnfOutcomes(typeof week === "number" ? week : null, rows, games);

  // Only show the 'come back after Sunday' message for the current week (not completed weeks)
  const { shouldShow, endOfMonday } = useMemo(() => {
    const now = new Date();
    const sundayDone = allSundayGamesFinal(games);
    const eom = endOfLocalMondayForWeek(games);
    // If the selected week is completed, always show outcomes (if available)
    if (weekState === "completed") {
      return { shouldShow: true, endOfMonday: eom };
    }
    // Otherwise, use the original logic for the current week
    const withinWindow = sundayDone && (!!eom && now <= eom);
    return { shouldShow: withinWindow, endOfMonday: eom };
  }, [games, weekState]);

  // Loading states
  if (loading || scheduleLoading) {
    return (
      <Box sx={{ maxWidth: 1000, mx: "auto", p: 2 }}>
        <Typography variant="body1">Loading MNF outcomes…</Typography>
      </Box>
    );
  }

  if (error) {
    return (
      <Box sx={{ maxWidth: 1000, mx: "auto", p: 2 }}>
        <Typography variant="body2" color="error">Error: {error}</Typography>
      </Box>
    );
  }

  // Week selector UI
  const weekSelector = (
    <Box sx={{ mb: 2, display: "flex", alignItems: "center", gap: 2 }}>
      <Typography variant="body1" fontWeight="bold">Week:</Typography>
      <select
        value={week}
        onChange={e => setWeek(Number(e.target.value))}
        disabled={lockedWeeks.length === 0}
        style={{ fontSize: "1rem", padding: "0.25em 0.5em" }}
      >
        {lockedWeeks.map(w => (
          <option key={w} value={w}>Week {w}</option>
        ))}
      </select>
    </Box>
  );

  if (!shouldShow) {
    return (
      <Box sx={{ maxWidth: 1000, mx: "auto", p: 2 }}>
        {weekSelector}
        <Typography variant="h6" gutterBottom>MNF Outcomes</Typography>
        <Typography variant="body1">
          Check back here after the Sunday night football game to see the top&nbsp;5 finishers for each possible MNF result.
        </Typography>
      </Box>
    );
  }

  // Visible window (Sun final -> EOD Mon)
  if (whatIf.kind === "none") {
    return (
      <Box sx={{ maxWidth: 1000, mx: "auto", p: 2 }}>
        {weekSelector}
        <Typography variant="h6" gutterBottom>MNF Outcomes</Typography>
        <Typography variant="body1">
          No MNF scenarios to display (either no Monday games this week, or data isn’t ready yet).
        </Typography>
      </Box>
    );
  }

  return (
    <Box sx={{ maxWidth: 1100, mx: "auto", p: 2 }}>
      {weekSelector}
      <Typography variant="h6" gutterBottom>
        MNF Outcomes {endOfMonday ? `(through ${endOfMonday.toLocaleString()})` : ""}
      </Typography>

      {whatIf.kind === "one" && (
        <OneGameTable
          buckets={whatIf.buckets}
          rows={whatIf.rows}
          home={whatIf.home}
          away={whatIf.away}
        />
      )}

      {whatIf.kind === "two" && (
        <TwoGameGrid
          xLabel={`${whatIf.x.away} @ ${whatIf.x.home}`}
          yLabel={`${whatIf.y.away} @ ${whatIf.y.home}`}
          xBuckets={whatIf.x.buckets}
          yBuckets={whatIf.y.buckets}
          grid={whatIf.grid}
        />
      )}
    </Box>
  );
}

/* -------------------------- Presentational bits -------------------------- */

function OneGameTable(props: {
  buckets: number[];
  rows: Array<{
    actual: number;
    winners: { pn: number; name: string }[];
    top5: Array<{ pn: number; name: string; total: number }>;
  }>;
  home: string;
  away: string;
}) {
  const { rows, home, away } = props;

  // Helper to join top5 with '-' if tied, '|' if not
  function joinTop5(top5: Array<{ name: string; total: number }>) {
    if (!top5.length) return '';
    let out = `${top5[0].name} ${top5[0].total}`;
    for (let i = 1; i < top5.length; ++i) {
      const sep = top5[i].total === top5[i-1].total ? ' - ' : '  |  ';
      out += sep + `${top5[i].name} ${top5[i].total}`;
    }
    return out;
  }

  // Helper to format the outcome as '<Team> <points>'
  function formatOutcome(actual: number): string {
    if (actual === 0) return 'Tie 0';
    if (actual > 0) return `${home} ${actual}`;
    return `${away} ${Math.abs(actual)}`;
  }

  // Collapse consecutive rows with identical Top 5 (names and order)
  // Helper to get both order and tie structure for Top 5
  function top5OrderAndTiesKey(top5: Array<{ name: string; total: number }>) {
    if (!top5.length) return '';
    let key = '';
    let prevScore = top5[0].total;
    key += top5[0].name;
    for (let i = 1; i < top5.length; ++i) {
      key += (top5[i].total === prevScore ? '=' : '>') + top5[i].name;
      prevScore = top5[i].total;
    }
    return key;
  }

  // Prune both the highest and lowest margin rows for each team as described
  // Prune only the top run and bottom run of identical Top 5 order (including ties)
  let start = 0;
  while (
    start < rows.length - 1 &&
    top5OrderAndTiesKey(rows[start].top5) === top5OrderAndTiesKey(rows[start + 1].top5)
  ) {
    start++;
  }
  let end = rows.length - 1;
  while (
    end > start &&
    top5OrderAndTiesKey(rows[end].top5) === top5OrderAndTiesKey(rows[end - 1].top5)
  ) {
    end--;
  }
  // Always include all rows between start and end, inclusive
  const displayRows = rows.slice(start, end + 1);

  return (
    <Box>
      <Typography variant="subtitle1" gutterBottom>
        Forecast (per MNF margin): top 5 finishers
      </Typography>
      <Table size="small" sx={{ mb: 2 }}>
        <TableHead>
          <TableRow>
            <TableCell sx={{ fontWeight: 600 }}>Outcome</TableCell>
            <TableCell sx={{ fontWeight: 600 }}>Top 5</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {displayRows.map((r, idx) => {
            // Add '+' to first and last row
            let outcome = formatOutcome(r.actual);
            if (idx === 0 || idx === displayRows.length - 1) outcome += '+';
            return (
              <TableRow key={r.actual}>
                <TableCell>{outcome}</TableCell>
                <TableCell>
                  {joinTop5(r.top5)}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </Box>
  );
}

function TwoGameGrid(props: {
  xLabel: string;
  yLabel: string;
  xBuckets: number[];
  yBuckets: number[];
  grid: Array<Array<{ winners: { pn: number; name: string }[]; bestTotal: number }>>;
}) {
  const { xLabel, yLabel, xBuckets, yBuckets, grid } = props;

  // Build a simple legend of initials → name
  const legendMap = useMemo(() => {
    const names = new Set<string>();
    grid.forEach(row => row.forEach(cell => cell.winners.forEach(w => names.add(w.name))));
    const arr = Array.from(names).sort();
    return arr.map(name => ({ name, tag: initials(name) }));
  }, [grid]);

  return (
    <Box>
      <Typography variant="subtitle1" gutterBottom>
        1st place by MNF outcomes
      </Typography>
      <Typography variant="body2" gutterBottom sx={{ mb: 1 }}>
        Columns: {xLabel} (home + / away −) &nbsp; • &nbsp; Rows: {yLabel}
      </Typography>
      <Box sx={{ overflowX: "auto", border: "1px solid", borderColor: "divider", borderRadius: 1 }}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell sx={{ fontWeight: 600 }}>{/* corner cell */}</TableCell>
              {xBuckets.map(x => (
                <TableCell key={x} align="center" sx={{ fontWeight: 600 }}>
                  {formatBucket(x)}
                </TableCell>
              ))}
            </TableRow>
          </TableHead>
          <TableBody>
            {yBuckets.map((y, yi) => (
              <TableRow key={y}>
                <TableCell sx={{ fontWeight: 600 }}>{formatBucket(y)}</TableCell>
                {xBuckets.map((x, xi) => {
                  const cell = grid[yi][xi];
                  const tags = cell.winners.map(w => initials(w.name)).join(" ");
                  return (
                    <TableCell key={`${y}:${x}`} align="center">
                      {tags || "—"}
                    </TableCell>
                  );
                })}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Box>

      <Divider sx={{ my: 2 }} />

      <Typography variant="subtitle2" gutterBottom>Legend</Typography>
      <Stack direction="row" spacing={2} useFlexGap flexWrap="wrap">
        {legendMap.map(({ name, tag }) => (
          <Box key={name} sx={{ display: "flex", gap: 1, alignItems: "center" }}>
            <Box sx={{ fontFamily: "monospace", px: 1, py: 0.25, border: "1px solid", borderColor: "divider", borderRadius: 1 }}>
              {tag}
            </Box>
            <Typography variant="body2">{name}</Typography>
          </Box>
        ))}
      </Stack>

      <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: "block" }}>
        Positive = home wins by that margin; negative = away. 0 = tie. Cells show winner initials.
      </Typography>
    </Box>
  );
}

/* ------------------------------ helpers ------------------------------ */

function initials(name: string): string {
  // make compact tags like "KD", "MA", "AB"
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length === 1) {
    // take letters/numbers from a single token
    const token = parts[0].replace(/[^A-Za-z0-9]/g, "");
    return token.length <= 3 ? token.toUpperCase() : token.slice(0, 3).toUpperCase();
    }
  const tag = (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  return tag;
}

function formatBucket(n: number): string {
  // You can swap this for your “V10 / 6+ / 0 / …” labeling later.
  if (n === 0) return "0 (tie)";
  if (n > 0) return `+${n}`;
  return String(n);
}
