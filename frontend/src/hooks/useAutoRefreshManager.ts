/**
 * useAutoRefreshManager.ts - global auto-refresh manager hook.
 * Mount once at the app level to auto-refresh all weeks with live games.
 */

import { useEffect, useRef } from "react";
import { useAppCache } from "./useAppCache";
import { shapeRowsAndGames } from "../utils/resultsShaping";
import { getResultsWeekLeaderboard, getResultsWeekPicks } from "../backend/fetch";

export function useAutoRefreshManager() {
  const resultsByWeek = useAppCache((s) => s.resultsByWeek);
  const setResultsWeek = useAppCache((s) => s.setResultsWeek);
  
  const timerRef = useRef<number | null>(null);
  const isRefreshingRef = useRef(false);

  const intervalMs = Number(import.meta.env.VITE_AUTO_REFRESH_INTERVAL_MINUTES || 30) * 60 * 1000;

  useEffect(() => {
    async function refreshAllLiveWeeks() {
      if (isRefreshingRef.current) return;
      
      const now = Date.now();
      const weeksToRefresh: number[] = [];
      
      for (const [weekStr, cached] of Object.entries(resultsByWeek)) {
        if (!cached) continue;
        const week = Number(weekStr);
        const hasLiveGames = cached.data.games.some(g => {
          const kickoff = new Date(g.kickoff_at).getTime();
          return kickoff <= now && g.status !== "final";
        });
        if (hasLiveGames) weeksToRefresh.push(week);
      }

      if (weeksToRefresh.length === 0) return;

      console.log(`[AutoRefresh] Refreshing weeks: ${weeksToRefresh.join(', ')}`);
      
      isRefreshingRef.current = true;
      try {
        await Promise.all(
          weeksToRefresh.map(async (week) => {
            try {
              const [picks, lb] = await Promise.all([
                getResultsWeekPicks(week),
                getResultsWeekLeaderboard(week),
              ]);
              const shaped = shapeRowsAndGames(picks, lb);
              setResultsWeek(week, { 
                picks, 
                lb, 
                games: shaped.games, 
                rows: shaped.rows as unknown[] 
              });
            } catch (err) {
              console.error(`[AutoRefresh] Failed to refresh week ${week}:`, err);
            }
          })
        );
      } finally {
        isRefreshingRef.current = false;
      }
    }

    function startTimer() {
      if (document.visibilityState === "visible") {
        refreshAllLiveWeeks();
        timerRef.current = window.setInterval(refreshAllLiveWeeks, intervalMs);
      }
    }

    function stopTimer() {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    }

    function handleVisibilityChange() {
      if (document.visibilityState === "visible") {
        stopTimer(); // Stop before restarting to avoid duplicates
        startTimer();
      } else {
        stopTimer();
      }
    }

    startTimer();
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      stopTimer();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [resultsByWeek, setResultsWeek, intervalMs]);
}