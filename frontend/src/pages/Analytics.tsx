import { useState, useEffect } from "react";
import { Box, Stack, Typography, Tabs, Tab, FormControl, InputLabel, Select, MenuItem } from "@mui/material";

import { useAuth } from "../auth/useAuth";
import { useSchedule } from "../hooks/useSchedule";
import KeyPicks from "./analytics/KeyPicks";
import RemainingGames from "./analytics/RemainingGames";
import MnfOutcomes from "./analytics/MnfOutcomes";
import type { Me } from "../backend/types";

function getPigeonOptions(me: Me | undefined): { pigeon_number: number; pigeon_name: string }[] {
	if (!me) return [];
	// User's own pigeon first, then alternates
	return [
		{ pigeon_number: me.pigeon_number, pigeon_name: me.pigeon_name },
		...(me.alternates || [])
	];
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

	// Pigeon options for selector
	const pigeonOptions = getPigeonOptions(me);

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
						{pigeonOptions.map(p => (
							<MenuItem key={p.pigeon_number} value={p.pigeon_number}>
								{`${p.pigeon_number} ${p.pigeon_name}`}
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
