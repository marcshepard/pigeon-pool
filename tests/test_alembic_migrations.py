"""End-to-end tests for constructing a database from Alembic base to head."""

from __future__ import annotations

from collections.abc import Generator
from pathlib import Path
from typing import Any
from uuid import uuid4

import psycopg
import pytest
from alembic import command
from alembic.config import Config
from psycopg import sql
from sqlalchemy import URL, create_engine, pool

from backend.utils.schema_baseline import verify_schema_baseline
from backend.utils.settings import get_settings

_REPO_ROOT = Path(__file__).resolve().parents[1]
_CONFIG_PATH = _REPO_ROOT / "backend" / "alembic.ini"
_TEMP_DB_PREFIX = "pigeon_pool_alembic_test_"
_LOCAL_DB_HOSTS = {"localhost", "127.0.0.1", "::1"}


@pytest.fixture(scope="module")
def empty_migration_database() -> Generator[str, None, None]:
    """Create and safely remove a uniquely named local PostgreSQL database."""

    settings = get_settings()
    if settings.pg_host.lower() not in _LOCAL_DB_HOSTS:
        pytest.skip("Alembic database creation tests run only against local PostgreSQL")

    database_name = f"{_TEMP_DB_PREFIX}{uuid4().hex[:12]}"
    admin_config = settings.psycopg_kwargs()
    admin_config["dbname"] = "postgres"

    with (
        psycopg.connect(**admin_config, autocommit=True) as admin_conn,
        admin_conn.cursor() as cur,
    ):
        cur.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(database_name)))

    try:
        yield database_name
    finally:
        if not database_name.startswith(_TEMP_DB_PREFIX):
            raise RuntimeError(f"Refusing to drop unexpected database: {database_name}")
        with (
            psycopg.connect(**admin_config, autocommit=True) as admin_conn,
            admin_conn.cursor() as cur,
        ):
            cur.execute(
                """
                SELECT pg_terminate_backend(pid)
                  FROM pg_stat_activity
                 WHERE datname = %s
                   AND pid <> pg_backend_pid()
                """,
                (database_name,),
            )
            cur.execute(
                sql.SQL("DROP DATABASE {}").format(sql.Identifier(database_name))
            )


def _database_config(database_name: str) -> dict[str, Any]:
    settings = get_settings()
    config: dict[str, object] = settings.psycopg_kwargs()
    config["dbname"] = database_name
    return config


def _upgrade_to_head(database_name: str) -> None:
    settings = get_settings()
    engine = create_engine(
        URL.create(
            drivername="postgresql+psycopg",
            username=settings.pg_user,
            password=settings.pg_password,
            host=settings.pg_host,
            port=settings.pg_port,
            database=database_name,
        ),
        poolclass=pool.NullPool,
    )
    try:
        config = Config(str(_CONFIG_PATH))
        with engine.begin() as connection:
            config.attributes["connection"] = connection
            command.upgrade(config, "head")
    finally:
        engine.dispose()


def test_empty_database_upgrades_to_baseline_and_accepts_relational_data(
    empty_migration_database,
):
    database_name = empty_migration_database

    _upgrade_to_head(database_name)
    _upgrade_to_head(database_name)  # A current database is a no-op.

    with psycopg.connect(**_database_config(database_name)) as conn:
        report = verify_schema_baseline(conn)
        assert report.is_valid, report.to_dict()
        assert report.alembic_table_present
        assert not report.reset_table_present

        with conn.cursor() as cur:
            cur.execute("SELECT version_num FROM alembic_version")
            assert cur.fetchone() == ("0001",)

            cur.execute(
                "INSERT INTO teams (abbr, name) VALUES ('HOM', 'Home'), ('AWY', 'Away')"
            )
            cur.execute(
                "INSERT INTO weeks (week_number, default_lock_at) "
                "VALUES (1, '2099-01-01 00:00:00+00')"
            )
            cur.execute("INSERT INTO tenants (name) VALUES ('Migration Test') RETURNING tenant_id")
            tenant_row = cur.fetchone()
            assert tenant_row is not None
            tenant_id = tenant_row[0]
            cur.execute(
                "INSERT INTO tenant_weeks (tenant_id, week_number, lock_at) "
                "VALUES (%s, 1, '2099-01-01 00:00:00+00')",
                (tenant_id,),
            )
            cur.execute(
                "INSERT INTO users (email, password_hash) "
                "VALUES ('migration@example.com', 'unusable') RETURNING user_id"
            )
            user_row = cur.fetchone()
            assert user_row is not None
            user_id = user_row[0]
            cur.execute(
                "INSERT INTO players (tenant_id, pigeon_number, pigeon_name) "
                "VALUES (%s, 1, 'Migration Pigeon') RETURNING player_id",
                (tenant_id,),
            )
            player_row = cur.fetchone()
            assert player_row is not None
            player_id = player_row[0]
            cur.execute(
                "INSERT INTO user_players (user_id, player_id, role) "
                "VALUES (%s, %s, 'owner')",
                (user_id, player_id),
            )
            cur.execute(
                "INSERT INTO tenant_members "
                "(tenant_id, user_id, role, primary_player_id) "
                "VALUES (%s, %s, 'commissioner', %s)",
                (tenant_id, user_id, player_id),
            )
            cur.execute(
                "INSERT INTO games "
                "(week_number, kickoff_at, home_abbr, away_abbr, status) "
                "VALUES (1, '2099-01-02 00:00:00+00', 'HOM', 'AWY', 'scheduled') "
                "RETURNING game_id"
            )
            game_row = cur.fetchone()
            assert game_row is not None
            game_id = game_row[0]
            cur.execute(
                "INSERT INTO picks (player_id, game_id, picked_home, predicted_margin) "
                "VALUES (%s, %s, true, 3)",
                (player_id, game_id),
            )
            cur.execute("SELECT COUNT(*) FROM v_admin_week_picks_with_names")
            assert cur.fetchone() == (1,)
