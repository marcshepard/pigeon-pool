-- Schema for the pigeon pool

-- === TEAMS ===
CREATE TABLE IF NOT EXISTS teams (
  abbr TEXT PRIMARY KEY,
  name TEXT NOT NULL
);

-- === WEEKS ===
CREATE TABLE IF NOT EXISTS weeks (
  week_number INT PRIMARY KEY CHECK (week_number BETWEEN 1 AND 18),
  lock_at     TIMESTAMPTZ NOT NULL
);

-- === GAMES ===
CREATE TABLE IF NOT EXISTS games (
  game_id     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  espn_event_id BIGINT UNIQUE,
  week_number INT NOT NULL REFERENCES weeks(week_number) ON DELETE CASCADE,
  kickoff_at  TIMESTAMPTZ NOT NULL,
  home_abbr   TEXT NOT NULL REFERENCES teams(abbr),
  away_abbr   TEXT NOT NULL REFERENCES teams(abbr),
  status      TEXT NOT NULL CHECK (status IN ('scheduled','in_progress','final')),
  home_score  INT,
  away_score  INT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT games_no_self CHECK (home_abbr <> away_abbr),
  CONSTRAINT games_unique_per_week UNIQUE (week_number, home_abbr, away_abbr)
);

CREATE INDEX IF NOT EXISTS ix_games_week_status ON games (week_number, status);
CREATE INDEX IF NOT EXISTS ix_games_kickoff ON games (kickoff_at);

-- === PLAYERS - the pigeons in the pool === 
CREATE TABLE IF NOT EXISTS players (
  pigeon_number INT PRIMARY KEY CHECK (pigeon_number BETWEEN 1 AND 68),
  pigeon_name   TEXT NOT NULL UNIQUE
);

