/**
 * Year-to-date leaderboard hook.
 * Fetches all locked weekly leaderboards and computes YTD aggregates and rankings.
 * Caches the result in app cache.
 */

import { useEffect, useMemo, useState } from "react";
import { getResultsAllLeaderboards, getCurrentWeek, getPayouts } from "../backend/fetch";
import { LeaderboardRow, type PayoutRow } from "../backend/types";
import { useAppCache } from "../hooks/useAppCache";

export type WeekCell = { rank: number; score: number; points: number };
export type YtdRow = {
  pigeon_number: number;
  pigeon_name: string;
  byWeek: Record<number, WeekCell>;
  pointsAdj: number;     // total weekly position points minus worst week
  top5: number;          // # of weeks with rank <= 5
  returnTotal: number;   // split payouts with ties
  yearRankPts: number;   // rank by pointsAdj (asc)
  yearRankRet: number;   // rank by returnTotal (desc)
};

export function useYtd() {
  // ✅ select each store value separately (no object selector)
  const getYtdCache         = useAppCache((s) => s.getYtd);
  const setYtdCache         = useAppCache((s) => s.setYtd);
  const setCurrentWeekCache = useAppCache((s) => s.setCurrentWeek);
  const getPayoutsCache     = useAppCache((s) => s.getPayouts);
  const setPayoutsCache     = useAppCache((s) => s.setPayouts);
  const payoutsData         = useAppCache((s) => s.payouts?.data ?? null);

  // Subscribe to currentWeek for reactivity (refetch when week/status changes)
  const currentWeek = useAppCache((s) => s.currentWeek?.data ?? null);

  // Derived reactively from Zustand so it's correct even when YTD comes from cache
  const paidCount = useMemo(
    () => payoutsData?.filter(p => p.points > 0).length ?? 0,
    [payoutsData],
  );

  const [rows, setRows]   = useState<YtdRow[]>([]);
  const [weeks, setWeeks] = useState<number[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setLoading(true);

        // 1) Check cache first
        const cached = getYtdCache();
        
        // 2) Get or fetch current week
        let current = currentWeek;
        if (!current) {
          current = await getCurrentWeek();
          if (!cancelled) setCurrentWeekCache(current);
        }
        
        // 3) If cache exists and current week hasn't changed, use cache
        //    Cache is invalidated by setCurrentWeek when week/status changes
        if (cached && !cancelled) {
          setRows(cached.rows as YtdRow[]);
          setWeeks(cached.weeks);
          setLoading(false);
          return;
        }

        // 4) Fetch payouts (for return and paid-place calculations)
        let payoutRows: PayoutRow[] = getPayoutsCache() ?? [];
        if (payoutRows.length === 0) {
          try {
            payoutRows = await getPayouts();
            setPayoutsCache(payoutRows);
          } catch { /* non-fatal — returns will show as 0 */ }
        }
        const payoutsMap = new Map(payoutRows.map(p => [p.place, p.points]));
        const paid = payoutRows.filter(p => p.points > 0).length;

        // 5) Fetch all leaderboards and filter out live week (unless final)
        const weekly: LeaderboardRow[] = await getResultsAllLeaderboards();
        const filtered = current.status === "final" ? weekly : weekly.filter(w => w.week_number !== current.week);

        // 6) Weeks list
        const weeksList = Array.from(new Set(filtered.map(w => w.week_number))).sort((a, b) => a - b);

        // 7) Group by pigeon
        const byPigeon = new Map<number, YtdRow>();
        for (const w of filtered) {
          let r = byPigeon.get(w.pigeon_number);
          if (!r) {
            r = {
              pigeon_number: w.pigeon_number,
              pigeon_name: w.pigeon_name,
              byWeek: {},
              pointsAdj: 0,
              top5: 0,
              returnTotal: 0,
              yearRankPts: Number.POSITIVE_INFINITY,
              yearRankRet: Number.POSITIVE_INFINITY,
            };
            byPigeon.set(w.pigeon_number, r);
          }
          r.byWeek[w.week_number] = { rank: w.rank, score: w.score, points: w.points };
        }

        // 8) Tie counts for payouts
        const tieCounts = new Map<number, Map<number, number>>();
        for (const wk of weeksList) {
          const m = new Map<number, number>();
          const rowsThisWeek = filtered.filter(x => x.week_number === wk);
          for (const r of rowsThisWeek) m.set(r.rank, (m.get(r.rank) ?? 0) + 1);
          tieCounts.set(wk, m);
        }

        const payoutFor = (rank: number, tieCount: number) => {
          let pool = 0;
          for (let pos = rank; pos < rank + tieCount; pos++) {
            pool += payoutsMap.get(pos) ?? 0;
          }
          return tieCount > 0 ? pool / tieCount : 0;
        };

        // 9) Aggregates
        for (const r of byPigeon.values()) {
          const cells = Object.values(r.byWeek);
          const numWeeks = cells.length;

          const totalPts = cells.reduce((s, w) => s + w.points, 0);
          const worst    = numWeeks >= 2 ? Math.max(...cells.map(w => w.points)) : 0;
          r.pointsAdj    = totalPts - worst;

          r.top5 = cells.reduce((s, w) => s + (w.rank <= paid ? 1 : 0), 0);

          let ret = 0;
          for (const [wkStr, cell] of Object.entries(r.byWeek)) {
            const wk = Number(wkStr);
            const tie = tieCounts.get(wk)?.get(cell.rank) ?? 1;
            ret += payoutFor(cell.rank, tie);
          }
          r.returnTotal = ret;
        }

        // 10) Ranks
        {
          const arr = [...byPigeon.values()].sort((a, b) => a.pointsAdj - b.pointsAdj || a.pigeon_number - b.pigeon_number);
          let shown = 0, curr = 0, prev: number | null = null;
          for (const row of arr) {
            shown++;
            if (prev === null || row.pointsAdj !== prev) { curr = shown; prev = row.pointsAdj; }
            row.yearRankPts = curr;
          }
        }
        {
          const arr = [...byPigeon.values()].sort((a, b) => b.returnTotal - a.returnTotal || a.pigeon_number - b.pigeon_number);
          let shown = 0, curr = 0, prev: number | null = null;
          for (const row of arr) {
            shown++;
            if (prev === null || row.returnTotal !== prev) { curr = shown; prev = row.returnTotal; }
            row.yearRankRet = curr;
          }
        }

        const out = { rows: [...byPigeon.values()], weeks: weeksList };

        if (!cancelled) {
          setRows(out.rows);
          setWeeks(out.weeks);
          setYtdCache(out); // ✅ single cached YTD item
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e ?? ""));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [getYtdCache, setYtdCache, setCurrentWeekCache, getPayoutsCache, setPayoutsCache, currentWeek]);

  return { rows, weeks, paidCount, loading, error };
}
