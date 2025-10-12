/**
 * Shared cache store with TTL and sweep.
 */


import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { LeaderboardRow, WeekPicksRow, ScheduleCurrent } from "../backend/types";

export type GameMeta = { game_id: number; home_abbr: string; away_abbr: string };

type TimeStamped<T> = { at: number; data: T };

export type ResultsWeekCache = {
  picks: WeekPicksRow[];       // raw API rows
  lb: LeaderboardRow[];        // raw API rows
  games: GameMeta[];           // derived once from picks
  rows?: unknown[];            // optional: shaped rows cached for snappy navigation
};

export type YtdCache = {
  // Keep this generic for now; hooks can shape/validate.
  rows: unknown[];
  weeks: number[];
};

type AppCacheState = {
  // config
  ttlMs: number;
  sweepEveryMs: number;
  _lastSweepAt: number;

  // caches
  schedule: TimeStamped<ScheduleCurrent> | null;
  resultsByWeek: Record<number, TimeStamped<ResultsWeekCache> | undefined>;
  ytd: TimeStamped<YtdCache> | null;

  // actions
  setTTL: (ms: number) => void;

  setSchedule: (s: ScheduleCurrent) => void;
  getSchedule: () => ScheduleCurrent | null;

  setResultsWeek: (week: number, payload: ResultsWeekCache) => void;
  getResultsWeek: (week: number) => ResultsWeekCache | null;

  setYtd: (payload: YtdCache) => void;
  getYtd: () => YtdCache | null;

  invalidateAll: () => void;
  sweep: () => void;
};

export const useAppCache = create<AppCacheState>()(
  persist(
    (set, get) => ({
      ttlMs: 60 * 60 * 1000,        // 1 hour
      sweepEveryMs: 5 * 60 * 1000,  // sweep at most every 5 min
      _lastSweepAt: 0,

      schedule: null,
      resultsByWeek: {},
      ytd: null,

      setTTL: (ms) => set({ ttlMs: ms }),

      setSchedule: (s) => {
        const now = Date.now();
        const prev = get().schedule?.data;
        const changed =
          !prev ||
          prev.live_week !== s.live_week ||
          prev.next_picks_week !== s.next_picks_week;

        if (changed) {
          set({
            schedule: { at: now, data: s },
            resultsByWeek: {},
            ytd: null,
          });
        } else {
          set({ schedule: { at: now, data: s } });
        }
      },

      getSchedule: () => {
        const entry = get().schedule;
        if (!entry) return null;
        return Date.now() - entry.at > get().ttlMs ? null : entry.data;
      },

      setResultsWeek: (week, payload) => {
        const now = Date.now();
        set((state) => ({
          resultsByWeek: {
            ...state.resultsByWeek,
            [week]: { at: now, data: payload },
          },
        }));
        get().sweep();
      },

      getResultsWeek: (week) => {
        const entry = get().resultsByWeek[week];
        if (!entry) return null;
        return Date.now() - entry.at > get().ttlMs ? null : entry.data;
      },

      setYtd: (payload) => {
        const now = Date.now();
        set({ ytd: { at: now, data: payload } });
        get().sweep();
      },

      getYtd: () => {
        const entry = get().ytd;
        if (!entry) return null;
        return Date.now() - entry.at > get().ttlMs ? null : entry.data;
      },

      invalidateAll: () => set({ resultsByWeek: {}, ytd: null }),

      sweep: () => {
        const now = Date.now();
        const { _lastSweepAt, sweepEveryMs, ttlMs } = get();
        if (now - _lastSweepAt < sweepEveryMs) return;

        const freshWeeks: AppCacheState["resultsByWeek"] = {};
        for (const [k, v] of Object.entries(get().resultsByWeek)) {
          if (v && now - v.at <= ttlMs) freshWeeks[Number(k)] = v;
        }
        const ytd = get().ytd;
        set({
          resultsByWeek: freshWeeks,
          ytd: ytd && now - ytd.at <= ttlMs ? ytd : null,
          _lastSweepAt: now,
        });
      },
    }),
    {
      name: "pp:appcache",
      storage: createJSONStorage(() => sessionStorage), // or localStorage
      version: 1,
    }
  )
);

