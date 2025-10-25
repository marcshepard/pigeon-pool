/**
 * Explain how a pigeon can still reach Top-5 given remaining games.
 * Uses a combinatorial solver for up to 3 remaining scheduled games.
 * Shows up to 3 "pills" of simple conditions that lead to Top-5.
 */

import { useMemo } from "react";
import { Box, Chip, Stack, Typography } from "@mui/material";
import type { ResultsRow } from "../../hooks/useResults";
import type { GameMeta } from "../../hooks/useAppCache";

// ===== Tunables =====
const MAX_EXPLAIN_GAMES = 3;   // change here if you later want 4
const TOP_K = 5;
const MARGIN_MIN = -40;
const MARGIN_MAX =  40;

// ===== Scoring (mirrors scoreForPick in useResults.ts) =====
function pickScore(predSigned: number, actualSigned: number) {
  const pickedHome = predSigned >= 0;
  const winnerHome = actualSigned > 0;
  const diff = Math.abs(predSigned - actualSigned);
  const wrongWinner = actualSigned === 0 || pickedHome !== winnerHome;
  return diff + (wrongWinner ? 7 : 0);
}

function gameKey(gid: number) { return `g_${gid}`; }
function uniqSorted(nums: number[]) { return Array.from(new Set(nums)).sort((a, b) => a - b); }

// Build integer intervals per game from 0 and all unique picks (clamped)
function buildIntervalsForGame(allPicks: number[]) {
  const pts = uniqSorted([0, ...allPicks].filter((m) => m >= MARGIN_MIN && m <= MARGIN_MAX));
  const edges = pts.length ? pts : [0];
  const withSentinels = [MARGIN_MIN - 1, ...edges, MARGIN_MAX + 1];

  const out: Array<{ lo: number; hi: number; rep: number }> = [];
  for (let i = 0; i < withSentinels.length - 1; i++) {
    const lo = withSentinels[i] + 1;
    const hi = withSentinels[i + 1] - 1;
    if (lo <= hi) {
      const rep = Math.trunc((lo + hi) / 2);
      out.push({ lo, hi, rep });
    }
    if (i < edges.length) {
      const pt = edges[i];
      out.push({ lo: pt, hi: pt, rep: pt });
    }
  }
  const sig = (x: { lo: number; hi: number }) => `${x.lo}:${x.hi}`;
  const dedup = Array.from(new Map(out.map(o => [sig(o), o])).values());
  dedup.sort((a, b) => a.lo - b.lo || a.hi - b.hi);
  return dedup;
}

function formatBandShort(lo: number, hi: number, homeAbbr: string, awayAbbr: string) {
  if (lo === hi) {
    if (lo === 0) return "TIE 0";
    const winner = lo > 0 ? homeAbbr : awayAbbr;
    return `${winner} ${Math.abs(lo)}`;
  }
  if (hi < 0) return `${awayAbbr} ≤ ${Math.abs(hi)}`;
  if (lo > 0) return `${homeAbbr} ≥ ${lo}`;
  return `${awayAbbr}…TIE…${homeAbbr} (−${Math.abs(lo)}…+${hi})`;
}

// Compute rank (ascending) + tie flag
function computeRankOf(totals: number[], userIdx: number) {
  const userTotal = totals[userIdx];
  const sorted = [...totals].sort((a, b) => a - b);
  const rank = sorted.findIndex((t) => t === userTotal) + 1;
  const tie = totals.filter((t) => t === userTotal).length > 1;
  return { rank, tie };
}

type Pill = {
  place: number;    // 1..5
  tie: boolean;
  conditions: Array<{ game_id: number; lo: number; hi: number; label: string }>;
};

type ExplainResult = {
  possibleTop5: boolean;
  bestPlace?: number;
  bestPlaceTie?: boolean;
  pills?: Pill[];
  alsoPossible?: Array<{ place: number; tie: boolean }>;
};

