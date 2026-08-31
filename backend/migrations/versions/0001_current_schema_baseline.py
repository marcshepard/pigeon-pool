"""Current pre-Alembic application schema baseline.

Revision ID: 0001
Revises: None
Create Date: 2026-08-30

Existing desktop, laptop, and Azure databases must be enrolled with
``alembic stamp 0001`` only after passing ``verify-schema-baseline``.  This
upgrade is intentionally strict and is used to construct new empty databases.
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "0001"
down_revision: str | Sequence[str] | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Create the complete pre-Alembic schema in an empty database."""

    op.execute(
        """
        CREATE TABLE teams (
          abbr TEXT PRIMARY KEY,
          name TEXT NOT NULL
        )
        """
    )
    op.execute(
        """
        CREATE TABLE weeks (
          week_number     INT PRIMARY KEY CHECK (week_number BETWEEN 1 AND 18),
          default_lock_at TIMESTAMPTZ
        )
        """
    )
    op.execute(
        """
        CREATE TABLE games (
          game_id       BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          espn_event_id BIGINT UNIQUE,
          week_number   INT NOT NULL REFERENCES weeks(week_number) ON DELETE CASCADE,
          kickoff_at    TIMESTAMPTZ NOT NULL,
          home_abbr     TEXT NOT NULL REFERENCES teams(abbr),
          away_abbr     TEXT NOT NULL REFERENCES teams(abbr),
          status        TEXT NOT NULL CHECK (status IN ('scheduled','in_progress','final')),
          home_score    INT,
          away_score    INT,
          updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
          CONSTRAINT games_no_self CHECK (home_abbr <> away_abbr),
          CONSTRAINT games_unique_per_week UNIQUE (week_number, home_abbr, away_abbr)
        )
        """
    )
    op.execute("CREATE INDEX ix_games_week_status ON games (week_number, status)")
    op.execute("CREATE INDEX ix_games_kickoff ON games (kickoff_at)")

    op.execute(
        """
        CREATE TABLE tenants (
          tenant_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          name TEXT NOT NULL,
          pigeons_can_rename BOOLEAN NOT NULL DEFAULT true,
          picks_open BOOLEAN NOT NULL DEFAULT true
        )
        """
    )
    op.execute(
        """
        CREATE TABLE tenant_weeks (
          tenant_id BIGINT NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
          week_number INT NOT NULL REFERENCES weeks(week_number) ON DELETE CASCADE,
          lock_at TIMESTAMPTZ NOT NULL,
          PRIMARY KEY (tenant_id, week_number)
        )
        """
    )
    op.execute(
        r"""
        CREATE TABLE users (
          user_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          email TEXT NOT NULL
            CHECK (email ~* '^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$'),
          password_hash TEXT NOT NULL
        )
        """
    )
    op.execute("CREATE UNIQUE INDEX uniq_users_email_lower ON users ((lower(email)))")

    op.execute("CREATE SEQUENCE players_player_id_seq START WITH 1")
    op.execute(
        """
        CREATE TABLE players (
          player_id BIGINT NOT NULL PRIMARY KEY DEFAULT nextval('players_player_id_seq'),
          tenant_id BIGINT NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
          pigeon_number INT NOT NULL CHECK (pigeon_number >= 1),
          pigeon_name TEXT NOT NULL,
          season_status TEXT NOT NULL DEFAULT 'pending'
            CHECK (season_status IN ('pending','active','out')),
          commissioner_notes TEXT NOT NULL DEFAULT '',
          UNIQUE (tenant_id, pigeon_number),
          UNIQUE (tenant_id, pigeon_name)
        )
        """
    )
    op.execute(
        """
        CREATE TABLE user_players (
          user_id BIGINT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
          player_id BIGINT NOT NULL REFERENCES players(player_id) ON DELETE CASCADE,
          role TEXT NOT NULL DEFAULT 'owner' CHECK (role IN ('owner','manager','viewer')),
          PRIMARY KEY (user_id, player_id)
        )
        """
    )
    op.execute(
        """
        CREATE UNIQUE INDEX uniq_player_single_owner
          ON user_players(player_id)
          WHERE role = 'owner'
        """
    )
    op.execute(
        """
        CREATE TABLE tenant_members (
          tenant_id BIGINT NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
          user_id BIGINT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
          role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('commissioner','member')),
          primary_player_id BIGINT NOT NULL REFERENCES players(player_id),
          last_used_at TIMESTAMPTZ,
          PRIMARY KEY (tenant_id, user_id)
        )
        """
    )
    op.execute(
        """
        CREATE TABLE tenant_payouts (
          tenant_id BIGINT NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
          place INT NOT NULL CHECK (place >= 1),
          points INT NOT NULL CHECK (points >= 0),
          PRIMARY KEY (tenant_id, place)
        )
        """
    )
    op.execute(
        """
        CREATE TABLE picks (
          player_id BIGINT NOT NULL REFERENCES players(player_id) ON DELETE CASCADE,
          game_id BIGINT NOT NULL REFERENCES games(game_id) ON DELETE CASCADE,
          picked_home BOOLEAN NOT NULL,
          predicted_margin INT NOT NULL CHECK (predicted_margin >= 0),
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (player_id, game_id)
        )
        """
    )
    op.execute("CREATE INDEX ix_picks_game ON picks (game_id)")
    op.execute("CREATE INDEX ix_picks_player ON picks (player_id)")

    op.execute(
        """
        CREATE FUNCTION deny_picks_after_lock()
        RETURNS TRIGGER
        LANGUAGE plpgsql AS $$
        DECLARE
          is_locked BOOLEAN;
          bypass TEXT;
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
        END
        $$
        """
    )

    op.execute(
        """
        CREATE VIEW v_picks_filled AS
        SELECT
          pl.player_id,
          pl.tenant_id,
          pl.pigeon_number,
          g.game_id,
          g.week_number,
          COALESCE(p.picked_home, TRUE) AS picked_home,
          COALESCE(p.predicted_margin, 0) AS predicted_margin,
          p.created_at,
          (p.game_id IS NOT NULL) AS is_made
        FROM players pl
        CROSS JOIN games g
        LEFT JOIN picks p
          ON p.player_id = pl.player_id
         AND p.game_id = g.game_id
        """
    )
    op.execute(
        """
        CREATE VIEW v_results AS
        WITH base AS (
          SELECT
            pl.pigeon_name,
            pl.player_id,
            pl.tenant_id,
            pl.pigeon_number,
            g.week_number,
            g.game_id,
            format('%s @ %s', g.away_abbr, g.home_abbr) AS game_name,
            CASE WHEN f.picked_home THEN f.predicted_margin
                 ELSE -f.predicted_margin END AS predicted_margin,
            (g.home_score - g.away_score) AS actual_margin,
            f.is_made
          FROM v_picks_filled f
          JOIN games g ON g.game_id = f.game_id
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
            WHEN b.is_made = FALSE THEN 50
            WHEN SIGN(b.predicted_margin) = 0 AND SIGN(b.actual_margin) = 0 THEN 7
            WHEN SIGN(b.predicted_margin) <> SIGN(b.actual_margin) THEN 7
            ELSE 0
          END::INT AS penalty,
          (ABS(b.predicted_margin - b.actual_margin)
           + CASE
               WHEN b.is_made = FALSE THEN 100
               WHEN SIGN(b.predicted_margin) = 0 AND SIGN(b.actual_margin) = 0 THEN 7
               WHEN SIGN(b.predicted_margin) <> SIGN(b.actual_margin) THEN 7
               ELSE 0
             END)::INT AS score
        FROM base b
        """
    )
    op.execute(
        """
        CREATE VIEW v_weekly_leaderboard AS
        WITH totals AS (
          SELECT
            r.player_id,
            r.tenant_id,
            MIN(r.pigeon_name) AS pigeon_name,
            MIN(r.pigeon_number) AS pigeon_number,
            r.week_number,
            SUM(r.score)::INT AS score
          FROM v_results r
          GROUP BY r.player_id, r.tenant_id, r.week_number
        ),
        ranked AS (
          SELECT
            t.*,
            RANK() OVER (
              PARTITION BY t.tenant_id, t.week_number ORDER BY t.score
            ) AS rank,
            COUNT(*) OVER (
              PARTITION BY t.tenant_id, t.week_number, t.score
            ) AS tie_count
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
        FROM ranked
        """
    )
    op.execute(
        """
        CREATE VIEW v_week_picks_with_names AS
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
        JOIN games g ON g.game_id = f.game_id
        JOIN players pl ON pl.player_id = f.player_id
        JOIN tenant_weeks tw
          ON tw.tenant_id = pl.tenant_id AND tw.week_number = g.week_number
        WHERE tw.lock_at <= now()
        """
    )
    op.execute(
        """
        CREATE VIEW v_admin_week_picks_with_names AS
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
        JOIN games g ON g.game_id = f.game_id
        JOIN players pl ON pl.player_id = f.player_id
        """
    )

    op.execute(
        """
        CREATE TABLE scheduler_runs (
          job_name TEXT PRIMARY KEY,
          last_at TIMESTAMPTZ NOT NULL
        )
        """
    )
    op.execute(
        """
        CREATE TRIGGER trg_picks_insert_lock
          BEFORE INSERT ON picks
          FOR EACH ROW EXECUTE FUNCTION deny_picks_after_lock()
        """
    )
    op.execute(
        """
        CREATE TRIGGER trg_picks_update_lock
          BEFORE UPDATE ON picks
          FOR EACH ROW EXECUTE FUNCTION deny_picks_after_lock()
        """
    )
    op.execute(
        """
        CREATE TRIGGER trg_picks_delete_lock
          BEFORE DELETE ON picks
          FOR EACH ROW EXECUTE FUNCTION deny_picks_after_lock()
        """
    )


def downgrade() -> None:
    """Refuse to destroy the entire application schema."""

    raise RuntimeError(
        "The 0001 baseline cannot be downgraded safely; restore a disposable "
        "database or a reviewed backup instead."
    )
