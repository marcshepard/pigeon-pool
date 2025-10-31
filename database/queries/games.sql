--SELECT * FROM games WHERE week_number = 7 ORDER BY kickoff_at;

-- Force job to rerun by deleting its last run record
-- DELETE FROM scheduler_runs WHERE job_name = 'score_sync';

/*
UPDATE games
    SET status = 'final'
    WHERE game_id = 122;;
*/

SELECT game_id, week_number, home_abbr, away_abbr, kickoff_at, status
FROM games
WHERE week_number < (
    SELECT MAX(week_number) FROM weeks WHERE lock_at <= now()
)
AND status <> 'final'
ORDER BY week_number, kickoff_at;