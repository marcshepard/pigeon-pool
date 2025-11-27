/**
 * Shared utility for shaping results data.
 * Used by both useResults and useAutoRefreshManager.
 */

import { LeaderboardRow, WeekPicksRow } from "../backend/types";
import type { GameMeta } from "../hooks/useAppCache";

export type PickCell = { 
  signed: number; 
  label: string; 
  home_abbr: string; 
  away_abbr: string; 
  score?: number; // The calculated score for this game (if finished)
};

export type ResultsRow = {
  pigeon_number: number;
  pigeon_name: string;
  picks: Record<string, PickCell>;
  points: number | null;
  rank: number | null;
};

export function scoreForPick(predSigned: number, actualSigned: number): number {
  const pickedHome = predSigned >= 0;
  const winnerHome = actualSigned > 0;
  const diff = Math.abs(predSigned - actualSigned);
  const wrongWinner = actualSigned === 0 || pickedHome !== winnerHome;
  return diff + (wrongWinner ? 7 : 0);
}

export function shapeRowsAndGames(picks: WeekPicksRow[], lb: LeaderboardRow[]) {
  const games: GameMeta[] = [
    ...new Map(
      picks.map((p) => [
        p.game_id,
        {
          game_id: p.game_id,
          home_abbr: p.home_abbr,
          away_abbr: p.away_abbr,
          status: p.status,
          home_score: p.home_score ?? null,
          away_score: p.away_score ?? null,
          kickoff_at: p.kickoff_at,
        } satisfies GameMeta,
      ])
    ).values(),
  ];

  const lbByPigeon = new Map(lb.map((r) => [r.pigeon_number, r]));
  const byPigeon = new Map<number, ResultsRow>();

  for (const p of picks) {
    const key = `g_${p.game_id}`;
    const signed = p.picked_home ? +p.predicted_margin : -p.predicted_margin;
    const team = p.picked_home ? p.home_abbr : p.away_abbr;
    let label = p.predicted_margin === 0 ? "" : `${team} ${p.predicted_margin}`;
    let gameScore: number | undefined = undefined;

    if (label && p.home_score != null && p.away_score != null) {
      if (p.status === "final" || p.status === "in_progress") {
        const actualSigned = p.home_score - p.away_score;
        const sc = scoreForPick(signed, actualSigned);
        label = `${label} (${sc})`;
        gameScore = sc;
      }
    }

    let row = byPigeon.get(p.pigeon_number);
    if (!row) {
      const lbr = lbByPigeon.get(p.pigeon_number);
      row = {
        pigeon_number: p.pigeon_number,
        pigeon_name: p.pigeon_name,
        picks: {},
        points: null, // Will be calculated below
        rank: lbr?.rank ?? null,
      };
      byPigeon.set(p.pigeon_number, row);
    }
    row.picks[key] = { signed, label, home_abbr: p.home_abbr, away_abbr: p.away_abbr, score: gameScore };
  }

  // Calculate aggregate points for each row by summing game scores
  for (const row of byPigeon.values()) {
    let total = 0;
    let hasScores = false;
    for (const pick of Object.values(row.picks)) {
      if (pick.score !== undefined) {
        total += pick.score;
        hasScores = true;
      }
    }
    row.points = hasScores ? total : null;
  }

  return { rows: [...byPigeon.values()], games };
}
