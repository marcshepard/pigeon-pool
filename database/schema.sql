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

-- === PLAYERS ===
CREATE TABLE IF NOT EXISTS players (
  pigeon_number INT PRIMARY KEY CHECK (pigeon_number BETWEEN 1 AND 68),
  pigeon_name   TEXT NOT NULL UNIQUE,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_admin      BOOLEAN NOT NULL DEFAULT FALSE
);

-- === PICKS ===
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
CREATE OR REPLACE FUNCTION deny_picks_after_lock()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  is_locked BOOLEAN;
BEGIN
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

CREATE OR REPLACE VIEW v_picks_filled AS
SELECT
  pl.pigeon_number,
  g.game_id,
  g.week_number,
  COALESCE(p.picked_home, TRUE)   AS picked_home,       -- default to home
  COALESCE(p.predicted_margin, 0) AS predicted_margin,  -- default to 0
  p.created_at
FROM players pl
CROSS JOIN games g
LEFT JOIN picks p
  ON p.pigeon_number = pl.pigeon_number
 AND p.game_id       = g.game_id;

-- === WEEKLY LEADERBOAD VIEW ===
-- Shows total points and rank per player per week:
-- * Games not yet started are ignored
-- * Points per game are calculated as the difference between predicted margin and actual margin, plus 7 pt penalty if the pick was wrong
-- * A pick of 0 (imbued if pick was not made) always incurs a 7 pt penalty
-- * Rank is based on total points per week; lower is better
CREATE OR REPLACE VIEW v_weekly_leaderboard AS
WITH base AS (
  SELECT
    f.pigeon_number,
    g.week_number,
    g.game_id,
    g.home_score,
    g.away_score,
    f.predicted_margin,
    f.picked_home
  FROM v_picks_filled f
  JOIN games g ON g.game_id = f.game_id
  WHERE g.kickoff_at <= now()          -- ignore not-started games
),
scored AS (
  SELECT
    b.*,
    CASE
      WHEN b.home_score IS NULL OR b.away_score IS NULL THEN 0
      ELSE ABS(b.home_score - b.away_score)
    END AS actual_margin,
    CASE
      WHEN b.home_score IS NULL OR b.away_score IS NULL THEN NULL
      WHEN b.home_score >  b.away_score THEN TRUE
      WHEN b.home_score <  b.away_score THEN FALSE
      ELSE NULL  -- tie
    END AS home_won
  FROM base b
),
per_game AS (
  SELECT
    s.pigeon_number,
    s.week_number,
    s.game_id,
    ABS(s.predicted_margin - s.actual_margin) AS margin_diff,
    CASE
      WHEN s.predicted_margin = 0 THEN 7             -- 0 margin always +7
      WHEN s.home_won IS NULL THEN 0                 -- tie/unknown: no wrong-side penalty
      WHEN s.picked_home <> s.home_won THEN 7        -- wrong side
      ELSE 0
    END AS penalty
  FROM scored s
),
totals AS (
  SELECT
    pigeon_number,
    week_number,
    SUM(margin_diff + penalty)::INT AS total_points
  FROM per_game
  GROUP BY pigeon_number, week_number
)
SELECT
  t.pigeon_number,
  p.pigeon_name,
  t.week_number,
  t.total_points,
  RANK() OVER (PARTITION BY t.week_number ORDER BY t.total_points ASC) AS rank
FROM totals t
JOIN players p ON p.pigeon_number = t.pigeon_number;

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
