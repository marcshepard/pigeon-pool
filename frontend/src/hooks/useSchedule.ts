/**
 * Cache-first current schedule week loader:
 * - Returns cached schedule (live_week, next_picks_week) if fresh
 * - Otherwise fetches /schedule/current_weeks and caches it
 * - Also derives lockedWeeks (1..next_picks_week-1 or full 1..18 if season over)
 */

import { useEffect, useState } from "react";
import { getCurrentWeek } from "../backend/fetch";
import { useAppCache } from "../hooks/useAppCache";
import type { CurrentWeek } from "../backend/types";

export function useSchedule() {
  const getCurrentWeekCache = useAppCache((s) => s.getCurrentWeek);
  const setCurrentWeekCache = useAppCache((s) => s.setCurrentWeek);

  const [currentWeek, setCurrentWeek] = useState<CurrentWeek | null>(null);
  const [lockedWeeks, setLockedWeeks] = useState<number[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        setLoading(true);

        // 1) Try cache first
        const cached = getCurrentWeekCache();
        if (cached) {
          if (!cancelled) {
            setCurrentWeek(cached);
            const weeks = computeLockedWeeks(cached.week + 1);
            setLockedWeeks(weeks);
            setLoading(false);
          }
          return;
        }

        // 2) Fallback to network
        const current = await getCurrentWeek();
        setCurrentWeekCache(current);

        if (!cancelled) {
          setCurrentWeek(current);
          const weeks = computeLockedWeeks(current.week + 1);
          setLockedWeeks(weeks);
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
  }, [getCurrentWeekCache, setCurrentWeekCache]);

  return { currentWeek, lockedWeeks, loading, error };
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
