/**
 * MNF possible outcomes (that Andy sends Sunday nights)
 */

// src/pages/MnfOutcomesPage.tsx
import React, { useMemo } from "react";
import { Box, Typography, Stack, Table, TableHead, TableRow, TableCell, TableBody, Divider } from "@mui/material";
import { useSchedule } from "../../hooks/useSchedule";
import { useResults } from "../../hooks/useResults";
import { useMnfOutcomes } from "../../hooks/useMnfOutcomes"; // the hook you asked for (aka useMnfWhatIf)
import type { GameMeta } from "../../hooks/useAppCache";

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

type MnfOutcomesProps = { week: number };

export default function MnfOutcomes({ week }: MnfOutcomesProps) {
  const { currentWeek, loading: scheduleLoading } = useSchedule();
  const { rows, games, loading, error } = useResults(week);
  const whatIf = useMnfOutcomes(week, rows, games);

  // Only show the 'come back after Sunday' message for the current week (not completed weeks)
  const { shouldShow } = useMemo(() => {
    const now = new Date();
    const sundayDone = allSundayGamesFinal(games);
    const eom = endOfLocalMondayForWeek(games);
    // If the selected week is completed, always show outcomes (if available)
    if (currentWeek?.status === "final") {
      return { shouldShow: true, endOfMonday: eom };
    }
    // Otherwise, use the original logic for the current week
    const withinWindow = sundayDone && (!!eom && now <= eom);
    return { shouldShow: withinWindow, endOfMonday: eom };
  }, [games, currentWeek]);

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

  if (!shouldShow && currentWeek?.week === week) {
    return (
      <Box sx={{ maxWidth: 1000, mx: "auto", p: 2 }}>
        <Typography variant="h6" gutterBottom>MNF Outcomes</Typography>
        <Typography variant="body1">
          Check back here after the Sunday night football game to see the top finishers for each possible MNF result.
        </Typography>
      </Box>
    );
  }

  // Visible window (Sun final -> EOD Mon)
  if (whatIf.kind === "none") {
    return (
      <Box sx={{ maxWidth: 1000, mx: "auto", p: 1 }}>
        <Typography variant="h6" gutterBottom>MNF Outcomes</Typography>
        <Typography variant="body1">
          No MNF scenarios to display (either no Monday games this week, or data isn’t ready yet).
        </Typography>
      </Box>
    );
  }

  return (
    <Box sx={{ maxWidth: 1100, mx: "auto", p: 1 }}>
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
          others={whatIf.othersBestFinishes}
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
    top5Ranks?: Array<Array<{ pn: number; name: string; total: number }>>;
  }>;
  home: string;
  away: string;
}) {
  const { rows, home, away } = props;

  // (table now renders per-rank columns; no need for joinTop5 string)

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

  // Build a legend like the two-game grid
  const legendMap = useMemo(() => {
    const names = new Set<string>();
    rows.forEach(r => {
      (r.top5Ranks ?? []).forEach(rank => rank.forEach(p => names.add(p.name)));
      r.top5.forEach(p => names.add(p.name));
    });
    const arr = Array.from(names).sort();
    return arr.map(name => ({ name, tag: initials(name) }));
  }, [rows]);

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

  // If only one row is displayed, show '<TEAM> any' (no margin, no '+')
  const singleRowAnyLabel = React.useMemo(() => {
    if (displayRows.length !== 1) return null;
    const actual = displayRows[0].actual;
    let team: string;
    if (actual === 0) team = 'Tie';
    else if (actual > 0) team = home;
    else team = away;
    return `${team} any`;
  }, [displayRows, home, away]);


  return (
    <Box sx={{ overflowX: "hidden" }}>
      <Typography variant="body1">
        Top five finishers by MNF outcome
      </Typography>
      <Box sx={{ width: "100%", maxWidth: "100%", overflowX: "auto", border: "1px solid", borderColor: "divider", borderRadius: 1, WebkitOverflowScrolling: "touch", mb: 2 }}>
        <Table size="small" sx={{
          tableLayout: "fixed",
          '& th, & td': { px: 1, py: 0.5 },
          '& th + th, & td + td': { borderLeft: '1px solid', borderColor: 'divider' },
          '& tbody tr + tr td': { borderTop: '1px solid', borderColor: 'divider' },
        }}>
          <TableHead>
            <TableRow>
              <TableCell sx={{ fontWeight: 600, whiteSpace: 'nowrap' }}></TableCell>
              <TableCell sx={{ fontWeight: 600 }} align="center">1st</TableCell>
              <TableCell sx={{ fontWeight: 600 }} align="center">2nd</TableCell>
              <TableCell sx={{ fontWeight: 600 }} align="center">3rd</TableCell>
              <TableCell sx={{ fontWeight: 600 }} align="center">4th</TableCell>
              <TableCell sx={{ fontWeight: 600 }} align="center">5th</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {displayRows.map((r, idx) => {
            // Build the outcome label; if only one row, use '<TEAM> any' without '+'
            let outcome = singleRowAnyLabel ?? formatOutcome(r.actual);
            if (!singleRowAnyLabel) {
              const firstSide = displayRows.length ? (displayRows[0].actual === 0 ? 'tie' : (displayRows[0].actual > 0 ? 'home' : 'away')) : null;
              const lastSide = displayRows.length ? (displayRows[displayRows.length - 1].actual === 0 ? 'tie' : (displayRows[displayRows.length - 1].actual > 0 ? 'home' : 'away')) : null;
              const bottomSuffix = firstSide && lastSide && firstSide === lastSide ? '-' : '+';
              if (idx === 0) outcome += '+';
              if (idx === displayRows.length - 1) outcome += bottomSuffix;
            }
            // Build rank columns 1..5 from groups, leaving blanks for skipped ranks when a tie spans multiple positions
            const ranks = r.top5Ranks ?? (() => {
              const t = r.top5;
              if (!t || t.length === 0) return [] as Array<Array<{ pn: number; name: string; total: number }>>;
              const groups: Array<Array<{ pn: number; name: string; total: number }>> = [];
              let i = 0;
              while (i < t.length && groups.length < 5) {
                const g: Array<{ pn: number; name: string; total: number }> = [t[i]];
                let j = i + 1;
                while (j < t.length && t[j].total === t[i].total) { g.push(t[j]); j++; }
                groups.push(g);
                i = j;
              }
              return groups;
            })();
            const rankCols: Array<Array<{ pn: number; name: string; total: number }>> = [[], [], [], [], []];
            let pos = 1;
            for (const g of ranks) {
              if (pos > 5) break;
              rankCols[pos - 1] = g;
              pos += g.length; // skip subsequent positions covered by the tie
            }
            return (
              <TableRow key={r.actual}>
                <TableCell sx={{ fontWeight: 600, whiteSpace: 'nowrap' }}>{outcome}</TableCell>
                {[0, 1, 2, 3, 4].map(rankIdx => (
                  <TableCell key={rankIdx} align="center">
                    {rankCols[rankIdx].length ? (
                      <Stack direction="column" spacing={0.25} alignItems="center">
                        {rankCols[rankIdx].map(p => (
                          <span key={p.pn}>{initials(p.name)}</span>
                        ))}
                      </Stack>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                ))}
              </TableRow>
            );
          })}
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
    </Box>
  );
}

function TwoGameGrid(props: {
  xLabel: string;
  yLabel: string;
  xBuckets: number[];
  yBuckets: number[];
  grid: Array<Array<{ winners: { pn: number; name: string }[]; bestTotal: number }>>;
  others: Array<{ pn: number; name: string; bestRank: 2|3|4|5; tied: boolean }>;
}) {
  const { xLabel, yLabel, xBuckets, yBuckets, grid, others } = props;

  // Helper to format the outcome as '<Team> <points>'
  function formatOutcome(actual: number, home: string, away: string): string {
    if (actual === 0) return 'Tie 0';
    if (actual > 0) return `${home} ${actual}`;
    return `${away} ${Math.abs(actual)}`;
  }

  // Prune top/bottom rows and left/right columns recursively if identical
  function winnersRowKey(row: Array<{ winners: { pn: number; name: string }[]; bestTotal: number }>): string {
    // Consider rows identical if the winners per cell are identical; ignore score totals
    return row.map(cell => cell.winners.map(w => w.name).join(",")).join("|");
  }
  function winnersColKey(col: Array<{ winners: { pn: number; name: string }[]; bestTotal: number }>): string {
    // Consider columns identical if the winners per cell are identical; ignore score totals
    return col.map(cell => cell.winners.map(w => w.name).join(",")).join("|");
  }

  // Prune only the top run and bottom run of identical rows (middle rows always shown)
  let topRowEnd = 0;
  while (
    topRowEnd < grid.length - 1 &&
    winnersRowKey(grid[0]) === winnersRowKey(grid[topRowEnd + 1])
  ) {
    topRowEnd++;
  }
  let bottomRowStart = grid.length - 1;
  while (
    bottomRowStart > topRowEnd &&
    winnersRowKey(grid[grid.length - 1]) === winnersRowKey(grid[bottomRowStart - 1])
  ) {
    bottomRowStart--;
  }
  const keepRowIdx: number[] = [];
  // Keep the last row of the top run (closest to middle)
  keepRowIdx.push(topRowEnd);
  // Keep all middle rows between runs
  for (let i = topRowEnd + 1; i <= bottomRowStart - 1; i++) {
    keepRowIdx.push(i);
  }
  // Keep the first row of the bottom run (closest to middle)
  if (bottomRowStart > topRowEnd) keepRowIdx.push(bottomRowStart);

  const displayYBuckets = keepRowIdx.map(i => yBuckets[i]);
  const displayRowsGrid = keepRowIdx.map(i => grid[i]);

  // Prune columns (left/right) similarly: collapse left and right identical runs
  let leftColEnd = 0;
  while (
    leftColEnd < xBuckets.length - 1 &&
    winnersColKey(grid.map(row => row[0])) === winnersColKey(grid.map(row => row[leftColEnd + 1]))
  ) {
    leftColEnd++;
  }
  let rightColStart = xBuckets.length - 1;
  while (
    rightColStart > leftColEnd &&
    winnersColKey(grid.map(row => row[xBuckets.length - 1])) === winnersColKey(grid.map(row => row[rightColStart - 1]))
  ) {
    rightColStart--;
  }
  const keepColIdx: number[] = [];
  // Keep the last column of the left run (closest to middle)
  keepColIdx.push(leftColEnd);
  // Keep all middle columns
  for (let i = leftColEnd + 1; i <= rightColStart - 1; i++) {
    keepColIdx.push(i);
  }
  // Keep the first column of the right run (closest to middle)
  if (rightColStart > leftColEnd) keepColIdx.push(rightColStart);

  const displayXBuckets = keepColIdx.map(i => xBuckets[i]);
  const finalDisplayGrid = displayRowsGrid.map(row => keepColIdx.map(i => row[i]));

  // Build a simple legend of initials → name
  const legendMap = useMemo(() => {
    const names = new Set<string>();
    grid.forEach(row => row.forEach(cell => cell.winners.forEach(w => names.add(w.name))));
    const arr = Array.from(names).sort();
    return arr.map(name => ({ name, tag: initials(name) }));
  }, [grid]);

  // Get home/away for x and y axes from labels
  function parseTeams(label: string): { home: string; away: string } {
    const m = label.match(/([A-Z]{2,})\s*@\s*([A-Z]{2,})/);
    if (!m) return { home: "Home", away: "Away" };
    return { away: m[1], home: m[2] };
  }
  const xTeams = parseTeams(xLabel);
  const yTeams = parseTeams(yLabel);

  // If only one column or one row remains after pruning, show '<TEAM> any' for that axis (no margin, no '+')
  function formatAny(actual: number, home: string, away: string): string {
    if (actual === 0) return 'Tie any';
    return actual > 0 ? `${home} any` : `${away} any`;
  }


  return (
    <Box sx={{ overflowX: "hidden" }}>
      <Typography variant="subtitle1" gutterBottom>
        First place by MNF outcome
      </Typography>
      <Box sx={{ width: "100%", maxWidth: "100%", overflowX: "auto", border: "1px solid", borderColor: "divider", borderRadius: 1, WebkitOverflowScrolling: "touch" }}>
        <Table
          size="small"
          sx={{
            tableLayout: "fixed",
            '& th, & td': { px: 1, py: 0.5 },
            '& th + th, & td + td': { borderLeft: '1px solid', borderColor: 'divider' },
            '& tbody tr + tr td': { borderTop: '1px solid', borderColor: 'divider' },
          }}
        >
          <TableHead>
            <TableRow>
              <TableCell sx={{ fontWeight: 600, whiteSpace: "nowrap" }}>{/* corner cell */}</TableCell>
              {displayXBuckets.map((x, xi) => {
                const singleCol = displayXBuckets.length === 1;
                let label = singleCol
                  ? formatAny(x, xTeams.home, xTeams.away)
                  : formatOutcome(x, xTeams.home, xTeams.away);
                // Add '+' to first and last column only when more than one column
                if (!singleCol) {
                  if (xi === 0) label += '+';
                  if (xi === displayXBuckets.length - 1) label += '+';
                }
                return (
                  <TableCell key={x} align="center" sx={{ fontWeight: 600, whiteSpace: "nowrap" }}>
                    <Box component="span" sx={{ pr: 0.25, display: 'inline-block' }}>{label}</Box>
                  </TableCell>
                );
              })}
            </TableRow>
          </TableHead>
          <TableBody>
            {displayYBuckets.map((y, yi) => {
              const singleRow = displayYBuckets.length === 1;
              let label = singleRow
                ? formatAny(y, yTeams.home, yTeams.away)
                : formatOutcome(y, yTeams.home, yTeams.away);
              // Add '+' to first and last row only when more than one row
              if (!singleRow) {
                const firstSide = displayYBuckets.length ? (displayYBuckets[0] === 0 ? 'tie' : (displayYBuckets[0] > 0 ? 'home' : 'away')) : null;
                const lastSide = displayYBuckets.length ? (displayYBuckets[displayYBuckets.length - 1] === 0 ? 'tie' : (displayYBuckets[displayYBuckets.length - 1] > 0 ? 'home' : 'away')) : null;
                const bottomSuffix = firstSide && lastSide && firstSide === lastSide ? '-' : '+';
                if (yi === 0) label += '+';
                if (yi === displayYBuckets.length - 1) label += bottomSuffix;
              }
              return (
                <TableRow key={y}>
                  <TableCell sx={{ fontWeight: 600, whiteSpace: "nowrap" }}>
                    <Box component="span" sx={{ pr: 0.25, display: 'inline-block' }}>{label}</Box>
                  </TableCell>
                  {displayXBuckets.map((x, xi) => {
                    const cell = finalDisplayGrid[yi][xi];
                    return (
                      <TableCell key={`${y}:${x}`} align="center">
                        {cell.winners.length ? (
                          <Stack direction="column" spacing={0.25} alignItems="center">
                            {cell.winners.map(w => (
                              <span key={w.pn}>{initials(w.name)}</span>
                            ))}
                          </Stack>
                        ) : (
                          "—"
                        )}
                      </TableCell>
                    );
                  })}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </Box>

      {others.length > 0 && (
        <>
          <Divider sx={{ my: 2 }} />
          <Typography variant="subtitle1" gutterBottom>
            Best possible finish for others
          </Typography>
          <Typography variant="body2">
            {formatOthersList(others)}
          </Typography>
        </>
      )}

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

// Format the compact sentence like:
// "Sam & Al (2nd), Craps (2nd), Jesters (2nd), JoskiHawk (2nd tie), ..."
function formatOthersList(list: Array<{ name: string; bestRank: 2|3|4|5; tied: boolean }>): string {
  const ord = (n: 2|3|4|5) => ({2: '2nd', 3: '3rd', 4: '4th', 5: '5th'}[n]);
  return list
    .map(p => `${p.name} (${ord(p.bestRank)}${p.tied ? ' T' : ''})`)
    .join(', ');
}

