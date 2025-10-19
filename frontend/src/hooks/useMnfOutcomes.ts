import { useMemo } from "react";
import type { ResultsRow } from "./useResults";
import type { GameMeta } from "../hooks/useAppCache";

function isMonday(d: Date) { return d.getDay() === 1; } // 0=Sun .. 6=Sat

function selectMnfGames(games: GameMeta[]): GameMeta[] {
  // For completed weeks, allow MNF games regardless of status
  return games
    .filter(g => {
      if (!g.kickoff_at) return false;
      const dt = new Date(g.kickoff_at);
      return isMonday(dt);
    })
    .slice(0, 2);
}

function scoreForPickFull(predSigned: number, actualSigned: number): number {
  const isMade = Math.abs(predSigned) > 0;
  const diff = Math.abs(predSigned - actualSigned);
  const signPred = Math.sign(predSigned);
  const signAct  = Math.sign(actualSigned);
  const penalty = !isMade ? 100 : (signAct === 0 || signPred !== signAct ? 7 : 0);
  return diff + penalty;
}

function computeBaseScores(rows: ResultsRow[], games: GameMeta[]): Map<number, number> {
  const base = new Map<number, number>();
  for (const r of rows) base.set(r.pigeon_number, 0);

  for (const g of games) {
    if (g.status !== "final") continue;
    // Exclude MNF games (Monday games) from baseline
    const dt = g.kickoff_at ? new Date(g.kickoff_at) : null;
    if (dt && dt.getDay() === 1) continue;
    const key = `g_${g.game_id}`;
    const actualSigned = (g.home_score ?? 0) - (g.away_score ?? 0);
    for (const r of rows) {
      const cell = r.picks[key];
      if (!cell) continue;
      const sc = scoreForPickFull(cell.signed ?? 0, actualSigned);
      base.set(r.pigeon_number, (base.get(r.pigeon_number) ?? 0) + sc);
    }
  }
  return base;
}

// Kinks: the only A values where winners can change are unique predicted signed margins & 0.
function kinkValues(preds: number[]): number[] {
  // Include all integer margins between min and max prediction, plus 0
  const min = Math.min(0, ...preds.map(Math.floor));
  const max = Math.max(0, ...preds.map(Math.ceil));
  const vals: number[] = [];
  for (let i = min; i <= max; ++i) vals.push(i);
  return vals;
}

type OneGameWhatIf = {
  kind: "one";
  buckets: number[]; // actual signed margins we evaluated
  rows: Array<{
    actual: number;
    winners: { pn: number; name: string }[];
    top5: Array<{ pn: number; name: string; total: number }>;
  }>;
  home: string;
  away: string;
};

type TwoGameWhatIf = {
  kind: "two";
  x: { game_id: number; buckets: number[]; home: string; away: string };
  y: { game_id: number; buckets: number[]; home: string; away: string };
  grid: Array<Array<{
    winners: { pn: number; name: string }[];
    bestTotal: number;
  }>>;
};

type NoWhatIf = { kind: "none" };

export function useMnfOutcomes(week: number | null, rows: ResultsRow[], games: GameMeta[]) {
  return useMemo<OneGameWhatIf | TwoGameWhatIf | NoWhatIf>(() => {
    if (week == null || !rows.length || !games.length) return { kind: "none" };
    const mnf = selectMnfGames(games);
    if (mnf.length === 0) return { kind: "none" };

    const base = computeBaseScores(rows, games);

    if (mnf.length === 1) {
      const g = mnf[0];
      const key = `g_${g.game_id}`;
      const preds = rows.map(r => r.picks[key]?.signed ?? 0);
      const Avals = kinkValues(preds);

      const rowsOut = Avals.map(A => {
        // compute totals for all players under scenario A
        const totals = rows.map(r => {
          const pred = r.picks[key]?.signed ?? 0;
          const tot = (base.get(r.pigeon_number) ?? 0) + scoreForPickFull(pred, A);
          return { pn: r.pigeon_number, name: r.pigeon_name, total: tot };
        }).sort((a,b)=>a.total - b.total);

        const best = totals[0].total;
        const winners = totals.filter(t => t.total === best).map(t => ({ pn: t.pn, name: t.name }));
        const top5 = totals.slice(0, 5);
        return { actual: A, winners, top5 };
      });

      return {
        kind: "one",
        buckets: Avals,
        rows: rowsOut,
        home: g.home_abbr,
        away: g.away_abbr,
      };
    }

    // two MNF games
    const g1 = mnf[0], g2 = mnf[1];
    const k1 = `g_${g1.game_id}`, k2 = `g_${g2.game_id}`;
    const p1 = rows.map(r => r.picks[k1]?.signed ?? 0);
    const p2 = rows.map(r => r.picks[k2]?.signed ?? 0);
    const A1 = kinkValues(p1);
    const A2 = kinkValues(p2);

    const grid = A2.map(a2 => A1.map(a1 => {
      let best = Number.MAX_SAFE_INTEGER;
      let winners: { pn: number; name: string }[] = [];

      for (const r of rows) {
        const s1 = scoreForPickFull(r.picks[k1]?.signed ?? 0, a1);
        const s2 = scoreForPickFull(r.picks[k2]?.signed ?? 0, a2);
        const tot = (base.get(r.pigeon_number) ?? 0) + s1 + s2;
        if (tot < best) {
          best = tot;
          winners = [{ pn: r.pigeon_number, name: r.pigeon_name }];
        } else if (tot === best) {
          winners.push({ pn: r.pigeon_number, name: r.pigeon_name });
        }
      }

      return { winners, bestTotal: best };
    }));

    return {
      kind: "two",
      x: { game_id: g1.game_id, buckets: A1, home: g1.home_abbr, away: g1.away_abbr },
      y: { game_id: g2.game_id, buckets: A2, home: g2.home_abbr, away: g2.away_abbr },
      grid,
    };
  }, [week, rows, games]);
}
