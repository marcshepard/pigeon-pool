-- =============================================================
-- Stage 3: Migrate pigeon_pool_multi to the multi-tenant schema
-- =============================================================
-- Run against pigeon_pool_multi (the dev clone; never against pigeon_pool).
-- The entire migration is wrapped in a transaction: any failure rolls back cleanly.
--
-- What this script does:
--   1.  Creates tenants; inserts 'The Pigeon Pool' as tenant 1.
--   2.  Adds weeks.default_lock_at (template); backfills from existing lock_at.
--   3.  Creates tenant_weeks; backfills from weeks.lock_at for tenant 1.
--   4.  Drops weeks.lock_at.
--   5.  Drops FKs from user_players and picks that reference players(pigeon_number).
--   6.  Adds player_id and tenant_id to players; backfills (player_id = pigeon_number).
--   7.  Creates sequence players_player_id_seq starting at 69.
--   8.  Drops old players PK/constraints; sets player_id as new PK.
--   9.  Adds player_id to user_players; backfills.
--   10. Creates tenant_members; backfills from users/user_players (uses is_admin, is_primary).
--   11. Drops users.is_admin (now in tenant_members.role).
--   12. Drops user_players indexes, PK, is_primary column, pigeon_number column.
--       Rebuilds with new PK (user_id, player_id) and updated indexes.
--   13. Adds player_id to picks; backfills.
--   14. Drops old picks triggers, PK, indexes, pigeon_number column.
--       Rebuilds with new PK (player_id, game_id) and updated indexes.
--   15. Updates deny_picks_after_lock() to join tenant_weeks via player_id.
--   16. Recreates triggers and all views.
-- =============================================================

BEGIN;

-- Bypass the pick lock trigger for the duration of this migration.
-- (Triggers are also dropped early, but this is a belt-and-suspenders guard.)
SET LOCAL app.bypass_lock = 'on';

-- -------------------------------------------------------------
-- 1. Drop views (depend on old column names)
-- -------------------------------------------------------------
DROP VIEW IF EXISTS v_admin_week_picks_with_names;
DROP VIEW IF EXISTS v_week_picks_with_names;
DROP VIEW IF EXISTS v_weekly_leaderboard;
DROP VIEW IF EXISTS v_results;
DROP VIEW IF EXISTS v_picks_filled;

-- -------------------------------------------------------------
-- 2. Drop pick triggers (depend on old schema)
-- -------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_picks_insert_lock ON picks;
DROP TRIGGER IF EXISTS trg_picks_update_lock ON picks;
DROP TRIGGER IF EXISTS trg_picks_delete_lock ON picks;

-- -------------------------------------------------------------
-- 3. Create tenants; insert the existing pool as tenant 1
-- -------------------------------------------------------------
CREATE TABLE tenants (
  tenant_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name      TEXT NOT NULL
);
INSERT INTO tenants (name) VALUES ('The Pigeon Pool');
-- All subsequent backfills reference tenant_id = 1.

-- -------------------------------------------------------------
-- 4. Add weeks.default_lock_at; copy from existing lock_at
-- -------------------------------------------------------------
ALTER TABLE weeks ADD COLUMN default_lock_at TIMESTAMPTZ;
UPDATE weeks SET default_lock_at = lock_at;

-- -------------------------------------------------------------
-- 5. Create tenant_weeks; backfill from weeks.lock_at for tenant 1
-- -------------------------------------------------------------
CREATE TABLE tenant_weeks (
  tenant_id   BIGINT NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  week_number INT    NOT NULL REFERENCES weeks(week_number)  ON DELETE CASCADE,
  lock_at     TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, week_number)
);
INSERT INTO tenant_weeks (tenant_id, week_number, lock_at)
SELECT 1, week_number, lock_at FROM weeks;

-- -------------------------------------------------------------
-- 6. Drop weeks.lock_at (now in tenant_weeks)
-- -------------------------------------------------------------
ALTER TABLE weeks DROP COLUMN lock_at;

-- -------------------------------------------------------------
-- 7. Drop FKs from user_players and picks that reference players(pigeon_number).
--    Must happen before changing the players primary key.
-- -------------------------------------------------------------
ALTER TABLE user_players DROP CONSTRAINT user_players_pigeon_number_fkey;
ALTER TABLE picks        DROP CONSTRAINT picks_pigeon_number_fkey;

