/**
 * useResults.ts - global results hook
 * Fetches all weekly results and caches them in the app cache.
 */

/**
 * Weekly results hook.
 * Fetches results for a specific week and caches them.
 */

import { useEffect, useState, useMemo, useCallback } from "react";
import { getResultsWeekLeaderboard, getResultsWeekPicks, getCurrentWeek } from "../backend/fetch";
import { useAppCache, type GameMeta } from "../hooks/useAppCache";
import { shapeRowsAndGames, type ResultsRow } from "../utils/resultsShaping";

export function useResults(week: number | null) {
  const getResultsWeekCache = useAppCache((s) => s.getResultsWeek);
  const setResultsWeekCache = useAppCache((s) => s.setResultsWeek);
  const getCurrentWeekCache = useAppCache((s) => s.getCurrentWeek);
  const setCurrentWeekCache = useAppCache((s) => s.setCurrentWeek);
  
  // Subscribe to currentWeek from Zustand for reactivity
  const currentWeekFromCache = useAppCache((s) => s.currentWeek?.data ?? null);

  const [rows, setRows] = useState<ResultsRow[]>([]);
  const [games, setGames] = useState<GameMeta[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Manual refresh function (bypasses cache)
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
      setResultsWeekCache(week, { 
        picks, 
        lb, 
        games: shaped.games, 
        rows: shaped.rows as unknown[] 
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e ?? ""));
    } finally {
      setLoading(false);
    }
  }, [week, setResultsWeekCache]);

  // Fetch/cache data for the selected week
  useEffect(() => {
    if (week == null) return;
    let cancelled = false;
    
    (async () => {
      try {
        setLoading(true);
        const cached = getResultsWeekCache(week);
        
        if (cached) {
          // Use cached data
          const shapedRows = (cached.rows as ResultsRow[] | undefined)
            ?? shapeRowsAndGames(cached.picks, cached.lb).rows;
          if (!cancelled) {
            setRows([...shapedRows]);
            setGames(cached.games);
          }
        } else {
          // Fetch fresh data
          await refreshResults();
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e ?? ""));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    
    return () => { cancelled = true; };
  }, [week, getResultsWeekCache, refreshResults]);

  // Fetch/cache current week info on mount if not already cached
  useEffect(() => {
    const cached = getCurrentWeekCache();
    if (cached) return; // Already cached, subscription will handle updates
    
    let cancelled = false;
    
    (async () => {
      try {
        const current = await getCurrentWeek();
        if (!cancelled) {
          setCurrentWeekCache(current);
        }
      } catch {
        // ignore - auto-refresh manager will retry
      }
    })();
    
    return () => { cancelled = true; };
  }, [getCurrentWeekCache, setCurrentWeekCache]);

  // Compute consensus row
  const consensusRow: ResultsRow | null = useMemo(() => {
    if (!rows.length) return null;

    const out: ResultsRow = {
      pigeon_number: 0,
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
        if (typeof v === "number" && v !== 0) { 
          sum += v; 
          n += 1; 
        }
      }
      const mean = n ? sum / n : 0;
      const team = mean >= 0 ? g.home_abbr : g.away_abbr;
      const absMean = Math.abs(mean);
      const label = absMean === 0 ? "" : `${team} ${absMean.toFixed(1)}`;

      out.picks[key] = { 
        signed: mean, 
        label, 
        home_abbr: g.home_abbr, 
        away_abbr: g.away_abbr 
      };
    }

    return out;
  }, [rows, games]);

  return { 
    rows, 
    games, 
    currentWeek: currentWeekFromCache, 
    consensusRow, 
    loading, 
    error, 
    refreshResults 
  };
}