function solveN3(
  remGames: GameMeta[],
  rows: ResultsRow[],
  userPigeon: number
): ExplainResult {
  const pigeonToIndex = new Map<number, number>();
  rows.forEach((r, i) => pigeonToIndex.set(r.pigeon_number, i));
  const P = rows.length;

  // Base totals from final games + treat live as final (same convention as RemainingGames header)
  const baseTotals = rows.map(r => r.points ?? 0);

  for (const g of remGames) {
    if (g.status !== "in_progress") continue;
    if (g.home_score == null || g.away_score == null) continue;
    const actual = (g.home_score ?? 0) - (g.away_score ?? 0);
    const key = gameKey(g.game_id);
    for (let i = 0; i < P; i++) {
      const pred = rows[i].picks[key]?.signed;
      if (typeof pred !== "number") continue;
      baseTotals[i] += pickScore(pred, actual);
    }
  }

  const futureGames = remGames.filter(g => g.status !== "in_progress");

  const uIdxMaybe = pigeonToIndex.get(userPigeon);
  if (uIdxMaybe == null) return { possibleTop5: false };
  const userIdx: number = uIdxMaybe; // capture definitively for TS

  if (futureGames.length === 0) {
    const { rank, tie } = computeRankOf(baseTotals, userIdx);
    return {
      possibleTop5: rank <= TOP_K,
      bestPlace: rank,
      bestPlaceTie: tie,
      pills: [],
    };
  }

  if (futureGames.length > MAX_EXPLAIN_GAMES) {
    return { possibleTop5: false }; // caller shows "come back…" chip
  }

  // Precompute per-game intervals and loss vectors
  type GSpec = {
    g: GameMeta;
    intervals: Array<{ lo: number; hi: number; rep: number }>;
    lossTable: number[][]; // [intervalIndex][playerIndex]
  };

  const gspecs: GSpec[] = futureGames.map((g) => {
    const key = gameKey(g.game_id);
    const picks: number[] = [];
    for (let i = 0; i < P; i++) {
      const s = rows[i].picks[key]?.signed;
      if (typeof s === "number") picks.push(s);
    }
    const intervals = buildIntervalsForGame(picks);
    const lossTable = intervals.map((iv) => {
      const vec = new Array(P).fill(0);
      for (let i = 0; i < P; i++) {
        const pred = rows[i].picks[key]?.signed;
        if (typeof pred !== "number") continue;
        vec[i] = pickScore(pred, iv.rep);
      }
      return vec;
    });
    return { g, intervals, lossTable };
  });

  type Scenario = {
    combo: Array<{ game_id: number; lo: number; hi: number; rep: number }>;
    totals: number[];
    rank: number;
    tie: boolean;
  };
  const scenarios: Scenario[] = [];

  function pushScenario(selection: Array<{ gi: number; ii: number }>) {
    const totals = baseTotals.slice();
    const combo: Scenario["combo"] = [];
    for (const { gi, ii } of selection) {
      const spec = gspecs[gi];
      const iv = spec.intervals[ii];
      const loss = spec.lossTable[ii];
      for (let i = 0; i < P; i++) totals[i] += loss[i];
      combo.push({ game_id: spec.g.game_id, lo: iv.lo, hi: iv.hi, rep: iv.rep });
    }
    const { rank, tie } = computeRankOf(totals, userIdx);
    scenarios.push({ combo, totals, rank, tie });
  }

  // Enumerate all combinations (N<=3)
  const G = gspecs.length;
  for (let i0 = 0; i0 < gspecs[0].intervals.length; i0++) {
    if (G === 1) {
      pushScenario([{ gi: 0, ii: i0 }]);
      continue;
    }
    for (let i1 = 0; i1 < gspecs[1].intervals.length; i1++) {
      if (G === 2) {
        pushScenario([{ gi: 0, ii: i0 }, { gi: 1, ii: i1 }]);
        continue;
      }
      for (let i2 = 0; i2 < gspecs[2].intervals.length; i2++) {
        pushScenario([{ gi: 0, ii: i0 }, { gi: 1, ii: i1 }, { gi: 2, ii: i2 }]);
      }
    }
  }

  const feasible = scenarios.filter(s => s.rank <= TOP_K);
  if (feasible.length === 0) {
    const best = scenarios.reduce((a, b) => (a.rank < b.rank ? a : b));
    return { possibleTop5: false, bestPlace: best.rank, bestPlaceTie: best.tie };
  }

  // Best place (prefer non-tie if same numeric place)
  const best = feasible.reduce((a, b) => {
    if (a.rank !== b.rank) return a.rank < b.rank ? a : b;
    // if same rank, prefer non-tie
    if (a.tie !== b.tie) return a.tie ? b : a;
    return a;
  });
  const bestPlace = best.rank;
  const bestTie = best.tie;

  // Rule extraction: greedy coverage on (game, interval) within best-place scenarios
  type Key = string; // `${game_id}:${lo}:${hi}`
  const keyOf = (c: { game_id: number; lo: number; hi: number }) => `${c.game_id}:${c.lo}:${c.hi}`;

  const bestFeasible = feasible.filter(s => s.rank === bestPlace);
  const condCount = new Map<Key, number>();
  for (const s of bestFeasible) {
    for (const c of s.combo) {
      const k = keyOf(c);
      condCount.set(k, (condCount.get(k) ?? 0) + 1);
    }
  }

  function condFromKey(k: Key) {
    const [gid, lo, hi] = k.split(":").map(Number);
    return { game_id: gid, lo, hi };
  }
  function labelFor(gid: number, lo: number, hi: number) {
    const g = futureGames.find(x => x.game_id === gid)!;
    return formatBandShort(lo, hi, g.home_abbr, g.away_abbr);
  }

  const sortedConds = Array.from(condCount.entries()).sort((a, b) => (b[1] - a[1]));
  const pills: Pill[] = [];

  if (sortedConds.length) {
    // Pill 1: best single, optionally add a second that maximizes joint coverage
    const [k1] = sortedConds[0];
    const c1 = condFromKey(k1);

    let c2: { game_id: number; lo: number; hi: number } | null = null;
    if (futureGames.length > 1) {
      const gains = new Map<Key, number>();
      for (const k of condCount.keys()) {
        if (k === k1) continue;
        const cx = condFromKey(k);
        const add = bestFeasible.filter(s =>
          s.combo.some(c => c.game_id === c1.game_id && c.lo === c1.lo && c.hi === c1.hi) &&
          s.combo.some(c => c.game_id === cx.game_id && c.lo === cx.lo && c.hi === cx.hi)
        ).length;
        gains.set(k, add);
      }
      const bestSecond = Array.from(gains.entries()).sort((a, b) => (b[1] - a[1]))[0];
      if (bestSecond && bestSecond[1] > 0) {
        c2 = condFromKey(bestSecond[0]);
      }
    }

    const pillConds = [c1, ...(c2 ? [c2] : [])].map(c => ({
      game_id: c.game_id,
      lo: c.lo,
      hi: c.hi,
      label: labelFor(c.game_id, c.lo, c.hi),
    }));
    pills.push({ place: bestPlace, tie: bestTie, conditions: pillConds });
  }

  // Pill 2/3: other high-count singles (avoid dup)
  for (const [k] of sortedConds) {
    if (pills.length >= 3) break;
    const already = pills.some(p => p.conditions.some(c => keyOf(c) === k));
    if (already) continue;
    const c = condFromKey(k);
    pills.push({
      place: bestPlace,
      tie: bestTie,
      conditions: [{ game_id: c.game_id, lo: c.lo, hi: c.hi, label: labelFor(c.game_id, c.lo, c.hi) }],
    });
  }

  // Also possible (other places), summarized
  const alsoSet = new Map<number, boolean>();
  for (const s of feasible) {
    if (s.rank === bestPlace) continue;
    if (!alsoSet.has(s.rank)) alsoSet.set(s.rank, s.tie);
  }
  const alsoPossible = Array.from(alsoSet.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([place, tie]) => ({ place, tie }));

  return { possibleTop5: true, bestPlace, bestPlaceTie: bestTie, pills, alsoPossible };
}

