/**
 * Explain how a pigeon can still reach Top-5 given remaining games.
 * Uses a combinatorial solver for up to 3 remaining scheduled games.
 * Shows up to 3 "pills" of simple conditions that lead to Top-5.
 */

import { useMemo } from "react";
import { Box, Paper, Table, TableHead, TableBody, TableRow, TableContainer, TableCell, Typography } from "@mui/material";
import type { ResultsRow } from "../../hooks/useResults";
import type { GameMeta } from "../../hooks/useAppCache";

// ===== Tunables =====
const MAX_EXPLAIN_GAMES = 3;   // change here if you later want 4
const TOP_K = 5;

// ===== Testing and debugging =====
// === DEV SWITCH: pretend the last N final/live games didn't happen ===
const DEV_REWIND_LAST_N = 0; // Pretend last N final/live games didn't happen so we can look at old weeks

// ===== Scoring (mirrors scoreForPick in useResults.ts) =====
function pickScore(predSigned: number, actualSigned: number) {
  const pickedHome = predSigned >= 0;
  const winnerHome = actualSigned > 0;
  const diff = Math.abs(predSigned - actualSigned);
  const wrongWinner = actualSigned === 0 || pickedHome !== winnerHome;
  return diff + (wrongWinner ? 7 : 0);
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

type Rect = { loIdx: number[]; hiIdx: number[] };
type Mask1 = boolean[];
type Mask2 = boolean[][];
type Mask3 = boolean[][][];
type Mask = Mask1 | Mask2 | Mask3;

// ===== Solver (N ≤ 3), with optional rewinding =====
function solveN3(
  allGames: GameMeta[],
  rows: ResultsRow[],
  userPigeon: number,
  rewindIds: Set<number> = new Set()
): ExplainResult {
  const P = rows.length;
  const pigeonToIndex = new Map<number, number>();
  rows.forEach((r, i) => pigeonToIndex.set(r.pigeon_number, i));
  const uIdx = pigeonToIndex.get(userPigeon);
  if (uIdx == null) return { possibleTop5: false };

  // --- constants ---
  const TOP = TOP_K;                 // e.g., 5
  const MAXG = MAX_EXPLAIN_GAMES;    // e.g., 3
  const MARGIN_MIN = -40, MARGIN_MAX = 40;

  // --- helpers (small, focused) ---
  const keyFor = (gid: number) => `g_${gid}`;

  // Build integer intervals at all “kinks”:
  //  - picks
  //  - pairwise midpoints on same side of 0 (floor/ceil)
  //  - penalty step at 0 (include -1,0,1)
  function buildIntervalsForGame(allPicks: number[]) {
    const bp = new Set<number>();
    bp.add(MARGIN_MIN);
    bp.add(MARGIN_MAX);
    bp.add(-1);
    bp.add(0);
    bp.add(1);

    const picks = allPicks.filter((n) => Number.isFinite(n));
    for (const p of picks) {
      const ip = Math.round(p);
      if (ip >= MARGIN_MIN && ip <= MARGIN_MAX) bp.add(ip);
    }
    for (let i = 0; i < picks.length; i++) {
      for (let j = i + 1; j < picks.length; j++) {
        const a = picks[i], b = picks[j];
        if (a === 0 || b === 0) continue;
        if ((a > 0 && b > 0) || (a < 0 && b < 0)) {
          const mid = (a + b) / 2;
          const f = Math.floor(mid), c = Math.ceil(mid);
          if (f >= MARGIN_MIN && f <= MARGIN_MAX) bp.add(f);
          if (c >= MARGIN_MIN && c <= MARGIN_MAX) bp.add(c);
        }
      }
    }

    const bps = Array.from(bp).sort((a, b) => a - b);

    type Interval = { lo: number; hi: number; rep: number };
    const out: Interval[] = [];

    const pushBand = (lo: number, hi: number) => {
      if (lo > hi) return;
      lo = Math.max(lo, MARGIN_MIN);
      hi = Math.min(hi, MARGIN_MAX);
      if (lo > hi) return;
      out.push({ lo, hi, rep: lo });
    };

    for (let k = 0; k < bps.length - 1; k++) {
      const a = bps[k], b = bps[k + 1];
      // gap (a+1 .. b-1)
      if (b >= a + 2) pushBand(a + 1, b - 1);
      // exact point a
      pushBand(a, a);
    }
    // final exact point
    pushBand(bps[bps.length - 1], bps[bps.length - 1]);

    // dedup + sort
    const sig = (iv: Interval) => `${iv.lo}:${iv.hi}`;
    const dedup = Array.from(new Map(out.map(iv => [sig(iv), iv])).values());
    dedup.sort((x, y) => (x.lo - y.lo) || (x.hi - y.hi));
    return dedup;
  }

  // Convert a boolean mask (G=1..3) into maximal rectangles (axis-aligned)
  function rectanglesFromMask1D(M: Mask1, dims: number[]): Rect[] {
    const rects: Rect[] = [];
    const visited: boolean[] = Array(dims[0]).fill(false);

    const isTrue = (i: number) => M[i] && !visited[i];
    const mark = (i: number) => { visited[i] = true; };

    for (let i = 0; i < dims[0]; i++) {
      if (!isTrue(i)) continue;
      let i2 = i;
      while (i2 + 1 < dims[0] && isTrue(i2 + 1)) i2++;
      for (let t = i; t <= i2; t++) mark(t);
      rects.push({ loIdx: [i], hiIdx: [i2] });
    }
    return rects;
  }

  function rectanglesFromMask2D(M: Mask2, dims: number[]): Rect[] {
    const rects: Rect[] = [];
    const visited: boolean[][] = Array.from({ length: dims[0] }, () => Array(dims[1]).fill(false));

    const isTrue = (i: number, j: number) => M[i][j] && !visited[i][j];
    const mark = (i: number, j: number) => { visited[i][j] = true; };

    for (let i = 0; i < dims[0]; i++) {
      for (let j = 0; j < dims[1]; j++) {
        if (!isTrue(i, j)) continue;

        // grow horizontally (j)
        let j2 = j;
        while (j2 + 1 < dims[1] && isTrue(i, j2 + 1)) j2++;

        // grow vertically (i) while whole stripe [j..j2] remains true
        let i2 = i;
        outer: while (i2 + 1 < dims[0]) {
          for (let jj = j; jj <= j2; jj++) if (!isTrue(i2 + 1, jj)) break outer;
          i2++;
        }

        for (let ii = i; ii <= i2; ii++) for (let jj = j; jj <= j2; jj++) mark(ii, jj);
        rects.push({ loIdx: [i, j], hiIdx: [i2, j2] });
      }
    }
    return rects;
  }

  function rectanglesFromMask3D(M: Mask3, dims: number[]): Rect[] {
    const rects: Rect[] = [];
    const visited: boolean[][][] =
      Array.from({ length: dims[0] }, () =>
        Array.from({ length: dims[1] }, () => Array(dims[2]).fill(false)));

    const isTrue = (i: number, j: number, k: number) => M[i][j][k] && !visited[i][j][k];
    const mark = (i: number, j: number, k: number) => { visited[i][j][k] = true; };

    for (let i = 0; i < dims[0]; i++) {
      for (let j = 0; j < dims[1]; j++) {
        for (let k = 0; k < dims[2]; k++) {
          if (!isTrue(i, j, k)) continue;

          // grow k
          let k2 = k;
          while (k2 + 1 < dims[2] && isTrue(i, j, k2 + 1)) k2++;

          // grow j while whole [k..k2] true
          let j2 = j;
          outerJ: while (j2 + 1 < dims[1]) {
            for (let kk = k; kk <= k2; kk++) if (!isTrue(i, j2 + 1, kk)) break outerJ;
            j2++;
          }

          // grow i while whole [j..j2]×[k..k2] true
          let i2 = i;
          outerI: while (i2 + 1 < dims[0]) {
            for (let jj = j; jj <= j2; jj++) {
              for (let kk = k; kk <= k2; kk++) if (!isTrue(i2 + 1, jj, kk)) break outerI;
            }
            i2++;
          }

          for (let ii = i; ii <= i2; ii++)
            for (let jj = j; jj <= j2; jj++)
              for (let kk = k; kk <= k2; kk++) mark(ii, jj, kk);

          rects.push({ loIdx: [i, j, k], hiIdx: [i2, j2, k2] });
        }
      }
    }
    return rects;
  }

  // Dispatcher: pick the correctly-typed rectangle tiler by G
  function rectanglesFromMask(mask: Mask, dims: number[], G: number): Rect[] {
    if (G === 1) return rectanglesFromMask1D(mask as Mask1, dims);
    if (G === 2) return rectanglesFromMask2D(mask as Mask2, dims);
    return rectanglesFromMask3D(mask as Mask3, dims);
  }

  // Local labeler (compact, ASCII <=/>=). If you have a preferred labelFor elsewhere, feel free to replace this.
  function labelFor(gid: number, lo: number, hi: number) {
    const g = allGames.find(x => x.game_id === gid)!;
    const H = g.home_abbr, A = g.away_abbr;
    if (lo === hi) {
      if (lo === 0) return `TIE (${A}@${H})`;
      return lo > 0 ? `${H} by  ${lo} (vs ${A})` : `${A} by ${Math.abs(lo)} (@${H})`;
    }
    if (hi < 0) {
      const minAway = Math.abs(hi), maxAway = Math.abs(lo);
      if (lo === MARGIN_MIN) return `${A} >= ${minAway} (@${H})`;
      return minAway === maxAway ? `${A} by ${minAway} (@${H})` : `${A} by ${minAway}–${maxAway} (@${H})`;
    }
    if (lo > 0) {
      if (hi === MARGIN_MAX) return `${H} >= ${lo} (vs ${A})`;
      return lo === hi ? `${H} by ${lo} (vs ${A})` : `${H} by ${lo}–${hi} (vs ${A})`;
    }

    if (lo === MARGIN_MIN)
      return `${H} by <= ${hi} (or ${A} win or tie)`;
    if (hi === MARGIN_MAX)
      return `${A} by <= ${Math.abs(lo)} (@${H}) (or ${H} win or tie)`;
    return `${A} by <= ${Math.abs(lo)} (@${H})  or  ${H} by <= ${hi} (vs ${A})`;
  }

  // --- 1) base totals from leaderboard ---
  const baseTotals = rows.map(r => r.points ?? 0);

  // --- 2) add live-as-final unless rewound ---
  for (const g of allGames) {
    if (g.status !== "in_progress") continue;
    if (rewindIds.has(g.game_id)) continue;
    if (g.home_score == null || g.away_score == null) continue;
    const actual = g.home_score - g.away_score;
    const key = keyFor(g.game_id);
    for (let i = 0; i < P; i++) {
      const pred = rows[i].picks[key]?.signed;
      if (typeof pred !== "number") continue;
      baseTotals[i] += pickScore(pred, actual);
    }
  }

  // --- 3) subtract rewound finals/live to fully “unplay” them ---
  for (const g of allGames) {
    if (!rewindIds.has(g.game_id)) continue;
    if (g.home_score == null || g.away_score == null) continue;
    const actual = g.home_score - g.away_score;
    const key = keyFor(g.game_id);
    for (let i = 0; i < P; i++) {
      const pred = rows[i].picks[key]?.signed;
      if (typeof pred !== "number") continue;
      baseTotals[i] -= pickScore(pred, actual);
    }
  }

  // --- 4) future set = all not-final games (scheduled or in progress) + rewound ---
  const futureGames = allGames.filter(g =>
    (g.status !== "final") || rewindIds.has(g.game_id)
  );
  if (futureGames.length === 0) {
    const { rank, tie } = computeRankOf(baseTotals, uIdx);
    return { possibleTop5: rank <= TOP, bestPlace: rank, bestPlaceTie: tie, pills: [] };
  }
  if (futureGames.length > MAXG) return { possibleTop5: false };

  // --- 5) per-game intervals and loss vectors ---
  type Interval = { lo: number; hi: number; rep: number };
  type GSpec = { g: GameMeta; intervals: Interval[]; lossTable: number[][] };

  const gspecs: GSpec[] = futureGames.map((g) => {
    const key = keyFor(g.game_id);
    const picks: number[] = [];
    for (let i = 0; i < P; i++) {
      const s = rows[i].picks[key]?.signed;
      if (typeof s === "number") picks.push(s);
    }
    const intervals = buildIntervalsForGame(picks);
    const lossTable = intervals.map(iv => {
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

  // --- 6) enumerate scenarios (G ≤ 3) ---
  type Scenario = {
    combo: Array<{ game_id: number; lo: number; hi: number }>;
    rank: number;
    tie: boolean;
  };
  const scenarios: Scenario[] = [];
  const G = gspecs.length;

  const pushScenario = (sel: Array<{ gi: number; ii: number }>) => {
    const totals = baseTotals.slice();
    const combo: Scenario["combo"] = [];
    for (const { gi, ii } of sel) {
      const spec = gspecs[gi];
      const iv = spec.intervals[ii];
      const loss = spec.lossTable[ii];
      for (let i = 0; i < P; i++) totals[i] += loss[i];
      combo.push({ game_id: spec.g.game_id, lo: iv.lo, hi: iv.hi });
    }
    const { rank, tie } = computeRankOf(totals, uIdx);
    scenarios.push({ combo, rank, tie });
  };

  for (let i0 = 0; i0 < gspecs[0].intervals.length; i0++) {
    if (G === 1) { pushScenario([{ gi: 0, ii: i0 }]); continue; }
    for (let i1 = 0; i1 < gspecs[1].intervals.length; i1++) {
      if (G === 2) { pushScenario([{ gi: 0, ii: i0 }, { gi: 1, ii: i1 }]); continue; }
      for (let i2 = 0; i2 < gspecs[2].intervals.length; i2++) {
        pushScenario([{ gi: 0, ii: i0 }, { gi: 1, ii: i1 }, { gi: 2, ii: i2 }]);
      }
    }
  }

  // --- 7) keep feasible (rank ≤ TOP) and compute best place/tie ---
  const feasible = scenarios.filter(s => s.rank <= TOP);
  if (!feasible.length) {
    const best = scenarios.reduce((a, b) => (a.rank < b.rank ? a : b));
    return { possibleTop5: false, bestPlace: best.rank, bestPlaceTie: best.tie };
  }
  const best = feasible.reduce((a, b) => {
    if (a.rank !== b.rank) return a.rank < b.rank ? a : b;
    if (a.tie !== b.tie) return a.tie ? b : a; // prefer non-tie
    return a;
  });
  const bestPlace = best.rank;
  const bestTie = best.tie;

  // --- 8) Generic rule extraction via tiling (G = 1..3), no special-casing ---
  // Build masks per (place, tie)
  const dims = gspecs.map(s => s.intervals.length);

  function makeMask(place: number, tieFlag: boolean, G: number, dims: number[], feasible: Scenario[]): Mask {
    if (G === 1) {
      const M: Mask1 = Array(dims[0]).fill(false);
      for (const s of feasible) {
        if (s.rank !== place || s.tie !== tieFlag) continue;
        const specIdx = 0;
        const ii = gspecs[specIdx].intervals.findIndex(iv =>
          s.combo[specIdx].lo === iv.lo && s.combo[specIdx].hi === iv.hi
        );
        if (ii >= 0) M[ii] = true;
      }
      return M;
    }

    if (G === 2) {
      const M: Mask2 = Array.from({ length: dims[0] }, () => Array(dims[1]).fill(false));
      for (const s of feasible) {
        if (s.rank !== place || s.tie !== tieFlag) continue;
        const ii0 = gspecs[0].intervals.findIndex(iv =>
          s.combo[0].lo === iv.lo && s.combo[0].hi === iv.hi
        );
        const ii1 = gspecs[1].intervals.findIndex(iv =>
          s.combo[1].lo === iv.lo && s.combo[1].hi === iv.hi
        );
        if (ii0 >= 0 && ii1 >= 0) M[ii0][ii1] = true;
      }
      return M;
    }

    // G === 3
    const M: Mask3 =
      Array.from({ length: dims[0] }, () => Array.from({ length: dims[1] }, () => Array(dims[2]).fill(false)));
    for (const s of feasible) {
      if (s.rank !== place || s.tie !== tieFlag) continue;
      const ii0 = gspecs[0].intervals.findIndex(iv =>
        s.combo[0].lo === iv.lo && s.combo[0].hi === iv.hi
      );
      const ii1 = gspecs[1].intervals.findIndex(iv =>
        s.combo[1].lo === iv.lo && s.combo[1].hi === iv.hi
      );
      const ii2 = gspecs[2].intervals.findIndex(iv =>
        s.combo[2].lo === iv.lo && s.combo[2].hi === iv.hi
      );
      if (ii0 >= 0 && ii1 >= 0 && ii2 >= 0) M[ii0][ii1][ii2] = true;
    }
    return M;
  }


  function rectsToPills(place: number, tieFlag: boolean, rects: Array<{ loIdx: number[]; hiIdx: number[] }>): Pill[] {
    const pills: Pill[] = [];
    for (const r of rects) {
      const conditions = r.loIdx.map((loi, gi) => {
        const hii = r.hiIdx[gi];
        const loIv = gspecs[gi].intervals[loi];
        const hiIv = gspecs[gi].intervals[hii];
        const lo = Math.min(loIv.lo, hiIv.lo);
        const hi = Math.max(loIv.hi, hiIv.hi);
        const gid = gspecs[gi].g.game_id;
        return { game_id: gid, lo, hi, label: labelFor(gid, lo, hi) };
      });
      pills.push({ place, tie: tieFlag, conditions });
    }
    return pills;
  }

  let pills: Pill[] = [];
  const places = Array.from(new Set(feasible.map(s => s.rank))).sort((a, b) => a - b);
  for (const place of places) {
    for (const tieFlag of [false, true]) {
      const mask = makeMask(place, tieFlag, G, dims, feasible);
      const rects = rectanglesFromMask(mask, dims, G);
      pills = pills.concat(rectsToPills(place, tieFlag, rects));
    }
  }

  // Sort: place asc, then by earliest band start across games
  pills.sort((a, b) => {
    if (a.place !== b.place) return a.place - b.place;
    const al = Math.min(...a.conditions.map(c => c.lo));
    const bl = Math.min(...b.conditions.map(c => c.lo));
    return al - bl;
  });

  return { possibleTop5: pills.length > 0, bestPlace, bestPlaceTie: bestTie, pills, alsoPossible: [] };
}

// ===== Component =====
export default function Top5Explainer({
  pigeon,
  rows,
  games,
}: {
  pigeon: number;
  rows: ResultsRow[];
  games: GameMeta[];
}) {
  if (pigeon == 0 && rows.length === 0 && games.length === 0)
    console.log ("I love zero"); // Dummy to prevent lint error of unused vars
  return null;
}

export function Top5Explainer2({
  pigeon,
  rows,
  games,
}: {
  pigeon: number;
  rows: ResultsRow[];
  games: GameMeta[];
}) {
  // DEV: pretend the last N final games didn't happen (for past weeks testing)
  const rewindIds = useMemo(() => {
    if (!DEV_REWIND_LAST_N) return new Set<number>();
    // Only take FINAL games, ordered by kickoff
    const finals = games
      .filter(g => g.status === "final")
      .sort((a, b) => new Date(a.kickoff_at ?? 0).getTime() - new Date(b.kickoff_at ?? 0).getTime());
    const lastN = finals.slice(-DEV_REWIND_LAST_N).map(g => g.game_id);
    return new Set<number>(lastN);
  }, [games]);

  // Count all games that are not final (scheduled or in progress) + rewound
  const scheduledCount = useMemo(() => {
    const future = games.filter(g => {
      const isNotFinal = g.status !== "final";
      const isRewound = rewindIds.has(g.game_id);
      return isNotFinal || isRewound;
    });
    return future.length;
  }, [games, rewindIds]);

  const result = useMemo(
    () => solveN3(games, rows, pigeon, rewindIds),
    [games, rows, pigeon, rewindIds]
  );

  if (scheduledCount > MAX_EXPLAIN_GAMES) {
    return (
      <Box sx={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 1, mb: 2 }}>
        <Typography variant="body1">Come back when ≤ {MAX_EXPLAIN_GAMES} games remain to see the game outcomes you need to finish in the top 5</Typography>
      </Box>
    );
  }

  if (!rows.length) return null;

  if (!result.possibleTop5 || !result.pills || result.pills.length === 0) {
    return null;
  }

  return (
    <Box sx={{ mb: 2 }}>
      <TableContainer component={Paper} variant="outlined" sx={{ maxWidth: 720, mx: "auto" }}>
        <Table size="small" aria-label="Top-5 explainer">
          <TableHead>
            <TableRow>
              <TableCell><strong>Game Results</strong></TableCell>
              <TableCell><strong>Rank</strong></TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {(result.pills?.length ? result.pills.slice(0, 3) : []).map((pill, idx) => (
              <TableRow key={idx}>
                <TableCell sx={{ whiteSpace: "normal" }}>
                  {pill.conditions.map((c, i) => (
                    <span key={i}>
                      {i > 0 ? "  &  " : ""}
                      {c.label}
                    </span>
                  ))}
                </TableCell>
                <TableCell sx={{ whiteSpace: "nowrap" }}>
                  {pill.place}{pill.tie ? " (T)" : ""}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    </Box>
  );
}