-- -------------------------------------------------------------
-- 8. Add player_id and tenant_id to players; backfill
--    player_id = pigeon_number for all existing rows (values 1-68),
--    so FK values in user_players and picks are numerically identical.
-- -------------------------------------------------------------
ALTER TABLE players ADD COLUMN player_id BIGINT;
ALTER TABLE players ADD COLUMN tenant_id BIGINT;
UPDATE players SET player_id = pigeon_number, tenant_id = 1;
ALTER TABLE players ALTER COLUMN player_id SET NOT NULL;
ALTER TABLE players ALTER COLUMN tenant_id SET NOT NULL;

-- -------------------------------------------------------------
-- 9. Create sequence for new player IDs; start at 69 (after existing 1-68)
-- -------------------------------------------------------------
CREATE SEQUENCE players_player_id_seq START WITH 69;
ALTER TABLE players ALTER COLUMN player_id SET DEFAULT nextval('players_player_id_seq');
ALTER SEQUENCE players_player_id_seq OWNED BY players.player_id;

-- -------------------------------------------------------------
-- 10. Rebuild players constraints
--     Drop old PK (pigeon_number), old CHECK, old global UNIQUE on pigeon_name.
--     Add new PK (player_id), new tenant FK, per-tenant UNIQUEs, relaxed CHECK.
-- -------------------------------------------------------------
ALTER TABLE players DROP CONSTRAINT players_pkey;
ALTER TABLE players DROP CONSTRAINT players_pigeon_number_check;
ALTER TABLE players DROP CONSTRAINT players_pigeon_name_key;

ALTER TABLE players ADD PRIMARY KEY (player_id);
ALTER TABLE players ADD CONSTRAINT players_tenant_id_fkey
  FOREIGN KEY (tenant_id) REFERENCES tenants(tenant_id);
ALTER TABLE players ADD CONSTRAINT players_pigeon_number_check
  CHECK (pigeon_number >= 1);
ALTER TABLE players ADD CONSTRAINT players_tenant_pigeon_number_unique
  UNIQUE (tenant_id, pigeon_number);
ALTER TABLE players ADD CONSTRAINT players_tenant_pigeon_name_unique
  UNIQUE (tenant_id, pigeon_name);

-- -------------------------------------------------------------
-- 11. Add player_id to user_players; backfill from pigeon_number mapping
-- -------------------------------------------------------------
ALTER TABLE user_players ADD COLUMN player_id BIGINT;
UPDATE user_players up
SET    player_id = p.player_id
FROM   players p
WHERE  up.pigeon_number = p.pigeon_number;
ALTER TABLE user_players ALTER COLUMN player_id SET NOT NULL;

-- -------------------------------------------------------------
-- 12. Create tenant_members; backfill from users + user_players
--     BEFORE dropping is_admin and is_primary (we still need them here).
--
--     role:              'commissioner' for is_admin=TRUE, 'member' otherwise
--     primary_player_id: is_primary=TRUE row if one exists, else lowest player_id
-- -------------------------------------------------------------
CREATE TABLE tenant_members (
  tenant_id         BIGINT NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  user_id           BIGINT NOT NULL REFERENCES users(user_id)      ON DELETE CASCADE,
  role              TEXT   NOT NULL DEFAULT 'member'
                           CHECK (role IN ('commissioner','member')),
  primary_player_id BIGINT NOT NULL REFERENCES players(player_id),
  PRIMARY KEY (tenant_id, user_id)
);

INSERT INTO tenant_members (tenant_id, user_id, role, primary_player_id)
SELECT
  1 AS tenant_id,
  u.user_id,
  CASE WHEN u.is_admin THEN 'commissioner' ELSE 'member' END AS role,
  COALESCE(
    (SELECT up2.player_id FROM user_players up2
      WHERE up2.user_id = u.user_id AND up2.is_primary = TRUE
      ORDER BY up2.player_id LIMIT 1),
    (SELECT up3.player_id FROM user_players up3
      WHERE up3.user_id = u.user_id
      ORDER BY up3.player_id LIMIT 1)
  ) AS primary_player_id
FROM users u
WHERE EXISTS (
  SELECT 1 FROM user_players up WHERE up.user_id = u.user_id
);

-- -------------------------------------------------------------
-- 13. Drop users.is_admin (now expressed through tenant_members.role)
-- -------------------------------------------------------------
ALTER TABLE users DROP COLUMN is_admin;

