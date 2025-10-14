/**
 * Weekly results hook.
 * Fetches all weekly results and caches them in the app cache.
 */

import { useEffect, useState, useMemo } from "react";
import { getResultsWeekLeaderboard, getResultsWeekPicks, getScheduleCurrent } from "../backend/fetch";
import { LeaderboardRow as ApiLeaderboardRow, WeekPicksRow as ApiWeekPick } from "../backend/types";
import { useAppCache, type GameMeta } from "../hooks/useAppCache";

type PickCell = { signed: number; label: string; home_abbr: string; away_abbr: string };
export type ResultsRow = {
  pigeon_number: number;
  pigeon_name: string;
  picks: Record<string, PickCell>;
  points: number | null;
  rank: number | null;
};

function shapeRowsAndGames(picks: ApiWeekPick[], lb: ApiLeaderboardRow[]) {
  const games: GameMeta[] = [
    ...new Map(
      picks.map((p) => [p.game_id, { game_id: p.game_id, home_abbr: p.home_abbr, away_abbr: p.away_abbr }])
    ).values(),
  ];

  const lbByPigeon = new Map(lb.map((r) => [r.pigeon_number, r]));
  const byPigeon = new Map<number, ResultsRow>();

  for (const p of picks) {
    const key = `g_${p.game_id}`;
    const signed = p.picked_home ? +p.predicted_margin : -p.predicted_margin;
    const team = p.picked_home ? p.home_abbr : p.away_abbr;
  const label = p.predicted_margin === 0 ? "" : `${team} +${p.predicted_margin}`;

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
    const getResultsWeek = useAppCache((s) => s.getResultsWeek);
    const setResultsWeek = useAppCache((s) => s.setResultsWeek);
    const getSchedule    = useAppCache((s) => s.getSchedule);
    const setSchedule    = useAppCache((s) => s.setSchedule);

    const [rows, setRows]   = useState<ResultsRow[]>([]);
    const [games, setGames] = useState<GameMeta[]>([]);
    const [liveWeek, setLiveWeek] = useState<number | null>(null);
    const [weekState, setWeekState] = useState<"completed" | "in progress" | "not started">("completed");
    const [loading, setLoading] = useState(false);
    const [error, setError]     = useState<string | null>(null);

    // EFFECT 1: fetch/cache data for the selected week (no liveWeek read here)
    useEffect(() => {
    if (week == null) return;
    let cancelled = false;
    (async () => {
        try {
        setLoading(true);
        const cached = getResultsWeek(week);
        if (cached) {
            const shapedRows = (cached.rows as ResultsRow[] | undefined)
            ?? shapeRowsAndGames(cached.picks, cached.lb).rows;
            if (!cancelled) {
            setRows([...shapedRows]);   // make mutable copy
            setGames(cached.games);
            }
        } else {
            const [picks, lb] = await Promise.all([
            getResultsWeekPicks(week),
            getResultsWeekLeaderboard(week),
            ]);
            const shaped = shapeRowsAndGames(picks, lb);
            if (!cancelled) {
            setRows([...shaped.rows]);
            setGames(shaped.games);
            }
            setResultsWeek(week, { picks, lb, games: shaped.games, rows: shaped.rows as unknown[] });
        }
        } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e ?? ""));
        } finally {
        if (!cancelled) setLoading(false);
        }
    })();
    return () => { cancelled = true; };
    }, [week, getResultsWeek, setResultsWeek]);

    // EFFECT 2 (cache-first schedule):
    useEffect(() => {
      let cancelled = false;
      (async () => {
        try {
          // 1) try cache
          const cached = getSchedule();
          if (cached && !cancelled) {
            setLiveWeek(cached.live_week ?? null);   // ✅ use the setter
            return;
          }

          // 2) fetch once and cache
          const sc = await getScheduleCurrent();
          const sig = { live_week: sc.live_week ?? null, next_picks_week: sc.next_picks_week ?? null };
          setSchedule(sig);
          if (!cancelled) setLiveWeek(sig.live_week);  // ✅ use the setter
        } catch {
          // ignore
        }
      })();
      return () => { cancelled = true; };
    }, [getSchedule, setSchedule]);

    // EFFECT 3: compute weekState from liveWeek + rows
    useEffect(() => {
    if (week == null || liveWeek == null || week !== liveWeek) {
        setWeekState("completed");
    } else {
        const allZero = rows.every(r => (r.points ?? 0) === 0);
        setWeekState(allZero ? "not started" : "in progress");
    }
    }, [week, liveWeek, rows]);

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
        const v = r.picks[key]?.signed;   // signed = +margin if home, -margin if away
        if (typeof v === "number") { sum += v; n += 1; }
        }
        const mean = n ? sum / n : 0;
        const team = mean >= 0 ? g.home_abbr : g.away_abbr;
  const absMean = Math.abs(mean);
  const label = absMean === 0 ? "" : `${team} +${absMean.toFixed(1)}`;

        out.picks[key] = { signed: mean, label, home_abbr: g.home_abbr, away_abbr: g.away_abbr };
    }

    return out;
    }, [rows, games]);

    return { rows, games, weekState, consensusRow, loading, error };
}
