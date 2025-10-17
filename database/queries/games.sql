--SELECT * FROM games WHERE week_number = 7 ORDER BY kickoff_at;

-- Force job to rerun by deleting its last run record
-- DELETE FROM scheduler_runs WHERE job_name = 'score_sync';