-- -------------------------------------------------------------
-- 14. Rebuild user_players: drop old indexes, PK, and obsolete columns;
--     add new PK (user_id, player_id) and FK to players(player_id).
--
--     Order matters: drop indexes before dropping their columns;
--     drop PK before dropping pigeon_number (it was part of the PK).
-- -------------------------------------------------------------
DROP INDEX uniq_pigeon_single_owner;   -- ON user_players(pigeon_number) WHERE role='owner'
DROP INDEX uniq_user_single_primary;   -- ON user_players(user_id) WHERE is_primary=TRUE
ALTER TABLE user_players DROP CONSTRAINT user_players_pkey;  -- (user_id, pigeon_number)
ALTER TABLE user_players DROP COLUMN is_primary;
ALTER TABLE user_players DROP COLUMN pigeon_number;

ALTER TABLE user_players ADD PRIMARY KEY (user_id, player_id);
ALTER TABLE user_players ADD CONSTRAINT user_players_player_id_fkey
  FOREIGN KEY (player_id) REFERENCES players(player_id) ON DELETE CASCADE;

CREATE UNIQUE INDEX uniq_player_single_owner
  ON user_players(player_id)
  WHERE role = 'owner';

-- -------------------------------------------------------------
-- 15. Add player_id to picks; backfill from pigeon_number
-- -------------------------------------------------------------
ALTER TABLE picks ADD COLUMN player_id BIGINT;
UPDATE picks pk
SET    player_id = p.player_id
FROM   players p
WHERE  pk.pigeon_number = p.pigeon_number;
ALTER TABLE picks ALTER COLUMN player_id SET NOT NULL;

-- -------------------------------------------------------------
-- 16. Rebuild picks: drop old indexes, PK, and pigeon_number column;
--     add new PK (player_id, game_id) and FK to players(player_id).
-- -------------------------------------------------------------
DROP INDEX ix_picks_game;    -- will be recreated
DROP INDEX ix_picks_player;  -- was ON picks(pigeon_number); recreated on player_id
ALTER TABLE picks DROP CONSTRAINT picks_pkey;  -- (pigeon_number, game_id)
ALTER TABLE picks DROP COLUMN pigeon_number;

ALTER TABLE picks ADD PRIMARY KEY (player_id, game_id);
ALTER TABLE picks ADD CONSTRAINT picks_player_id_fkey
  FOREIGN KEY (player_id) REFERENCES players(player_id) ON DELETE CASCADE;

CREATE INDEX ix_picks_game   ON picks (game_id);
CREATE INDEX ix_picks_player ON picks (player_id);

-- -------------------------------------------------------------
-- 17. Update deny_picks_after_lock() to use tenant_weeks via player_id
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION deny_picks_after_lock()
RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  is_locked BOOLEAN;
  bypass    TEXT;
BEGIN
  BEGIN
    bypass := current_setting('app.bypass_lock', true);
  EXCEPTION WHEN OTHERS THEN
    bypass := NULL;
  END;

  IF COALESCE(bypass, '') IN ('on','true','1') THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  SELECT (tw.lock_at <= now())
    INTO is_locked
  FROM players pl
  JOIN games g
    ON g.game_id = COALESCE(NEW.game_id, OLD.game_id)
  JOIN tenant_weeks tw
    ON tw.tenant_id = pl.tenant_id AND tw.week_number = g.week_number
  WHERE pl.player_id = COALESCE(NEW.player_id, OLD.player_id);

  IF COALESCE(is_locked, FALSE) THEN
    RAISE EXCEPTION 'Week is locked; picks are read-only';
  END IF;

  RETURN COALESCE(NEW, OLD);
END$$;

-- -------------------------------------------------------------
-- 18. Recreate triggers on picks
-- -------------------------------------------------------------
CREATE TRIGGER trg_picks_insert_lock
  BEFORE INSERT ON picks
  FOR EACH ROW EXECUTE FUNCTION deny_picks_after_lock();

CREATE TRIGGER trg_picks_update_lock
  BEFORE UPDATE ON picks
  FOR EACH ROW EXECUTE FUNCTION deny_picks_after_lock();

CREATE TRIGGER trg_picks_delete_lock
  BEFORE DELETE ON picks
  FOR EACH ROW EXECUTE FUNCTION deny_picks_after_lock();

