/**
 * useAutoRefreshManager.ts
 * Global auto-refresh manager hook.
 * Only refreshes the current week when it has in-progress games.
 */

import { useEffect, useRef } from "react";
import { useAppCache } from "./useAppCache";
import { shapeRowsAndGames } from "../utils/resultsShaping";
import { getResultsWeekLeaderboard, getResultsWeekPicks, getCurrentWeek } from "../backend/fetch";

export function useAutoRefreshManager() {
  const resultsByWeek = useAppCache((s) => s.resultsByWeek);
  const setResultsWeek = useAppCache((s) => s.setResultsWeek);
  const getCurrentWeekCache = useAppCache((s) => s.getCurrentWeek);
  const setCurrentWeekCache = useAppCache((s) => s.setCurrentWeek);
  
  const timerRef = useRef<number | null>(null);
  const isRefreshingRef = useRef(false);

  const intervalMs = Number(import.meta.env.VITE_AUTO_REFRESH_INTERVAL_MINUTES || 30) * 60 * 1000;

  useEffect(() => {
    async function refreshCurrentWeekIfLive() {
      if (isRefreshingRef.current) return;
      
      try {
        // First, get the current week info
        const currentWeekData = await getCurrentWeek();
        setCurrentWeekCache(currentWeekData);
        
        // Only refresh if status is "in_progress"
        if (currentWeekData.status !== "in_progress") {
          return;
        }
        
        const currentWeekNum = currentWeekData.week;
        
        // Check if current week is in cache and has live games
        const cached = resultsByWeek[currentWeekNum];
        if (!cached) {
          // Not in cache yet, no need to refresh (will be fetched on first visit)
          return;
        }
        
        // Verify there are actually in-progress games (kickoff passed, not final)
        const now = Date.now();
        const hasLiveGames = cached.data.games.some(g => {
          const kickoff = new Date(g.kickoff_at).getTime();
          return kickoff <= now && g.status !== "final";
        });
        
        if (!hasLiveGames) {
          return;
        }

        console.log(`[AutoRefresh] Refreshing current week ${currentWeekNum}`);
        
        isRefreshingRef.current = true;
        try {
          const [picks, lb] = await Promise.all([
            getResultsWeekPicks(currentWeekNum),
            getResultsWeekLeaderboard(currentWeekNum),
          ]);
          const shaped = shapeRowsAndGames(picks, lb);
          setResultsWeek(currentWeekNum, { 
            picks, 
            lb, 
            games: shaped.games, 
            rows: shaped.rows as unknown[] 
          });
        } catch (err) {
          console.error(`[AutoRefresh] Failed to refresh week ${currentWeekNum}:`, err);
        }
      } finally {
        isRefreshingRef.current = false;
      }
    }

    function startTimer() {
      if (document.visibilityState === "visible") {
        // Refresh immediately on start
        refreshCurrentWeekIfLive();
        // Then set up interval
        timerRef.current = window.setInterval(refreshCurrentWeekIfLive, intervalMs);
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
  }, [resultsByWeek, setResultsWeek, getCurrentWeekCache, setCurrentWeekCache, intervalMs]);
}