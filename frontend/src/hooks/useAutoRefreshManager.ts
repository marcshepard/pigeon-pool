/**
 * useAutoRefreshManager.ts
 * Global auto-refresh manager hook.
 * - Polls currentWeek status periodically
 * - Refreshes scores during in_progress games
 * - Detects client-side scheduled→in_progress transition
 * - Forces refresh if week data is stale (>2 days old)
 */

import { useEffect, useRef } from "react";
import { useAppCache } from "./useAppCache";
import { shapeRowsAndGames } from "../utils/resultsShaping";
import { getResultsWeekLeaderboard, getResultsWeekPicks, getCurrentWeek } from "../backend/fetch";

export function useAutoRefreshManager() {
  const timerRef = useRef<number | null>(null);
  const kickoffTimerRef = useRef<number | null>(null);
  const isRefreshingRef = useRef(false);

  const intervalMs = Number(import.meta.env.VITE_AUTO_REFRESH_INTERVAL_MINUTES || 30) * 60 * 1000;

  useEffect(() => {
    /**
     * Check if week data is stale (all games kicked off >2 days ago)
     * This handles the case where we need to transition to a new week
     */
    function isWeekStale(games: Array<{ kickoff_at: string }>): boolean {
      if (games.length === 0) return false;
      
      const now = Date.now();
      const twoDaysMs = 2 * 24 * 60 * 60 * 1000;
      const allGamesOld = games.every(g => {
        const kickoff = new Date(g.kickoff_at).getTime();
        return now - kickoff > twoDaysMs;
      });
      
      return allGamesOld;
    }

    /**
     * Setup timer for scheduled→in_progress transition based on first kickoff
     */
    function setupKickoffTimer(games: Array<{ kickoff_at: string; status?: string }>) {
      // Clear any existing timer
      if (kickoffTimerRef.current) {
        clearTimeout(kickoffTimerRef.current);
        kickoffTimerRef.current = null;
      }

      const now = Date.now();
      const futureGames = games.filter(g => {
        const kickoff = new Date(g.kickoff_at).getTime();
        return kickoff > now && g.status === "scheduled";
      });

      if (futureGames.length === 0) return;

      // Find the earliest kickoff
      const earliestKickoff = Math.min(
        ...futureGames.map(g => new Date(g.kickoff_at).getTime())
      );

      const msUntilKickoff = earliestKickoff - now;
      
      if (msUntilKickoff > 0 && msUntilKickoff < 7 * 24 * 60 * 60 * 1000) { // Within 1 week
        console.log(`[AutoRefresh] Setting timer for first kickoff in ${Math.round(msUntilKickoff / 1000 / 60)} minutes`);
        
        kickoffTimerRef.current = window.setTimeout(async () => {
          console.log(`[AutoRefresh] First game kicked off - checking for state transition`);
          try {
            const currentWeekData = await getCurrentWeek();
            useAppCache.getState().setCurrentWeek(currentWeekData);
            
            // Trigger immediate refresh if we have cached data
            if (currentWeekData.status === "in_progress") {
              await refreshCurrentWeekIfLive();
            }
          } catch (err) {
            console.error("[AutoRefresh] Failed to check state after kickoff:", err);
          }
        }, msUntilKickoff);
      }
    }

    async function refreshCurrentWeekIfLive() {
      if (isRefreshingRef.current) return;
      
      try {
        // Always fetch current week info (handles all state transitions)
        const currentWeekData = await getCurrentWeek();
        const prevWeekData = useAppCache.getState().currentWeek?.data;
        useAppCache.getState().setCurrentWeek(currentWeekData);
        
        // Log state changes
        if (prevWeekData && 
            (prevWeekData.week !== currentWeekData.week || 
             prevWeekData.status !== currentWeekData.status)) {
          console.log(
            `[AutoRefresh] Week state changed: ${prevWeekData.week}/${prevWeekData.status} → ${currentWeekData.week}/${currentWeekData.status}`
          );
        }
        
        const currentWeekNum = currentWeekData.week;
        const cached = useAppCache.getState().resultsByWeek[currentWeekNum];
        
        // Check if week data is stale - force refresh if so
        if (cached && isWeekStale(cached.data.games)) {
          console.log(`[AutoRefresh] Week ${currentWeekNum} data is stale (>2 days old) - forcing refresh`);
          // Don't return - fall through to refresh logic below
        }
        
        // Setup kickoff timer if we're in scheduled state
        if (currentWeekData.status === "scheduled" && cached) {
          setupKickoffTimer(cached.data.games);
        }
        
        // Only refresh scores if status is "in_progress"
        if (currentWeekData.status !== "in_progress") {
          return;
        }
        
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
          console.log(`[AutoRefresh] No more live games for week ${currentWeekNum}`);
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
          useAppCache.getState().setResultsWeek(currentWeekNum, { 
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
      if (kickoffTimerRef.current) {
        clearTimeout(kickoffTimerRef.current);
      }
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [intervalMs]);
}