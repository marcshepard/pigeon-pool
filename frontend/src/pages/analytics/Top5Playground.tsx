import { useAuth } from '../../auth/useAuth';
import { useState, useMemo } from 'react';
import { scoreForPick } from '../../hooks/useResults';
import { Box, Typography, Button, Paper, Select, MenuItem, FormControl, InputLabel } from '@mui/material';
import { useSchedule } from '../../hooks/useSchedule';
import { useResults } from '../../hooks/useResults';





type EnteredScore = { team: string; margin: number };

export default function Top5Playground() {
  const [enteredScores, setEnteredScores] = useState<Record<number, EnteredScore>>({});
  const { currentWeek } = useSchedule();
  const week = currentWeek?.week ?? null;
  const { rows, games } = useResults(week);
  const { me } = useAuth();

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
  // Consensus: best-ranked player's pick (remove appended score)
  let consensus = rows.length > 0 ? (rows.find(r => r.rank === 1)?.picks[key]?.label || '') : '';
  consensus = consensus.replace(/ \(\d+\)$/, '');
  // Your Pick: current user's pick (remove appended score)
  let yourPick = me ? (rows.find(r => r.pigeon_number === me.pigeon_number)?.picks[key]?.label || '') : '';
  yourPick = yourPick.replace(/ \(\d+\)$/, '');
      // Current score
      let currentScore = '';
      if (g.home_score != null && g.away_score != null) {
        const signed = g.home_score - g.away_score;
        if (signed === 0) currentScore = 'TIE 0';
        else currentScore = `${signed > 0 ? g.home_abbr : g.away_abbr} ${Math.abs(signed)}`;
      }
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
  }, [games, rows, me]);

  // Recalculate Top 5 scores using entered picks for remaining games
  const recalculatedTop5 = useMemo(() => {
    if (!top5Players.length) return [];
    // Helper: get signed margin for a pick
    function getSignedMargin(team: string, margin: number, home: string) {
      if (!team || margin == null) return null;
      return team === home ? margin : -margin;
    }
    // Only consider games that are final (have scores)
    const finalGames = games.filter(g => g.status === 'final' && g.home_score != null && g.away_score != null);
    // For each player, recalculate their score
    const recalculated = top5Players.map(player => {
      let totalScore = 0;
      for (const game of finalGames) {
        const key = `g_${game.game_id}`;
        // If user entered a pick for this game, override
        const entered = enteredScores[game.game_id];
        let predSigned: number | null = null;
        if (entered && entered.team && entered.margin != null) {
          predSigned = getSignedMargin(entered.team, entered.margin, game.home_abbr);
        } else {
          // Use player's actual pick
          const pick = player.picks[key];
          predSigned = pick ? pick.signed : null;
        }
        // Only score if a pick exists and scores are present
        if (predSigned != null && game.home_score != null && game.away_score != null) {
          const actualSigned = game.home_score - game.away_score;
          totalScore += scoreForPick(predSigned, actualSigned);
        }
      }
      return { ...player, points: totalScore };
    });
    // Sort by score ascending (lower is better), then rank
    const sorted = [...recalculated].sort((a, b) => (a.points ?? 9999) - (b.points ?? 9999) || (a.rank ?? 99) - (b.rank ?? 99));
    // Assign new ranks
    sorted.forEach((p, idx) => { p.rank = idx + 1; });
    return sorted;
  }, [enteredScores, top5Players, games]);

  const handleScoreChange = (gameId: number, team: string, margin: number) => {
    setEnteredScores(prev => ({ ...prev, [gameId]: { team, margin } }));
  };

  const handleReset = () => setEnteredScores({});

  return (
    <Box sx={{ maxWidth: 800, mx: 'auto', mt: 4 }}>
      <Box sx={{ mt: 4 }}>
        <Typography variant="body1" align="center">
          Enter scores to see the effect on the top 5 rankings
        </Typography>
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
                  <td style={{ padding: '8px', borderTop: '1px solid #eee' }}>{player.rank}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Paper>
      </Box>

      <Box sx={{ mt: 4 }}>
        <Typography variant="h6" gutterBottom>Remaining Games</Typography>
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
