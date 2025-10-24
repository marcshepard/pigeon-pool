import { useState, useEffect, useMemo } from "react";
import { Box, Stack, Typography, Tabs, Tab, FormControl, InputLabel, Select, MenuItem, ListSubheader, Divider } from "@mui/material";

import { useAuth } from "../auth/useAuth";
import { useSchedule } from "../hooks/useSchedule";
import KeyPicks from "./analytics/KeyPicks";
import RemainingGames from "./analytics/RemainingGames";
import MnfOutcomes from "./analytics/MnfOutcomes";
 
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

	// Tab state
	const [tab, setTab] = useState(0);

	// Results for the selected week (to discover all pigeons + names)
	const { rows } = useResults(week === "" ? null : Number(week));

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
							<ListSubheader>Me</ListSubheader>
						)}
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
				<Tab label="Key Picks" />
				<Tab label="Remaining Games" />
				<Tab label="MNF" />
			</Tabs>

			{/* Tab panels */}
			<Box>
				{tab === 0 && week && pigeon && (
					<KeyPicks week={Number(week)} pigeon={Number(pigeon)} />
				)}
				{tab === 1 && week && pigeon && (
					<RemainingGames week={Number(week)} pigeon={Number(pigeon)} />
				)}
			{tab === 2 && week && <MnfOutcomes week={Number(week)} />}
			</Box>
		</Box>
	);
}
