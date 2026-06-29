SELECT game_id, home_abbr, away_abbr, kickoff_at, status, home_score, away_score
FROM games
WHERE week_number = 18
ORDER BY kickoff_at;
