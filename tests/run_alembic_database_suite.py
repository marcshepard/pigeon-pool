"""Run the backend suite against a disposable Alembic-built database.

Invoke from the repository root:

    python tests/run_alembic_database_suite.py

The runner refuses non-local PostgreSQL hosts and only drops the uniquely
named database that it creates itself.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path
from uuid import uuid4

import psycopg
import pytest
from alembic import command
from alembic.config import Config
from psycopg import sql
from sqlalchemy import URL, create_engine, pool

_REPO_ROOT = Path(__file__).resolve().parents[1]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from backend.utils import settings as settings_module

_CONFIG_PATH = _REPO_ROOT / "backend" / "alembic.ini"
_TEMP_DB_PREFIX = "pigeon_pool_alembic_suite_"
_LOCAL_DB_HOSTS = {"localhost", "127.0.0.1", "::1"}
_TEST_TEAMS = (
    ("KC", "Kansas City"),
    ("BUF", "Buffalo"),
    ("LAR", "Los Angeles Rams"),
    ("SF", "San Francisco"),
    ("TB", "Tampa Bay"),
    ("NO", "New Orleans"),
)


def _upgrade(database_name: str) -> None:
    settings = settings_module.get_settings()
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


def _seed_reference_data(database_name: str) -> None:
    settings = settings_module.get_settings()
    database_config = settings.psycopg_kwargs()
    database_config["dbname"] = database_name
    with psycopg.connect(**database_config) as conn, conn.cursor() as cur:
        cur.executemany("INSERT INTO teams (abbr, name) VALUES (%s, %s)", _TEST_TEAMS)
        cur.execute(
            "INSERT INTO weeks (week_number) SELECT generate_series(1, 18)"
        )
        # Existing development databases reserve tenant 1 for the legacy Andy
        # integration. Test tenants must receive later IDs so tenant-1-only
        # behavior is neither invoked nor mistaken for general commissioner
        # behavior.
        cur.execute("INSERT INTO tenants (name) VALUES ('_Migration Tenant 1 Placeholder')")
        # The shared fixtures expect Week 17 to contain a slate, not a single
        # game, when checking partial-pick submission status.
        cur.execute(
            """
            INSERT INTO games
              (week_number, kickoff_at, home_abbr, away_abbr, status)
            VALUES
              (17, '2099-09-01 20:00:00+00', 'TB', 'NO', 'scheduled'),
              (17, '2099-09-02 20:00:00+00', 'KC', 'BUF', 'scheduled')
            """
        )


def main() -> int:
    settings = settings_module.get_settings()
    if settings.pg_host.lower() not in _LOCAL_DB_HOSTS:
        print(
            "Refusing to create a migration test database on non-local host "
            f"{settings.pg_host}.",
            file=sys.stderr,
        )
        return 2

    database_name = f"{_TEMP_DB_PREFIX}{uuid4().hex[:12]}"
    admin_config = settings.psycopg_kwargs()
    admin_config["dbname"] = "postgres"
    print(f"[alembic-suite] Creating local database {database_name}")

    with (
        psycopg.connect(**admin_config, autocommit=True) as admin_conn,
        admin_conn.cursor() as cur,
    ):
        cur.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(database_name)))

    original_loader = settings_module._load_env_files
    try:
        _upgrade(database_name)
        _seed_reference_data(database_name)

        def _load_test_environment() -> None:
            original_loader()
            os.environ["POSTGRES_DB"] = database_name

        settings_module._load_env_files = _load_test_environment
        settings_module.reset_settings_cache()
        print(f"[alembic-suite] Running pytest against {database_name}")
        return int(pytest.main([str(_REPO_ROOT / "tests")]))
    finally:
        settings_module._load_env_files = original_loader
        settings_module.reset_settings_cache()
        if not database_name.startswith(_TEMP_DB_PREFIX):
            raise RuntimeError(f"Refusing to drop unexpected database: {database_name}")
        print(f"[alembic-suite] Dropping local database {database_name}")
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


if __name__ == "__main__":
    raise SystemExit(main())
