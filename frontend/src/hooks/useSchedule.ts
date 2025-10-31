/**
 * Cache-first current schedule week loader:
 * - Returns cached schedule (live_week, next_picks_week) if fresh
 * - Otherwise fetches /schedule/current_weeks and caches it
 * - Also derives lockedWeeks (1..next_picks_week-1 or full 1..18 if season over)
 */

import { useEffect, useState, useMemo } from "react";
import { getCurrentWeek } from "../backend/fetch";
import { useAppCache } from "../hooks/useAppCache";

export function useSchedule() {
  const setCurrentWeekCache = useAppCache((s) => s.setCurrentWeek);
  
  // Subscribe to currentWeek from Zustand for reactivity
  const currentWeekFromCache = useAppCache((s) => s.currentWeek?.data ?? null);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Compute locked weeks based on current week
  const lockedWeeks = useMemo(() => {
    if (!currentWeekFromCache) return [];
    return computeLockedWeeks(currentWeekFromCache.week + 1);
  }, [currentWeekFromCache]);

  // Fetch current week on mount if not cached
  useEffect(() => {
    if (currentWeekFromCache) return; // Already cached
    
    let cancelled = false;

    (async () => {
      try {
        setLoading(true);

        const current = await getCurrentWeek();
        if (!cancelled) {
          setCurrentWeekCache(current);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e ?? ""));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [currentWeekFromCache, setCurrentWeekCache]);

  return { currentWeek: currentWeekFromCache, lockedWeeks, loading, error };
}

function computeLockedWeeks(next_picks_week: number | null): number[] {
  // If next_picks_week is n, locked weeks are 1..(n-1)
  // If null (season over), all 1..18 are locked
  if (next_picks_week == null) {
    return Array.from({ length: 18 }, (_, i) => i + 1);
  }
  const count = Math.max(0, next_picks_week - 1);
  return Array.from({ length: count }, (_, i) => i + 1);
}
