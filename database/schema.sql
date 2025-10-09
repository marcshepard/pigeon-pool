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

CREATE TRIGGER trg_picks_insert_lock
  BEFORE INSERT ON picks
  FOR EACH ROW EXECUTE FUNCTION deny_picks_after_lock();

CREATE TRIGGER trg_picks_update_lock
  BEFORE UPDATE ON picks
  FOR EACH ROW EXECUTE FUNCTION deny_picks_after_lock();

CREATE TRIGGER trg_picks_delete_lock
  BEFORE DELETE ON picks
  FOR EACH ROW EXECUTE FUNCTION deny_picks_after_lock();
