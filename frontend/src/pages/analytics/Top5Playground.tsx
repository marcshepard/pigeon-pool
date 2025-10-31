/**
 * Top 5 Playground - let the user enter scores for remaining games to see effect on top 5
 */

import { useState, useMemo } from 'react';
import { Box, Typography, Button, Paper, Select, MenuItem, FormControl, InputLabel, Dialog, DialogContent, DialogActions } from '@mui/material';

import Top5Explainer from "./YourTop5Explainer";
import { useResults } from '../../hooks/useResults';
import { scoreForPick, type PickCell } from '../../utils/resultsShaping';

type EnteredScore = { team: string; margin: number };
type Player = {
  points: number;
  pigeon_number: number;
  pigeon_name: string;
  picks: Record<string, PickCell>;
  rank: number;
  tie?: boolean;
};

export default function Top5Playground({ pigeon, week }: { pigeon: number; week: number }) {
  const [enteredScores, setEnteredScores] = useState<Record<number, EnteredScore>>({});
  const { rows, games, consensusRow } = useResults(week);

  // Secret modal state
  const [explainerOpen, setExplainerOpen] = useState(false);

  // Secret modal for Top 5 explainer using MUI Dialog
  function SecretModal({ open, onClose, children }: { open: boolean; onClose: () => void; children: React.ReactNode }) {
    return (
      <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
        <DialogContent>
          {children}
        </DialogContent>
        <DialogActions sx={{ justifyContent: 'center', pb: 2 }}>
          <Button onClick={onClose} variant="contained" color="primary">Close</Button>
        </DialogActions>
      </Dialog>
    );
  }

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

  // Recalculate ALL player scores using entered picks for all non-final games
  const recalculatedPlayers = useMemo(() => {
    //console.log('=== Recalculation Debug ===');
    //console.log('rows:', rows);
    //console.log('enteredScores:', enteredScores);
    //console.log('games:', games);
    
    if (!rows.length) {
      console.log('No rows, returning empty array');
      return [];
    }
    
    function getSignedMargin(team: string, margin: number, home: string) {
      if (!team || margin == null) return null;
      return team === home ? margin : -margin;
    }
    // Use all games with scores (final or entered)
    const relevantGames = games.filter(g => (g.status === 'final' && g.home_score != null && g.away_score != null) || enteredScores[g.game_id]);
    //console.log('relevantGames:', relevantGames);
    
    const recalculated: Player[] = rows.map(player => {
      let totalScore = 0;
      //console.log(`\nProcessing player ${player.pigeon_number} ${player.pigeon_name}`);
      for (const game of relevantGames) {
        const key = `g_${game.game_id}`;
        let actualSigned: number | null = null;
        if (enteredScores[game.game_id] && enteredScores[game.game_id].team && enteredScores[game.game_id].margin != null) {
          // Use entered score for actual result
          actualSigned = getSignedMargin(enteredScores[game.game_id].team, enteredScores[game.game_id].margin, game.home_abbr);
          //console.log(`  Game ${game.game_id}: entered score actualSigned=${actualSigned}`);
        } else if (game.home_score != null && game.away_score != null) {
          actualSigned = game.home_score - game.away_score;
          //console.log(`  Game ${game.game_id}: actual score actualSigned=${actualSigned}`);
        }
        // Use player's pick for this game
        const pick = player.picks[key];
        const predSigned = pick ? pick.signed : null;
        //console.log(`  Game ${game.game_id}: key=${key}, pick=${JSON.stringify(pick)}, predSigned=${predSigned}, actualSigned=${actualSigned}`);
        if (predSigned != null && actualSigned != null) {
          const score = scoreForPick(predSigned, actualSigned);
          //console.log(`  Game ${game.game_id}: score=${score}, totalScore before=${totalScore}`);
          totalScore += score;
          //console.log(`  Game ${game.game_id}: totalScore after=${totalScore}`);
        }
      }
      //console.log(`Player ${player.pigeon_number} final totalScore: ${totalScore}`);
      return {
        ...player,
        points: totalScore,
        rank: 0,
        tie: false,
      };
    });
    // Sort by score ascending (lower is better), then rank
    const sorted = [...recalculated].sort((a, b) => (a.points ?? 9999) - (b.points ?? 9999) || (a.rank ?? 99) - (b.rank ?? 99));
    //console.log('Sorted recalculated:', sorted);
  // ...existing code...
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
    //console.log('Final recalculatedPlayers:', sorted);
    return sorted;
  }, [enteredScores, rows, games]);

  // Filter to show only top 5 ranked players, plus always include current pigeon if not in top 5
  const displayedTop5 = useMemo(() => {
    const top5 = recalculatedPlayers.slice(0, 5);
    
    // Check if current pigeon is already in top 5
    const isPigeonInTop5 = top5.some(p => p.pigeon_number === pigeon);
    
    // If current pigeon is not in top 5 but exists in recalculated list, add them
    if (!isPigeonInTop5 && pigeon) {
      const currentPigeon = recalculatedPlayers.find(p => p.pigeon_number === pigeon);
      if (currentPigeon) {
        return [...top5, currentPigeon];
      }
    }
    
    return top5;
  }, [recalculatedPlayers, pigeon]);

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
                {displayedTop5.map((player) => {
                  const isCurrentPigeon = player.pigeon_number === pigeon;
                  return (
                    <tr 
                      key={player.pigeon_number}
                      style={{ 
                        backgroundColor: isCurrentPigeon ? '#fff59d' : undefined 
                      }}
                      onDoubleClick={() => setExplainerOpen(true)}
                    >
                      <td style={{ padding: '8px', borderTop: '1px solid #eee' }}>{`${player.pigeon_number} ${player.pigeon_name}`}</td>
                      <td style={{ padding: '8px', borderTop: '1px solid #eee' }}>{player.points}</td>
                      <td style={{ padding: '8px', borderTop: '1px solid #eee' }}>{player.tie ? `T${player.rank}` : player.rank}</td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </Paper>
          {/* Show message if more than 5 players are tied at the 5th rank */}
          {(() => {
            if (recalculatedPlayers.length > 5) {
              // Get the top 5 players only (excluding current pigeon if added separately)
              const top5Only = recalculatedPlayers.slice(0, 5);
              const lastTop5Rank = top5Only.length ? top5Only[top5Only.length - 1].rank : null;
              
              if (lastTop5Rank != null) {
                // Count all players at that rank
                const tiedPlayers = recalculatedPlayers.filter(p => p.rank === lastTop5Rank);
                // Subtract the ones already shown in top 5
                const extraTied = tiedPlayers.length - top5Only.filter(p => p.rank === lastTop5Rank).length;
                
                if (extraTied > 0) {
                  return (
                    <Typography variant="body2" sx={{ mt: 2, color: 'text.secondary', textAlign: 'center' }}>
                      {extraTied} other player{extraTied > 1 ? 's are' : ' is'} tied at rank {lastTop5Rank}
                    </Typography>
                  );
                }
              }
            }
            return null;
          })()}
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
        <SecretModal open={explainerOpen} onClose={() => setExplainerOpen(false)}>
          <Top5Explainer pigeon={pigeon} rows={rows} games={games} />
        </SecretModal>
      </Box>
    </Box>
  );
}
