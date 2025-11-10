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
  games: { game_id: number; status?: string }[]
): string {
  const userRow = rows.find((r) => r.pigeon_number === pigeon) || null;
  // Check if pigeon has entered any picks
  const hasAnyPicks = userRow && Object.values(userRow.picks as Record<string, PickCell>).some((p: PickCell) => typeof p?.signed === 'number' && p.signed !== 0);
  if (!hasAnyPicks) {
    return 'last place';
  }
  // Start with current points for all users
  const basePoints = new Map<number, number>();
  for (const r of rows) basePoints.set(r.pigeon_number, r.points ?? 0);
  const bestTotals = new Map<number, number>(basePoints);
  if (userRow) {
    for (const g of games) {
      const key = `g_${g.game_id}`;
      const uPred = (userRow.picks as Record<string, PickCell>)[key]?.signed;
      if (typeof uPred !== "number") continue; // if user has no pick, skip game
      // This becomes the hypothetical actual
      const actual = uPred;
      for (const r of rows) {
        const pred = (r.picks as Record<string, PickCell>)[key]?.signed;
        if (typeof pred !== "number") continue;
        bestTotals.set(r.pigeon_number, (bestTotals.get(r.pigeon_number) ?? 0) + scoreForPick(pred, actual));
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
    return `${tie ? "T" : ""}${rank}`;
  }
  return '—';
}