export default function Top5Explainer({
  pigeon,
  rows,
  games,
}: {
  pigeon: number;
  rows: ResultsRow[];
  games: GameMeta[];
}) {
  const remGames = useMemo(() => games.filter(g => g.status !== "final"), [games]);
  const scheduledCount = useMemo(() => remGames.filter(g => g.status !== "in_progress").length, [remGames]);

  const result = useMemo(() => solveN3(remGames, rows, pigeon), [remGames, rows, pigeon]);

  if (scheduledCount > MAX_EXPLAIN_GAMES) {
    return (
      <Box sx={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 1, mb: 2 }}>
        <Typography variant="body1">
            Come back when there are ≤ {MAX_EXPLAIN_GAMES} games remaining to see how you can reach the top {TOP_K}.
        </Typography>
      </Box>
    );
  }

  if (!rows.length) return null;

  if (!result.possibleTop5) {
    return null;
  }

  return (
    <Box sx={{ mb: 2 }}>
      <Box sx={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 1, mb: 1 }}>
        <Chip color="success" label={`Best finish: ${result.bestPlace}${result.bestPlaceTie ? " (T)" : ""}`} />
        {result.alsoPossible?.length ? (
          <Typography variant="body2" color="text.secondary">
            Also possible: {result.alsoPossible.map(x => `${x.place}${x.tie ? " (T)" : ""}`).join(", ")}
          </Typography>
        ) : null}
      </Box>

      {!!result.pills?.length && (
        <Stack direction="row" spacing={1} justifyContent="center" flexWrap="wrap">
          {result.pills.slice(0, 3).map((pill, idx) => (
            <Chip
              key={idx}
              variant="outlined"
              label={
                <>
                  <strong>{`${pill.place}${pill.tie ? " (T)" : ""}`}</strong>
                  {pill.conditions.map((c, i) => (
                    <span key={i}>
                      {i > 0 ? " & " : " "}
                      {c.label}
                    </span>
                  ))}
                </>
              }
            />
          ))}
        </Stack>
      )}
    </Box>
  );
}
