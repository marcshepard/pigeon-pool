/**
 * Cache-first current schedule week loader:
 * - Returns cached schedule (live_week, next_picks_week) if fresh
 * - Otherwise fetches /schedule/current_weeks and caches it
 * - Also derives lockedWeeks (1..next_picks_week-1 or full 1..18 if season over)
 */

import { useEffect, useState } from "react";
import { getScheduleCurrent } from "../backend/fetch";
import { useAppCache } from "../hooks/useAppCache";
import type { ScheduleCurrent } from "../backend/types";

export function useSchedule() {
  const getSchedule = useAppCache((s) => s.getSchedule);
  const setSchedule = useAppCache((s) => s.setSchedule);

  const [schedule, setLocal] = useState<ScheduleCurrent | null>(null);
  const [lockedWeeks, setLockedWeeks] = useState<number[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        setLoading(true);

        // 1) Try cache first
        const cached = getSchedule();
        if (cached) {
          if (!cancelled) {
            setLocal(cached);
            const weeks = computeLockedWeeks(cached.next_picks_week);
            setLockedWeeks(weeks);
            setLoading(false);
          }
          return;
        }

        // 2) Fallback to network
        const sc = await getScheduleCurrent();
        const sig: ScheduleCurrent = {
          next_picks_week: sc.next_picks_week ?? null,
          live_week: sc.live_week ?? null,
        };
        setSchedule(sig);

        if (!cancelled) {
          setLocal(sig);
          const weeks = computeLockedWeeks(sig.next_picks_week);
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
  }, [getSchedule, setSchedule]);

  return { schedule, lockedWeeks, loading, error };
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
