/**
 * Top 5 Playground - let the user enter scores for remaining games to see effect on top 5
 */

import { useState, useMemo } from 'react';
import { scoreForPick } from '../../hooks/useResults';
import { Box, Typography, Button, Paper, Select, MenuItem, FormControl, InputLabel } from '@mui/material';
import { useSchedule } from '../../hooks/useSchedule';
import { useResults } from '../../hooks/useResults';

type EnteredScore = { team: string; margin: number };
import type { PickCell } from '../../hooks/useResults';
type Player = {
  points: number;
  pigeon_number: number;
  pigeon_name: string;
  picks: Record<string, PickCell>;
  rank: number;
  tie?: boolean;
};

export default function Top5Playground({ pigeon }: { pigeon: number }) {
  const [enteredScores, setEnteredScores] = useState<Record<number, EnteredScore>>({});
  const { currentWeek } = useSchedule();
  const week = currentWeek?.week ?? null;
  const { rows, games, consensusRow } = useResults(week);

  // Top 5 players by score/rank
  const top5Players = useMemo(() => {
    if (!rows.length) return [];
    // Sort by rank, then score descending
    return [...rows]
      .filter(r => typeof r.rank === 'number')
      .sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99) || (b.points ?? 0) - (a.points ?? 0))
      .slice(0, 5);
  }, [rows]);

  // Remaining games (not final)
  const remainingGames = useMemo(() => {
    return games.filter(g => g.status !== 'final').map(g => {
      const key = `g_${g.game_id}`;
      // Consensus: use consensusRow, show to 1 decimal place
      let consensus = '';
      if (consensusRow && consensusRow.picks[key]) {
        consensus = consensusRow.picks[key].label || '';
      }
      // Your Pick: selected pigeon's pick (remove appended score)
      let yourPick = pigeon ? (rows.find(r => r.pigeon_number === pigeon)?.picks[key]?.label || '') : '';
      yourPick = yourPick.replace(/ \(\d+\)$/, '');
      // Current score
      let currentScore = '';
      if (g.status === 'in_progress' && g.home_score != null && g.away_score != null) {
        const signed = g.home_score - g.away_score;
        if (signed === 0) currentScore = 'TIE';
        else currentScore = `${signed > 0 ? g.home_abbr : g.away_abbr} ${Math.abs(signed)}`;
      } else if (g.status === 'final' && g.home_score != null && g.away_score != null) {
        const signed = g.home_score - g.away_score;
        if (signed === 0) currentScore = 'TIE';
        else currentScore = `${signed > 0 ? g.home_abbr : g.away_abbr} ${Math.abs(signed)}`;
      } // scheduled games: leave blank
      // Teams for entry
      const teams = [g.home_abbr, g.away_abbr];
      return {
        id: g.game_id,
        game: `${g.away_abbr} @ ${g.home_abbr}`,
        consensus,
        yourPick,
        currentScore,
        teams,
      };
    });
  }, [games, rows, pigeon, consensusRow]);

  // Recalculate Top 5 scores using entered picks for all non-final games
  const recalculatedTop5 = useMemo(() => {
    if (!top5Players.length) return [];
    function getSignedMargin(team: string, margin: number, home: string) {
      if (!team || margin == null) return null;
      return team === home ? margin : -margin;
    }
    // Use all games with scores (final or entered)
    const relevantGames = games.filter(g => (g.status === 'final' && g.home_score != null && g.away_score != null) || enteredScores[g.game_id]);
    const recalculated: Player[] = top5Players.map(player => {
      let totalScore = 0;
      for (const game of relevantGames) {
        const key = `g_${game.game_id}`;
        let actualSigned: number | null = null;
        if (enteredScores[game.game_id] && enteredScores[game.game_id].team && enteredScores[game.game_id].margin != null) {
          // Use entered score for actual result
          actualSigned = getSignedMargin(enteredScores[game.game_id].team, enteredScores[game.game_id].margin, game.home_abbr);
        } else if (game.home_score != null && game.away_score != null) {
          actualSigned = game.home_score - game.away_score;
        }
        // Use player's pick for this game
        const pick = player.picks[key];
        const predSigned = pick ? pick.signed : null;
        if (predSigned != null && actualSigned != null) {
          totalScore += scoreForPick(predSigned, actualSigned);
        }
      }
      return {
        ...player,
        points: totalScore,
        rank: 0,
        tie: false,
      };
    });
    // Sort by score ascending (lower is better), then rank
    const sorted = [...recalculated].sort((a, b) => (a.points ?? 9999) - (b.points ?? 9999) || (a.rank ?? 99) - (b.rank ?? 99));
    // Assign ranks with ties
    let lastScore: number | undefined = undefined;
    let lastRank: number | undefined = undefined;
    sorted.forEach((p, idx) => {
      if (lastScore === p.points) {
        p.rank = lastRank ?? idx + 1;
      } else {
        p.rank = idx + 1;
        lastScore = p.points;
        lastRank = p.rank;
      }
    });
    // Mark ties
    sorted.forEach((p) => {
      p.tie = sorted.filter(x => x.points === p.points).length > 1;
    });
    return sorted;
  }, [enteredScores, top5Players, games]);

  const handleScoreChange = (gameId: number, team: string, margin: number) => {
    setEnteredScores(prev => ({ ...prev, [gameId]: { team, margin } }));
  };

  const handleReset = () => setEnteredScores({});

  return (
    <Box sx={{ maxWidth: 800, mx: 'auto', mt: 4 }}>
      <Box sx={{ mt: 4 }}>
        <Typography variant="body1" align="center" sx={{ mb: 1 }}>
          Enter scores to see the effect on the top 5 rankings
        </Typography>
        <Typography variant="body1" fontWeight={700} gutterBottom>Scores from completed games</Typography>
        <Paper sx={{ p: 2 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', padding: '8px' }}>Player</th>
                <th style={{ textAlign: 'left', padding: '8px' }}>Score</th>
                <th style={{ textAlign: 'left', padding: '8px' }}>Rank</th>
              </tr>
            </thead>
            <tbody>
              {recalculatedTop5.map((player) => (
                <tr key={player.pigeon_number}>
                  <td style={{ padding: '8px', borderTop: '1px solid #eee' }}>{player.pigeon_name}</td>
                  <td style={{ padding: '8px', borderTop: '1px solid #eee' }}>{player.points}</td>
                  <td style={{ padding: '8px', borderTop: '1px solid #eee' }}>{player.tie ? `T${player.rank}` : player.rank}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Paper>
      </Box>

      <Box sx={{ mt: 4 }}>
        <Typography variant="body1" fontWeight={700} gutterBottom>Remaining games</Typography>
        <Paper sx={{ p: 2 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left', padding: '8px' }}>Game</th>
                <th style={{ textAlign: 'left', padding: '8px' }}>Consensus</th>
                <th style={{ textAlign: 'left', padding: '8px' }}>Your Pick</th>
                <th style={{ textAlign: 'left', padding: '8px' }}>Current Score</th>
                <th style={{ textAlign: 'left', padding: '8px' }}>Enter Score</th>
              </tr>
            </thead>
            <tbody>
              {remainingGames.map((game) => (
                <tr key={game.id}>
                  <td style={{ padding: '8px', borderTop: '1px solid #eee' }}>{game.game}</td>
                  <td style={{ padding: '8px', borderTop: '1px solid #eee' }}>{game.consensus}</td>
                  <td style={{ padding: '8px', borderTop: '1px solid #eee' }}>{game.yourPick}</td>
                  <td style={{ padding: '8px', borderTop: '1px solid #eee' }}>{game.currentScore}</td>
                  <td style={{ padding: '8px', borderTop: '1px solid #eee' }}>
                    <FormControl fullWidth size="small">
                      <InputLabel>Team</InputLabel>
                      <Select
                        value={enteredScores[game.id]?.team || ''}
                        label="Team"
                        onChange={e => handleScoreChange(game.id, e.target.value as string, enteredScores[game.id]?.margin || 0)}
                      >
                        {game.teams.map(team => (
                          <MenuItem key={team} value={team}>{team}</MenuItem>
                        ))}
                      </Select>
                    </FormControl>
                    <FormControl fullWidth size="small" sx={{ mt: 1 }}>
                      <InputLabel>Margin</InputLabel>
                      <Select
                        value={enteredScores[game.id]?.margin ?? ''}
                        label="Margin"
                        onChange={e => handleScoreChange(game.id, enteredScores[game.id]?.team || '', Number(e.target.value))}
                      >
                        {[...Array(21).keys()].map(m => (
                          <MenuItem key={m} value={m}>{m}</MenuItem>
                        ))}
                      </Select>
                    </FormControl>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Paper>
        {Object.keys(enteredScores).length > 0 && (
          <Box sx={{ mt: 2, textAlign: 'right' }}>
            <Button variant="outlined" color="secondary" onClick={handleReset}>Reset</Button>
          </Box>
        )}
      </Box>
    </Box>
  );
}
