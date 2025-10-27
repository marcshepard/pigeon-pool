/**
 * Weekly results hook.
 * Fetches all weekly results and caches them in the app cache.
 */

import { useEffect, useState, useMemo, useCallback } from "react";
import { getResultsWeekLeaderboard, getResultsWeekPicks, getCurrentWeek } from "../backend/fetch";
import { LeaderboardRow, WeekPicksRow, CurrentWeek } from "../backend/types";
import { useAppCache, type GameMeta } from "../hooks/useAppCache";

export type PickCell = { signed: number; label: string; home_abbr: string; away_abbr: string };
export type ResultsRow = {
  pigeon_number: number;
  pigeon_name: string;
  picks: Record<string, PickCell>;
  points: number | null;
  rank: number | null;
};

// Compute player score for a finished game given their signed prediction and the actual margin.
export function scoreForPick(predSigned: number, actualSigned: number): number {
  const pickedHome = predSigned >= 0; // >=0 means home side
  const winnerHome = actualSigned > 0; // >0 home won, 0 tie, <0 away won
  // Diff is the absolute difference of the signed margins so opposite winners add, e.g., +3 vs -3 => 6
  const diff = Math.abs(predSigned - actualSigned);
  const wrongWinner = actualSigned === 0 || pickedHome !== winnerHome;
  return diff + (wrongWinner ? 7 : 0);
}

function shapeRowsAndGames(picks: WeekPicksRow[], lb: LeaderboardRow[]) {
  const games: GameMeta[] = [
    ...new Map(
      picks.map((p) => [
        p.game_id,
        {
          game_id: p.game_id,
          home_abbr: p.home_abbr,
          away_abbr: p.away_abbr,
          status: p.status,
          home_score: p.home_score ?? null,
          away_score: p.away_score ?? null,
          kickoff_at: p.kickoff_at,
        } satisfies GameMeta,
      ])
    ).values(),
  ];

  const lbByPigeon = new Map(lb.map((r) => [r.pigeon_number, r]));
  const byPigeon = new Map<number, ResultsRow>();

  for (const p of picks) {
    const key = `g_${p.game_id}`;
    const signed = p.picked_home ? +p.predicted_margin : -p.predicted_margin;
    const team = p.picked_home ? p.home_abbr : p.away_abbr;
    let label = p.predicted_margin === 0 ? "" : `${team} ${p.predicted_margin}`;

    // If this game is final or live and a pick exists, append per-pick score e.g., "PHI 10 (3)".
    if (label && p.home_score != null && p.away_score != null) {
      if (p.status === "final" || p.status === "in_progress") {
        const actualSigned = p.home_score - p.away_score; // + if home won, - if away won, 0 tie
        const sc = scoreForPick(signed, actualSigned);
        label = `${label} (${sc})`;
      }
    }

    let row = byPigeon.get(p.pigeon_number);
    if (!row) {
      const lbr = lbByPigeon.get(p.pigeon_number);
      row = {
        pigeon_number: p.pigeon_number,
        pigeon_name: p.pigeon_name,
        picks: {},
        points: lbr?.score ?? null,
        rank: lbr?.rank ?? null,
      };
      byPigeon.set(p.pigeon_number, row);
    }
    row.picks[key] = { signed, label, home_abbr: p.home_abbr, away_abbr: p.away_abbr };
  }

  return { rows: [...byPigeon.values()], games };
}

export function useResults(week: number | null) {
  // Select each store accessor separately to avoid infinite re-renders
  const getResultsWeekCache = useAppCache((s) => s.getResultsWeek);
  const setResultsWeekCache = useAppCache((s) => s.setResultsWeek);
  const getCurrentWeekCache = useAppCache((s) => s.getCurrentWeek);
  const setCurrentWeekCache = useAppCache((s) => s.setCurrentWeek);

  const [rows, setRows]   = useState<ResultsRow[]>([]);
  const [games, setGames] = useState<GameMeta[]>([]);
  const [currentWeek, setCurrentWeek] = useState<CurrentWeek | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState<string | null>(null);
  const [lastFetched, setLastFetched] = useState<number | null>(null);

  // Function to force refresh results from backend, bypassing cache
  const refreshResults = useCallback(async () => {
    if (week == null) return;
    setLoading(true);
    try {
      const [picks, lb] = await Promise.all([
        getResultsWeekPicks(week),
        getResultsWeekLeaderboard(week),
      ]);
      const shaped = shapeRowsAndGames(picks, lb);
      setRows([...shaped.rows]);
      setGames(shaped.games);
      setResultsWeekCache(week, { picks, lb, games: shaped.games, rows: shaped.rows as unknown[] });
      setLastFetched(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e ?? ""));
    } finally {
      setLoading(false);
    }
  }, [week, setLoading, setRows, setGames, setResultsWeekCache]);

  // EFFECT 1: fetch/cache data for the selected week
  useEffect(() => {
    if (week == null) return;
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);
        const cached = getResultsWeekCache(week);
        if (cached) {
          const shapedRows = (cached.rows as ResultsRow[] | undefined)
            ?? shapeRowsAndGames(cached.picks, cached.lb).rows;
          if (!cancelled) {
            setRows([...shapedRows]);   // make mutable copy
            setGames(cached.games);
            setLastFetched(Date.now());
          }
        } else {
          await refreshResults();
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e ?? ""));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [week, getResultsWeekCache, setResultsWeekCache, refreshResults]);

  // EFFECT 2: fetch/cache the current week
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // 1) try cache
        const cached = getCurrentWeekCache();
        if (cached && !cancelled) {
          setCurrentWeek(cached);
          return;
        }

        // 2) fetch once and cache
        const current = await getCurrentWeek();
        setCurrentWeekCache(current);
        if (!cancelled) {
          setCurrentWeek(current);
        }
      } catch {
        // ignore
      }
    })();
    return () => { cancelled = true; };
  }, [getCurrentWeekCache, setCurrentWeekCache]);

  const consensusRow: ResultsRow | null = useMemo(() => {
    if (!rows.length) return null;

    const out: ResultsRow = {
        pigeon_number: 0,              // special id so it won't collide
        pigeon_name: "Consensus",
        picks: {},
        points: null,
        rank: null,
    };

    for (const g of games) {
        const key = `g_${g.game_id}`;
        let sum = 0, n = 0;
        for (const r of rows) {
          const v = r.picks[key]?.signed;
          // Exclude picks with value 0
          if (typeof v === "number" && v !== 0) { sum += v; n += 1; }
        }
        const mean = n ? sum / n : 0;
        const team = mean >= 0 ? g.home_abbr : g.away_abbr;
        const absMean = Math.abs(mean);
        const label = absMean === 0 ? "" : `${team} ${absMean.toFixed(1)}`;

        out.picks[key] = { signed: mean, label, home_abbr: g.home_abbr, away_abbr: g.away_abbr };
    }

    return out;
    }, [rows, games]);

  return { rows, games, currentWeek, consensusRow, loading, error, refreshResults, lastFetched };
}