-- -------------------------------------------------------------
-- 19. Recreate views (dependency order: v_picks_filled first)
-- -------------------------------------------------------------

CREATE OR REPLACE VIEW v_picks_filled AS
SELECT
  pl.player_id,
  pl.tenant_id,
  pl.pigeon_number,
  g.game_id,
  g.week_number,
  COALESCE(p.picked_home, TRUE)   AS picked_home,
  COALESCE(p.predicted_margin, 0) AS predicted_margin,
  p.created_at,
  (p.game_id IS NOT NULL)         AS is_made
FROM players pl
CROSS JOIN games g
LEFT JOIN picks p
  ON p.player_id = pl.player_id
 AND p.game_id   = g.game_id;

CREATE OR REPLACE VIEW v_results AS
WITH base AS (
  SELECT
    pl.pigeon_name,
    pl.player_id,
    pl.tenant_id,
    pl.pigeon_number,
    g.week_number,
    g.game_id,
    format('%s @ %s', g.away_abbr, g.home_abbr)                                       AS game_name,
    CASE WHEN f.picked_home THEN f.predicted_margin ELSE -f.predicted_margin END       AS predicted_margin,
    (g.home_score - g.away_score)                                                      AS actual_margin,
    f.is_made
  FROM v_picks_filled f
  JOIN games   g  ON g.game_id   = f.game_id
  JOIN players pl ON pl.player_id = f.player_id
  WHERE g.kickoff_at <= now()
    AND g.home_score IS NOT NULL
    AND g.away_score IS NOT NULL
)
SELECT
  b.pigeon_name,
  b.player_id,
  b.tenant_id,
  b.pigeon_number,
  b.week_number,
  b.game_id,
  b.game_name,
  b.predicted_margin,
  b.actual_margin,
  ABS(b.predicted_margin - b.actual_margin)::INT AS diff,
  CASE
    WHEN b.is_made = FALSE                                           THEN 50
    WHEN SIGN(b.predicted_margin) = 0 AND SIGN(b.actual_margin) = 0 THEN 7
    WHEN SIGN(b.predicted_margin) <> SIGN(b.actual_margin)           THEN 7
    ELSE 0
  END::INT AS penalty,
  (ABS(b.predicted_margin - b.actual_margin)
   + CASE
       WHEN b.is_made = FALSE                                           THEN 100
       WHEN SIGN(b.predicted_margin) = 0 AND SIGN(b.actual_margin) = 0 THEN 7
       WHEN SIGN(b.predicted_margin) <> SIGN(b.actual_margin)           THEN 7
       ELSE 0
     END)::INT AS score
FROM base b;

CREATE OR REPLACE VIEW v_weekly_leaderboard AS
WITH totals AS (
  SELECT
    r.player_id,
    r.tenant_id,
    MIN(r.pigeon_name)   AS pigeon_name,
    MIN(r.pigeon_number) AS pigeon_number,
    r.week_number,
    SUM(r.score)::INT    AS score
  FROM v_results r
  GROUP BY r.player_id, r.tenant_id, r.week_number
),
ranked AS (
  SELECT
    t.*,
    RANK()   OVER (PARTITION BY t.tenant_id, t.week_number ORDER BY t.score)  AS rank,
    COUNT(*) OVER (PARTITION BY t.tenant_id, t.week_number, t.score)          AS tie_count
  FROM totals t
)
SELECT
  player_id,
  tenant_id,
  pigeon_number,
  pigeon_name,
  week_number,
  LEAST(score, 800) AS score,
  rank,
  (rank + (tie_count - 1) / 2.0)::numeric(10,1) AS points
FROM ranked;

CREATE OR REPLACE VIEW v_week_picks_with_names AS
SELECT
  pl.player_id,
  pl.tenant_id,
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
FROM v_picks_filled  f
JOIN games           g  ON g.game_id   = f.game_id
JOIN players         pl ON pl.player_id = f.player_id
JOIN tenant_weeks    tw ON tw.tenant_id = pl.tenant_id AND tw.week_number = g.week_number
WHERE tw.lock_at <= now();

CREATE OR REPLACE VIEW v_admin_week_picks_with_names AS
SELECT
  pl.player_id,
  pl.tenant_id,
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
JOIN games   g  ON g.game_id   = f.game_id
JOIN players pl ON pl.player_id = f.player_id;

-- -------------------------------------------------------------
-- Done
-- -------------------------------------------------------------
COMMIT;
