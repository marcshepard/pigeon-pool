"""Apply pending Alembic revisions before starting the backend.

The PostgreSQL advisory lock serializes upgrades if Azure starts more than one
App Service instance. The lock belongs to this database session and is released
automatically if the process exits unexpectedly.
"""

from __future__ import annotations

import time
from pathlib import Path
from typing import Any

import psycopg
from alembic import command
from alembic.config import Config

from backend.utils.settings import get_settings

_CONFIG_PATH = Path(__file__).resolve().parent / "alembic.ini"
_MIGRATION_LOCK_ID = 88_258_283_538_254  # Stable application-specific int64.
_LOCK_TIMEOUT_SECONDS = 300
_LOCK_POLL_SECONDS = 1


def _acquire_migration_lock(
    connection: Any, timeout_seconds: int = _LOCK_TIMEOUT_SECONDS
) -> None:
    """Wait for the application migration lock, failing after a bounded delay."""

    deadline = time.monotonic() + timeout_seconds
    with connection.cursor() as cursor:
        while True:
            cursor.execute(
                "SELECT pg_try_advisory_lock(%s)", (_MIGRATION_LOCK_ID,)
            )
            row = cursor.fetchone()
            if row is not None and row[0] is True:
                return
            if time.monotonic() >= deadline:
                raise TimeoutError(
                    "Timed out waiting for another database migration to finish."
                )
            time.sleep(_LOCK_POLL_SECONDS)


def _release_migration_lock(connection: Any) -> None:
    """Release the application migration lock held by this session."""

    with connection.cursor() as cursor:
        cursor.execute("SELECT pg_advisory_unlock(%s)", (_MIGRATION_LOCK_ID,))
        row = cursor.fetchone()
        if row is None or row[0] is not True:
            raise RuntimeError("Database migration lock was not held at release time.")


def upgrade_head() -> None:
    """Serialize and apply all pending migrations to the configured database."""

    settings = get_settings()
    target = f"{settings.pg_host}:{settings.pg_port}/{settings.pg_db}"
    print(f"[migrate] Target: {target}")
    print("[migrate] Waiting for the database migration lock...")

    try:
        connection = psycopg.connect(
            **settings.psycopg_kwargs(), autocommit=True
        )
    except psycopg.Error as exc:
        raise RuntimeError(
            f"Migration runner could not connect to PostgreSQL target {target} "
            f"({type(exc).__name__})."
        ) from None

    with connection:
        _acquire_migration_lock(connection)
        print("[migrate] Lock acquired; upgrading to head...")
        try:
            command.upgrade(Config(str(_CONFIG_PATH)), "head")
        finally:
            _release_migration_lock(connection)

    print("[migrate] Database is at Alembic head.")


def main() -> int:
    """Run the automatic migration phase."""

    upgrade_head()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
