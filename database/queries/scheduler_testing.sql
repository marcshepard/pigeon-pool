-- What week does the scheduler consider "current"?
SELECT MAX(week_number) AS current_week
FROM weeks
WHERE lock_at <= now();

-- Sunday games not final, computed in PST
WITH w AS (SELECT MAX(week_number) AS wk FROM weeks WHERE lock_at <= now())
SELECT game_id, home_abbr, away_abbr, kickoff_at, status
FROM games
WHERE week_number = (SELECT wk FROM w)
  AND EXTRACT(ISODOW FROM (kickoff_at AT TIME ZONE 'America/Los_Angeles')) = 7
  AND status <> 'final';

  -- Are there any games still not final (to justify Sun interim)?
WITH w AS (SELECT MAX(week_number) AS wk FROM weeks WHERE lock_at <= now())
SELECT COUNT(*) FROM games WHERE week_number=(SELECT wk FROM w) AND status <> 'final';