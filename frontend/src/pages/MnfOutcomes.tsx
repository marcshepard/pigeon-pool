/**
 * MNF possible outcomes (that Andy sends Sunday nights)
 */

// src/pages/MnfOutcomesPage.tsx
import { useMemo } from "react";
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
  // What week to show? Use the live week; if null, there’s no active week.
  const { schedule } = useSchedule();
  const liveWeek = schedule?.live_week ?? null;

  const { rows, games, loading, error } = useResults(liveWeek);
  const whatIf = useMnfOutcomes(liveWeek, rows, games);

  const { shouldShow, endOfMonday } = useMemo(() => {
    const now = new Date();
    const sundayDone = allSundayGamesFinal(games);
    const eom = endOfLocalMondayForWeek(games);
    const withinWindow = sundayDone && (!!eom && now <= eom);
    return { shouldShow: withinWindow, endOfMonday: eom };
  }, [games]);

  if (loading) {
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

  if (!shouldShow) {
    return (
      <Box sx={{ maxWidth: 1000, mx: "auto", p: 2 }}>
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
        <Typography variant="h6" gutterBottom>MNF Outcomes</Typography>
        <Typography variant="body1">
          No MNF scenarios to display (either no Monday games this week, or data isn’t ready yet).
        </Typography>
      </Box>
    );
  }

  return (
    <Box sx={{ maxWidth: 1100, mx: "auto", p: 2 }}>
      <Typography variant="h6" gutterBottom>
        MNF Outcomes {endOfMonday ? `(through ${endOfMonday.toLocaleString()})` : ""}
      </Typography>

      {whatIf.kind === "one" && (
        <OneGameTable buckets={whatIf.buckets} rows={whatIf.rows} />
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
}) {
  const { rows } = props;

  return (
    <Box>
      <Typography variant="subtitle1" gutterBottom>
        Forecast (per MNF margin): 1st place winners and top 5
      </Typography>
      <Table size="small" sx={{ mb: 2 }}>
        <TableHead>
          <TableRow>
            <TableCell sx={{ fontWeight: 600 }}>Actual signed margin</TableCell>
            <TableCell sx={{ fontWeight: 600 }}>Winner(s)</TableCell>
            <TableCell sx={{ fontWeight: 600 }}>Top 5 (name • score)</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.actual}>
              <TableCell>{formatBucket(r.actual)}</TableCell>
              <TableCell>
                {r.winners.map(w => w.name).join(", ")}
              </TableCell>
              <TableCell>
                {r.top5.map(t => `${t.name} • ${t.total}`).join("  |  ")}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <Typography variant="caption" color="text.secondary">
        Positive = home wins by that margin; negative = away. 0 = tie.
      </Typography>
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
