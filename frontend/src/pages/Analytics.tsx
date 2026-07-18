/**
 * Analytics.tsx - Analytics page with tabs for Your Picks and Top 5 Playground.
 */

import { useState, useEffect, useMemo } from "react";
import { Stack, Typography, Tabs, Tab } from "@mui/material";
import { LabeledSelect } from "../components/CommonComponents";

import { useAuth } from "../auth/useAuth";
import { useSchedule } from "../hooks/useSchedule";
import RemainingGames from "./analytics/YourPicks";
import MnfOutcomes from "./analytics/MnfOutcomes";
import { useAppCache, type GameMeta } from "../hooks/useAppCache";
import Top5Playground from "./analytics/Top5Playground";
import { useResults } from "../hooks/useResults";
import { getPayouts } from "../backend/fetch";

import { PageFit, NORMAL_PAGE_MAX_WIDTH } from "../components/Layout";

function uniqBy<T, K>(arr: T[], keyFn: (t: T) => K): T[] {
  const seen = new Set<K>();
  const out: T[] = [];
  for (const it of arr) {
    const k = keyFn(it);
    if (!seen.has(k)) { seen.add(k); out.push(it); }
  }
  return out;
}

export default function AnalyticsPage() {
  const { me } = useAuth();
  const { lockedWeeks, currentWeek, loading: scheduleLoading } = useSchedule();

  // True once we know for certain no week has locked yet this season
  const noDataYet = !scheduleLoading && lockedWeeks.length === 0;

  // Default week: most recently locked week (currentWeek.week is only meaningful once any_locked)
  const [week, setWeek] = useState<number | "">("");
  useEffect(() => {
    if (week === "" && currentWeek?.any_locked) {
      setWeek(currentWeek.week);
    }
  }, [week, currentWeek]);

  // Default pigeon: self
  const [pigeon, setPigeon] = useState<number | "">("");
  useEffect(() => {
    if (me && pigeon === "") setPigeon(me.pigeon_number);
  }, [me, pigeon]);

  // Number of paid places, driven by tenant_payouts (falls back to 5 while loading)
  const cacheGetPayouts = useAppCache((s) => s.getPayouts);
  const cacheSetPayouts = useAppCache((s) => s.setPayouts);
  const payouts = useAppCache((s) => s.payouts?.data ?? null);
  useEffect(() => {
    if (cacheGetPayouts()) return;
    getPayouts().then((data) => cacheSetPayouts(data)).catch(() => {/* non-fatal */});
  }, [cacheGetPayouts, cacheSetPayouts]);
  const paidCount = useMemo(
    () => payouts ? payouts.filter(p => p.points > 0).length : 5,
    [payouts]
  );

  // Tab state, persisted in query string
  function getTabFromQuery() {
    const params = new URLSearchParams(window.location.search);
    const t = params.get('tab');
    const idx = t !== null ? Number(t) : 0;
    return isNaN(idx) ? 0 : idx;
  }
  const [tab, setTab] = useState(getTabFromQuery());
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    params.set('tab', String(tab));
    window.history.replaceState(null, '', `${window.location.pathname}?${params.toString()}`);
  }, [tab]);

  const { rows, games } = useResults(week === "" ? null : Number(week));

  // Build selector sections: Me, Managed, Others
  const { meOpt, managedOpts, otherOpts } = useMemo(() => {
    const empty = { 
      meOpt: null as null | { pigeon_number: number; pigeon_name?: string }, 
      managedOpts: [] as { pigeon_number: number; pigeon_name?: string }[], 
      otherOpts: [] as { pigeon_number: number; pigeon_name?: string }[] 
    };
    if (!me) return empty;
    
    const meId = me.pigeon_number;
    const managed = (me.alternates || []).map(a => ({ 
      pigeon_number: a.pigeon_number, 
      pigeon_name: a.pigeon_name 
    }));

    // All pigeons from results rows (names available here)
    const all = uniqBy(
      rows.map(r => ({ pigeon_number: r.pigeon_number, pigeon_name: r.pigeon_name })),
      x => x.pigeon_number
    );

    const managedIds = new Set(managed.map(m => m.pigeon_number));
    const othersRaw = all.filter(p => p.pigeon_number !== meId && !managedIds.has(p.pigeon_number));
    
    // Sort others by number
    const otherOpts = [...othersRaw].sort((a, b) => a.pigeon_number - b.pigeon_number);

    return {
      meOpt: { pigeon_number: meId, pigeon_name: me.pigeon_name },
      managedOpts: managed,
      otherOpts,
    };
  }, [me, rows]);

  // Helper: check if all Sunday games are completed (status === 'final')
  const allSundayFinal = useMemo(() => {
    if (!games.length) return false;
    
    const sundayGames = games.filter((g: GameMeta) => {
      if (!g.kickoff_at) return false;
      const d = new Date(g.kickoff_at);
      return d.getDay() === 0; // Sunday = 0
    });
    
    return sundayGames.length > 0 && sundayGames.every((g: GameMeta) => g.status === 'final');
  }, [games]);

  return (
    <PageFit maxWidth={NORMAL_PAGE_MAX_WIDTH}>
      {/* Header: Week selector, Analytics, Pigeon selector */}
      <Stack direction="row" alignItems="center" spacing={2} justifyContent="center" sx={{ my: 1 }}>
        {/* Week selector using LabeledSelect */}
        <LabeledSelect
          label="Week"
          value={week === "" ? "" : String(week)}
          onChange={e => setWeek(Number(e.target.value))}
          options={lockedWeeks.map(w => ({ value: String(w), label: `Week ${w}` }))}
          id="week-select"
          labelId="week-label"
          size="small"
          sx={{ minWidth: 90 }}
        />
        
        <Typography variant="h6" fontWeight="bold" sx={{ flex: 1, textAlign: "center" }}>
          Analytics
        </Typography>
        
        {/* Pigeon selector using LabeledSelect */}
        <LabeledSelect
          label="Pigeon"
          value={pigeon === "" ? "" : String(pigeon)}
          onChange={e => setPigeon(Number(e.target.value))}
          options={[
            ...(meOpt ? [{ value: String(meOpt.pigeon_number), label: `${meOpt.pigeon_number} ${meOpt.pigeon_name ?? ""}`.trim() }] : []),
            ...(managedOpts.length > 0 ? [{ value: "", label: "--- Managed ---", isHeader: true }] : []),
            ...managedOpts.map(p => ({ value: String(p.pigeon_number), label: `${p.pigeon_number} ${p.pigeon_name ?? ""}`.trim() })),
            ...(otherOpts.length > 0 ? [{ value: "", label: "--- Others ---", isHeader: true }] : []),
            ...otherOpts.map(p => ({ value: String(p.pigeon_number), label: p.pigeon_name ? `${p.pigeon_number} ${p.pigeon_name}` : String(p.pigeon_number) })),
          ].filter(opt => !opt.isHeader)}
          id="pigeon-select"
          labelId="pigeon-label"
          size="small"
          sx={{ minWidth: 140 }}
        />
      </Stack>

      {/* Tabs */}
      <Tabs value={tab} onChange={(_, v) => setTab(v)} centered sx={{ mb: 2 }}>
        <Tab label="Your Picks" />
        <Tab label={`Top ${paidCount}`} />
      </Tabs>

      {/* Tab panels */}
      <PageFit.ScrollArea>
        {noDataYet ? (
          <Stack alignItems="center" sx={{ mt: 4, textAlign: "center" }} spacing={1}>
            <Typography variant="body2" color="text.secondary">
              Come back after the Week 1 submission deadline to see your picks and analytics.
            </Typography>
          </Stack>
        ) : (
          <>
            {tab === 0 && week && pigeon && (
              <RemainingGames week={Number(week)} pigeon={Number(pigeon)} />
            )}
            {tab === 1 && week && pigeon && (
              allSundayFinal ? (
                <MnfOutcomes pigeon={Number(pigeon)} week={Number(week)} paidCount={paidCount} />
              ) : (
                <Top5Playground pigeon={Number(pigeon)} week={Number(week)} paidCount={paidCount} />
              )
            )}
          </>
        )}
      </PageFit.ScrollArea>
    </PageFit>
  );
}