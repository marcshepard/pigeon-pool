/**
 * Calculates the best possible rank for a pigeon.
 * If no picks, returns 'last place'.
 * Otherwise, simulates all games as if the user's picks are the actual results,
 * and ranks all users accordingly.
 */
import { scoreForPick, type PickCell, type ResultsRow } from './resultsShaping';

export function calculateBestPossibleRank(
  pigeon: number,
  rows: ResultsRow[],
  games: { game_id: number; status?: string; home_score?: number | null; away_score?: number | null }[]
): string {
  const debug = pigeon === 13;
  const userRow = rows.find((r) => r.pigeon_number === pigeon) || null;
  // Check if pigeon has entered any picks
  const hasAnyPicks = userRow && Object.values(userRow.picks as Record<string, PickCell>).some((p: PickCell) => typeof p?.signed === 'number' && p.signed !== 0);
  if (!hasAnyPicks) {
    return 'last place';
  }
  const scoreWithPenalty = (pred: number | undefined, actual: number) => {
    if (typeof pred === 'number') {
      return scoreForPick(pred, actual);
    }
    // Missing pick takes the heavy miss penalty plus the absolute margin, matching MNF tooling expectations.
    return Math.abs(actual) + 100;
  };
  // Recompute baseline purely from finalized games to ignore any live-game scoring that rows.points may already include.
  const baseTotals = new Map<number, number>();
  for (const r of rows) baseTotals.set(r.pigeon_number, 0);
  for (const g of games) {
    if ((g.status ?? '') !== 'final') continue;
    if (typeof g.home_score !== 'number' || typeof g.away_score !== 'number') continue;
    const actualFinal = g.home_score - g.away_score;
    const key = `g_${g.game_id}`;
    for (const r of rows) {
      const pred = (r.picks as Record<string, PickCell>)[key]?.signed;
      const updated = (baseTotals.get(r.pigeon_number) ?? 0) + scoreWithPenalty(pred, actualFinal);
      baseTotals.set(r.pigeon_number, updated);
    }
  }
  const bestTotals = new Map<number, number>(baseTotals);
  if (debug) {
    console.log('[BPR:13] base totals (final games only)', Object.fromEntries(bestTotals));
  }
  if (userRow) {
    for (const g of games) {
      const key = `g_${g.game_id}`;
      if ((g.status ?? '') === 'final') {
        // Already accounted for in baseline; skip.
        continue;
      }
      // Simulate as user's pick for non-final games
      const uPred = (userRow.picks as Record<string, PickCell>)[key]?.signed;
      if (typeof uPred !== "number") continue; // if user has no pick, skip game entirely
      const actual = uPred;
      if (debug) {
        console.log(`[BPR:13] simulate game ${g.game_id} with user pick ${actual}`);
      }
      const penalized: Array<{ pn: number; name: string; score: number }> = [];
      for (const r of rows) {
        const predCell = (r.picks as Record<string, PickCell>)[key];
        const pred = typeof predCell?.signed === 'number' ? predCell.signed : undefined;
        const delta = scoreWithPenalty(pred, actual);
        const updated = (bestTotals.get(r.pigeon_number) ?? 0) + delta;
        bestTotals.set(r.pigeon_number, updated);
        if (typeof pred !== 'number') {
          penalized.push({ pn: r.pigeon_number, name: r.pigeon_name, score: delta });
        }
        if (debug && r.pigeon_number === pigeon) {
          console.log(`[BPR:13]   add ${delta} for game ${g.game_id} (pred=${typeof pred === 'number' ? pred : 'none'}) -> ${updated}`);
        }
      }
      if (debug && penalized.length) {
        console.log(`[BPR:13]   penalized missing picks`, penalized);
      }
    }
  }
  // Only include players with at least one valid pick
  const validPigeons = rows.filter(r => {
    return Object.values(r.picks as Record<string, PickCell>).some((p: PickCell) => typeof p?.signed === 'number' && p.signed !== 0);
  });
  const bestUserTotal = bestTotals.get(pigeon);
  if (typeof bestUserTotal === "number") {
    const totals = validPigeons.map(r => bestTotals.get(r.pigeon_number)).filter(t => typeof t === 'number') as number[];
    const sorted = [...totals].sort((a, b) => a - b);
    const rank = sorted.findIndex((t) => t === bestUserTotal) + 1;
    const tie = totals.filter((t) => t === bestUserTotal).length > 1;
    if (debug) {
      console.log('[BPR:13] final totals snapshot', sorted.slice(0, 10));
      console.log('[BPR:13] best total', bestUserTotal, 'rank', `${tie ? 'T' : ''}${rank}`);
    }
    return `${tie ? "T" : ""}${rank}`;
  }
  return '—';
}
