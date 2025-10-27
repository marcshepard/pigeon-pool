import { useState, useEffect, useMemo } from "react";
import { Box, Stack, Typography, Tabs, Tab, FormControl, InputLabel, Select, MenuItem, ListSubheader, Divider } from "@mui/material";

import { useAuth } from "../auth/useAuth";
import { useSchedule } from "../hooks/useSchedule";
import RemainingGames from "./analytics/YourPicks";
import MnfOutcomes from "./analytics/MnfOutcomes";
import type { GameMeta } from "../hooks/useAppCache";
import Top5Playground from "./analytics/Top5Playground";
 
import { useResults } from "../hooks/useResults";

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
	const { lockedWeeks, currentWeek } = useSchedule();
	// Default week: current if available, else last locked
	const [week, setWeek] = useState<number | "">("");
	useEffect(() => {
		if (week === "" && (currentWeek?.week || lockedWeeks.length)) {
			setWeek(currentWeek?.week || lockedWeeks[lockedWeeks.length - 1]);
		}
	}, [week, currentWeek, lockedWeeks]);

	// Default pigeon: self
	const [pigeon, setPigeon] = useState<number | "">("");
	useEffect(() => {
		if (me && pigeon === "") setPigeon(me.pigeon_number);
	}, [me, pigeon]);

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

	// Results for the selected week (to discover all pigeons + names)
	const { rows, games, refreshResults, lastFetched } = useResults(week === "" ? null : Number(week));
	// Determine if any game is in progress (kickoff passed, not final)
	const now = Date.now();
	const gamesInProgress = useMemo(() =>
		games.some(g => {
			const kickoff = new Date(g.kickoff_at).getTime();
			return kickoff <= now && g.status !== "final";
		}),
		[games, now]
	);

	// Auto-refresh on tab focus if data is stale and games are in progress
	const interval = Number(import.meta.env.VITE_AUTO_REFRESH_INTERVAL_MINUTES);
	useEffect(() => {
		function handleVisibilityRefresh() {
			if (document.visibilityState === "visible" && gamesInProgress && lastFetched != null) {
				const age = Date.now() - lastFetched;
				if (age > interval * 60 * 1000) {
					refreshResults();
				}
			}
		}
		document.addEventListener("visibilitychange", handleVisibilityRefresh);
		handleVisibilityRefresh();
		return () => {
			document.removeEventListener("visibilitychange", handleVisibilityRefresh);
		};
	}, [gamesInProgress, lastFetched, interval, refreshResults]);

	// Build selector sections: Me, Managed, Others
	const { meOpt, managedOpts, otherOpts } = useMemo(() => {
		const empty = { meOpt: null as null | { pigeon_number: number; pigeon_name?: string }, managedOpts: [] as { pigeon_number: number; pigeon_name?: string }[], otherOpts: [] as { pigeon_number: number; pigeon_name?: string }[] };
		if (!me) return empty;
		const meId = me.pigeon_number;
		const managed = (me.alternates || []).map(a => ({ pigeon_number: a.pigeon_number, pigeon_name: a.pigeon_name }));

		// All pigeons from results rows (names available here)
		const all = uniqBy(
			rows.map(r => ({ pigeon_number: r.pigeon_number, pigeon_name: r.pigeon_name })),
			x => x.pigeon_number
		);

		const managedIds = new Set(managed.map(m => m.pigeon_number));

		const othersRaw = all.filter(p => p.pigeon_number !== meId && !managedIds.has(p.pigeon_number));
		// If rows is empty (week not loaded), we may have no others; fall back to empty

		// Sort others by name if present, then by number
		const otherOpts = [...othersRaw].sort((a, b) => a.pigeon_number - b.pigeon_number);

		return {
			meOpt: { pigeon_number: meId, pigeon_name: me.pigeon_name },
			managedOpts: managed,
			otherOpts,
		};
	}, [me, rows]);

	// Helper: check if all Sunday games are completed (status === 'final')
		const weekGames = games;

		const allSundayFinal = useMemo(() => {
			console.log("Checking allSundayFinal for weekGames:", weekGames);
			if (!weekGames.length) return false;
			// Sunday = 0
			weekGames.forEach((g: GameMeta) => {
				if (!g.kickoff_at) {
					console.log("Game missing kickoff_at:", g);
					return;
				}
				const d = new Date(g.kickoff_at);
				const day = d.getDay();
				console.log(`Game:`, g, `Status: ${g.status}`, `getDay: ${day}`);
			});
			return weekGames.filter((g: GameMeta) => {
				if (!g.kickoff_at) return false;
				const d = new Date(g.kickoff_at);
				return d.getDay() === 0;
			}).every((g: GameMeta) => g.status === 'final');
		}, [weekGames]);

	return (
		<Box sx={{ maxWidth: 900, mx: "auto", mt: 3 }}>
			{/* Header: Week selector, Analytics, Pigeon selector */}
			<Stack direction="row" alignItems="center" spacing={2} justifyContent="center" sx={{ mb: 2 }}>
				{/* Week selector */}
				<FormControl size="small" sx={{ minWidth: 100 }}>
					<InputLabel id="week-label">Week</InputLabel>
					<Select
						labelId="week-label"
						value={week}
						label="Week"
						onChange={e => setWeek(Number(e.target.value))}
					>
						{lockedWeeks.map(w => (
							<MenuItem key={w} value={w}>Week {w}</MenuItem>
						))}
					</Select>
				</FormControl>
				<Typography variant="h5" sx={{ flex: 1, textAlign: "center" }}>Analytics</Typography>
				{/* Pigeon selector */}
				<FormControl size="small" sx={{ minWidth: 140 }}>
					<InputLabel id="pigeon-label">Pigeon</InputLabel>
					<Select
						labelId="pigeon-label"
						value={pigeon}
						label="Pigeon"
						onChange={e => setPigeon(Number(e.target.value))}
					>
						{meOpt && (
							<MenuItem key={meOpt.pigeon_number} value={meOpt.pigeon_number}>
								{`${meOpt.pigeon_number} ${meOpt.pigeon_name ?? ""}`.trim()}
							</MenuItem>
						)}

						{managedOpts.length > 0 && (
							<ListSubheader>Managed</ListSubheader>
						)}
						{managedOpts.map(p => (
							<MenuItem key={p.pigeon_number} value={p.pigeon_number}>
								{`${p.pigeon_number} ${p.pigeon_name ?? ""}`.trim()}
							</MenuItem>
						))}

						{otherOpts.length > 0 && (
							<Divider sx={{ my: 0.5 }} />
						)}
						{otherOpts.map(p => (
							<MenuItem key={p.pigeon_number} value={p.pigeon_number}>
								{p.pigeon_name ? `${p.pigeon_number} ${p.pigeon_name}` : String(p.pigeon_number)}
							</MenuItem>
						))}
					</Select>
				</FormControl>
			</Stack>

			{/* Tabs */}
			<Tabs value={tab} onChange={(_, v) => setTab(v)} centered sx={{ mb: 2 }}>
				<Tab label="Your Picks" />
				<Tab label="Top 5" />
			</Tabs>

			{/* Tab panels */}
			<Box>
				{tab === 0 && week && pigeon && (
					<RemainingGames week={Number(week)} pigeon={Number(pigeon)} />
				)}
				{tab === 1 && week && (
					allSundayFinal ? <MnfOutcomes week={Number(week)} /> : <Top5Playground pigeon={Number(pigeon)} />
				)}
			</Box>
		</Box>
	);
}
