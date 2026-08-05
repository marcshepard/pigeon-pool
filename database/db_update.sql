-- =============================================================
-- DB update scripts go here
-- =============================================================

-- Weekly lock time was being computed as "Wednesday 23:59:59 PT before the
-- earliest kickoff of the week" (backend/utils/score_sync.py::_calc_lock_at_pacific).
-- The correct rule is Tuesday 23:59:59 PT -- this was already fixed once in
-- commit e2ce307 ("Adjusted weekly lock times to EOD Tuesday to align with
-- Andy"), but that fix only ever patched the `weeks.lock_at` data directly;
-- it never touched _calc_lock_at_pacific() itself. So every later reschedule
-- (the multi-tenant migration's weeks.default_lock_at / tenant_weeks.lock_at
-- split, reset-season, create-league, activate-season) silently regenerated
-- Wednesday locks again. _calc_lock_at_pacific() has now been fixed to
-- compute Tuesday; this script re-applies that fix to existing data:
--   1. tenant_weeks.lock_at    -- each tenant's active schedule, but only for
--      rows still equal to the (about-to-be-replaced) global default, so a
--      commissioner's manual PATCH /admin/weeks/{week}/lock override is left
--      untouched.
--   2. weeks.default_lock_at   -- the global per-week template
-- Each step below is a single self-contained statement (its own WITH clause,
-- no temp table) so it works whether your SQL client runs the whole file as
-- one transaction or autocommits statement-by-statement -- both must run in
-- this order (tenant_weeks before weeks) since step 1 compares against
-- weeks.default_lock_at's *old* value.
-- Run this against both the local dev DB and production after deploying the
-- _calc_lock_at_pacific() fix. Idempotent -- safe to run more than once.

-- Step 1: fix tenant_weeks *before* touching weeks.default_lock_at below, so
-- "still equal to the global default" compares against the old (Wednesday)
-- value, not the new one.
WITH first_kick AS (
    SELECT g.week_number,
           (MIN(g.kickoff_at) AT TIME ZONE 'America/Los_Angeles')::date AS first_kick_date
      FROM games g
     GROUP BY g.week_number
),
new_lock AS (
    SELECT
        fk.week_number,
        (
            (
                fk.first_kick_date
                - (
                    CASE
                        WHEN (EXTRACT(ISODOW FROM fk.first_kick_date)::int - 2 + 7) % 7 = 0 THEN 7
                        ELSE (EXTRACT(ISODOW FROM fk.first_kick_date)::int - 2 + 7) % 7
                    END
                  )
            ) + TIME '23:59:59'
        ) AT TIME ZONE 'America/Los_Angeles' AS new_lock_at
      FROM first_kick fk
)
UPDATE tenant_weeks tw
   SET lock_at = n.new_lock_at
  FROM new_lock n
  JOIN weeks w ON w.week_number = n.week_number
 WHERE tw.week_number = n.week_number
   AND tw.lock_at = w.default_lock_at;

-- Step 2: fix the global template so future create-league / reset-season /
-- activate-season calls pick up the corrected Tuesday time.
WITH first_kick AS (
    SELECT g.week_number,
           (MIN(g.kickoff_at) AT TIME ZONE 'America/Los_Angeles')::date AS first_kick_date
      FROM games g
     GROUP BY g.week_number
),
new_lock AS (
    SELECT
        fk.week_number,
        (
            (
                fk.first_kick_date
                - (
                    CASE
                        WHEN (EXTRACT(ISODOW FROM fk.first_kick_date)::int - 2 + 7) % 7 = 0 THEN 7
                        ELSE (EXTRACT(ISODOW FROM fk.first_kick_date)::int - 2 + 7) % 7
                    END
                  )
            ) + TIME '23:59:59'
        ) AT TIME ZONE 'America/Los_Angeles' AS new_lock_at
      FROM first_kick fk
)
UPDATE weeks w
   SET default_lock_at = n.new_lock_at
  FROM new_lock n
 WHERE w.week_number = n.week_number;

-- Sanity check 1: new lock times vs. first kickoff, per week.
SELECT
    w.week_number,
    (w.default_lock_at AT TIME ZONE 'America/Los_Angeles') AS default_lock_pst,
    (MIN(g.kickoff_at) AT TIME ZONE 'America/Los_Angeles') AS first_kickoff_pst
  FROM weeks w
  JOIN games g USING (week_number)
 GROUP BY w.week_number, w.default_lock_at
 ORDER BY w.week_number;

-- Sanity check 2: any tenant_weeks rows NOT on the (now-corrected) global
-- default -- expected to be empty unless a commissioner manually overrode a
-- week's lock time, in which case it's intentionally left alone.
SELECT tw.tenant_id, tw.week_number, tw.lock_at,
       (tw.lock_at AT TIME ZONE 'America/Los_Angeles') AS lock_at_pst
  FROM tenant_weeks tw
  JOIN weeks w ON w.week_number = tw.week_number
 WHERE tw.lock_at <> w.default_lock_at
 ORDER BY tw.tenant_id, tw.week_number;