-- === USERS - the people who make pigeon picks ===
CREATE TABLE IF NOT EXISTS users (
  user_id       BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email         TEXT NOT NULL CHECK (email ~* '^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$'),
  password_hash TEXT NOT NULL,
  is_admin      BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_users_email_lower ON users ((lower(email)));

-- === The mapping use users to players is many-to-many ===
CREATE TABLE IF NOT EXISTS user_players (
  user_id       BIGINT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  pigeon_number INT    NOT NULL REFERENCES players(pigeon_number) ON DELETE CASCADE,
  role          TEXT   NOT NULL DEFAULT 'owner' CHECK (role IN ('owner','manager','viewer')),
  is_primary    BOOLEAN NOT NULL DEFAULT TRUE,
  PRIMARY KEY (user_id, pigeon_number)
);
-- Exactly one 'owner' per pigeon
CREATE UNIQUE INDEX IF NOT EXISTS uniq_pigeon_single_owner
  ON user_players(pigeon_number)
  WHERE role = 'owner';
-- Each user can have only one primary pigeon
CREATE UNIQUE INDEX IF NOT EXISTS uniq_user_single_primary
  ON user_players(user_id)
  WHERE is_primary = TRUE;

-- === PICKS ===
-- Now includes the user who made the pick (nullable for legacy picks)
CREATE TABLE IF NOT EXISTS picks (
  pigeon_number    INT    NOT NULL REFERENCES players(pigeon_number) ON DELETE CASCADE,
  game_id          BIGINT NOT NULL REFERENCES games(game_id) ON DELETE CASCADE,
  picked_home      BOOLEAN NOT NULL,                      -- TRUE = home, FALSE = away
  predicted_margin INT NOT NULL CHECK (predicted_margin >= 0),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (pigeon_number, game_id)
);

CREATE INDEX IF NOT EXISTS ix_picks_game   ON picks (game_id);
CREATE INDEX IF NOT EXISTS ix_picks_player ON picks (pigeon_number);

-- === LOCK TRIGGER ===
-- Recreate with a bypass knob
CREATE OR REPLACE FUNCTION deny_picks_after_lock()
RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  is_locked BOOLEAN;
  bypass TEXT;
BEGIN
  -- If caller set a session var, skip the lock check
  BEGIN
    bypass := current_setting('app.bypass_lock', true);
  EXCEPTION WHEN OTHERS THEN
    bypass := NULL;
  END;

  IF COALESCE(bypass, '') IN ('on','true','1') THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  SELECT (w.lock_at <= now())
    INTO is_locked
  FROM games g
  JOIN weeks w ON w.week_number = g.week_number
  WHERE g.game_id = COALESCE(NEW.game_id, OLD.game_id);

  IF is_locked THEN
    RAISE EXCEPTION 'Week is locked; picks are read-only';
  END IF;

  RETURN COALESCE(NEW, OLD);
END$$;

-- === PICKS FILLED VIEW ===
-- Synthesizes "home team by 0" picks for games a player hasn't picked yet
-- (so the UI can show a full slate of picks for each player)
-- DROP VIEW IF EXISTS v_weekly_leaderboard;
-- DROP VIEW IF EXISTS v_results;
-- DROP VIEW IF EXISTS v_picks_filled CASCADE;

CREATE OR REPLACE VIEW v_picks_filled AS
SELECT
  pl.pigeon_number,
  g.game_id,
  g.week_number,
  COALESCE(p.picked_home, TRUE)   AS picked_home,       -- default to home
  COALESCE(p.predicted_margin, 0) AS predicted_margin,  -- default to 0
  p.created_at,
  (p.game_id IS NOT NULL)         AS is_made            -- TRUE if an actual pick exists
FROM players pl
CROSS JOIN games g
LEFT JOIN picks p
  ON p.pigeon_number = pl.pigeon_number
 AND p.game_id       = g.game_id;

-- === RESULTS VIEW ===
-- Calculates points per player per game for all games that have started and have a score
-- This gives final total points from past weeks + current points from the week in progress
CREATE OR REPLACE VIEW v_results AS
WITH base AS (
  SELECT
    pl.pigeon_name,
    pl.pigeon_number,
    g.week_number,
    g.game_id,
    format('%s @ %s', g.away_abbr, g.home_abbr) AS game_name,
    /* signed margins */
    CASE WHEN f.picked_home THEN f.predicted_margin ELSE -f.predicted_margin END AS predicted_margin,  -- +home, -away, 0=tie pick
    (g.home_score - g.away_score) AS actual_margin,                                                     -- +home win, -away win, 0=tie
    f.is_made
  FROM v_picks_filled f
  JOIN games   g  ON g.game_id = f.game_id
  JOIN players pl ON pl.pigeon_number = f.pigeon_number
  WHERE g.kickoff_at <= now()
    AND g.home_score IS NOT NULL
    AND g.away_score IS NOT NULL
)
SELECT
  b.pigeon_name,
  b.pigeon_number,
  b.week_number,
  b.game_id,
  b.game_name,

  /* signed margins (to match Andy's sheet) */
  b.predicted_margin,
  b.actual_margin,

  /* diff = |predicted - actual| using signed numbers */
  ABS(b.predicted_margin - b.actual_margin)::INT AS diff,

  /* penalty by sign only:
     - synthesized pick → 50
     - picked tie AND game tied → 7  (kept explicit so you can tune)
     - sign(predicted) ≠ sign(actual) → 7 (wrong outcome in any direction)
     - else 0
  */
  CASE
    WHEN b.is_made = FALSE THEN 50
    WHEN SIGN(b.predicted_margin) = 0 AND SIGN(b.actual_margin) = 0 THEN 7
    WHEN SIGN(b.predicted_margin) <> SIGN(b.actual_margin) THEN 7
    ELSE 0
  END::INT AS penalty,

  /* total score */
  (ABS(b.predicted_margin - b.actual_margin)
   +
   CASE
     WHEN b.is_made = FALSE THEN 100
     WHEN SIGN(b.predicted_margin) = 0 AND SIGN(b.actual_margin) = 0 THEN 7
     WHEN SIGN(b.predicted_margin) <> SIGN(b.actual_margin) THEN 7
     ELSE 0
   END)::INT AS score
FROM base b;

-- === WEEKLY LEADERBOAD VIEW ===
-- Shows total points and rank per player per week:
-- * Games not yet started are ignored
-- * score is total score (lower is better) per the complex v_results calculation
-- * rank is based on total points per week; lower is better
-- * points is the fractional rank (e.g., two tied at 2nd → (2 + 3)/2 = 2.5)
CREATE OR REPLACE VIEW v_weekly_leaderboard AS
WITH totals AS (
  SELECT
    r.pigeon_number,
    MIN(r.pigeon_name) AS pigeon_name,
    r.week_number,
    SUM(r.score)::INT AS score
  FROM v_results r
  GROUP BY r.pigeon_number, r.week_number
),
ranked AS (
  SELECT
    t.*,
    RANK() OVER (PARTITION BY t.week_number ORDER BY t.score)             AS rank,
    COUNT(*) OVER (PARTITION BY t.week_number, t.score)                   AS tie_count
  FROM totals t
)
SELECT
  pigeon_number,
  pigeon_name,
  week_number,
  LEAST(score, 800) AS score,
  rank,
  /* Average the occupied positions for ties, e.g., two tied at 2nd → (2 + 3)/2 = 2.5 */
  (rank + (tie_count - 1) / 2.0)::numeric(10,1) AS points
FROM ranked;

-- Convenience view for "all picks for a locked week" (privacy: only locked weeks).
-- Join includes pigeon_name and full game context in one place.
CREATE OR REPLACE VIEW v_week_picks_with_names AS
SELECT
  pl.pigeon_number,
  pl.pigeon_name,
  g.game_id,
  g.week_number,
  f.picked_home,
  f.predicted_margin,
  g.home_abbr,
  g.away_abbr,
  g.kickoff_at,
  g.status,
  g.home_score,
  g.away_score
FROM v_picks_filled f
JOIN games   g  ON g.game_id = f.game_id
JOIN weeks   w  ON w.week_number = g.week_number
JOIN players pl ON pl.pigeon_number = f.pigeon_number
WHERE w.lock_at <= now();

-- Admin version - can see unlocked weeks too
CREATE OR REPLACE VIEW v_admin_week_picks_with_names AS
SELECT
  pl.pigeon_number,
  pl.pigeon_name,
  g.game_id,
  g.week_number,
  f.picked_home,
  f.predicted_margin,
  g.home_abbr,
  g.away_abbr,
  g.kickoff_at,
  g.status,
  g.home_score,
  g.away_score
FROM v_picks_filled f
JOIN games   g  ON g.game_id = f.game_id
JOIN weeks   w  ON w.week_number = g.week_number
JOIN players pl ON pl.pigeon_number = f.pigeon_number;

-- === Track the last run of scheduled jobs ===
CREATE TABLE IF NOT EXISTS scheduler_runs (
  job_name TEXT PRIMARY KEY,
  last_at  TIMESTAMPTZ NOT NULL
);

-- Trigger the lock check on picks insert/update/delete
DROP TRIGGER IF EXISTS trg_picks_insert_lock ON picks;
CREATE TRIGGER trg_picks_insert_lock
  BEFORE INSERT ON picks
  FOR EACH ROW EXECUTE FUNCTION deny_picks_after_lock();

DROP TRIGGER IF EXISTS trg_picks_update_lock ON picks;
CREATE TRIGGER trg_picks_update_lock
  BEFORE UPDATE ON picks
  FOR EACH ROW EXECUTE FUNCTION deny_picks_after_lock();

DROP TRIGGER IF EXISTS trg_picks_delete_lock ON picks;
CREATE TRIGGER trg_picks_delete_lock
  BEFORE DELETE ON picks
  FOR EACH ROW EXECUTE FUNCTION deny_picks_after_lock();
