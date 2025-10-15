-- Script to upgrade the current SQL schema or data

-- The weeks table was previously set to lock at the end of day on the Wednesday before the first kickoff
-- Changing it to lock EOD Tuesday to align with Andy

WITH first_kick AS (
  SELECT g.week_number,
         MIN(g.kickoff_at) AT TIME ZONE 'America/Los_Angeles' AS first_kick_pacific
  FROM games g
  GROUP BY g.week_number
),
tuesday_lock AS (
  SELECT
    fk.week_number,
    (fk.first_kick_pacific)::date
    - ((EXTRACT(ISODOW FROM (fk.first_kick_pacific)::date)::int - 2 + 7) % 7) AS lock_date_pacific
  FROM first_kick fk
),
desired_lock AS (
  SELECT
    tl.week_number,
    ((tl.lock_date_pacific + time '23:59:59') AT TIME ZONE 'America/Los_Angeles') AS lock_at_utc
  FROM tuesday_lock tl
)
UPDATE weeks w
SET lock_at = d.lock_at_utc
FROM desired_lock d
WHERE d.week_number = w.week_number;

-- Sanity check: show the new lock times and first kickoff times in PST
SELECT
  w.week_number,
  (w.lock_at AT TIME ZONE 'America/Los_Angeles')        AS lock_at_pst,
  (MIN(g.kickoff_at) AT TIME ZONE 'America/Los_Angeles') AS first_kickoff_pst
    FROM weeks w
    JOIN games g USING (week_number)
    GROUP BY w.week_number
    ORDER BY w.week_number;