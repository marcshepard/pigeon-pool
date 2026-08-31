"""Tests for the serialized automatic Alembic runner."""

from __future__ import annotations

from contextlib import AbstractContextManager
from types import SimpleNamespace
from typing import Any

import pytest

from backend import migrate


class _FakeCursor(AbstractContextManager):
    def __init__(self, statements: list[tuple[str, tuple[int, ...]]]) -> None:
        self.statements = statements
        self._result: tuple[bool] | None = None

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return None

    def execute(self, statement: str, parameters: tuple[int, ...]) -> None:
        self.statements.append((statement, parameters))
        self._result = (True,)

    def fetchone(self) -> tuple[bool] | None:
        return self._result


class _FakeConnection(AbstractContextManager):
    def __init__(self) -> None:
        self.statements: list[tuple[str, tuple[int, ...]]] = []

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return None

    def cursor(self) -> _FakeCursor:
        return _FakeCursor(self.statements)


def test_upgrade_head_holds_advisory_lock_while_alembic_runs(monkeypatch) -> None:
    connection = _FakeConnection()
    calls: list[tuple[Any, str]] = []
    settings = SimpleNamespace(
        pg_host="localhost",
        pg_port=5432,
        pg_db="pigeon_pool",
        psycopg_kwargs=lambda: {
            "host": "localhost",
            "port": 5432,
            "dbname": "pigeon_pool",
            "user": "postgres",
            "password": "secret",
        },
    )

    monkeypatch.setattr(migrate, "get_settings", lambda: settings)
    monkeypatch.setattr(migrate.psycopg, "connect", lambda **_kwargs: connection)
    monkeypatch.setattr(
        migrate.command, "upgrade", lambda config, revision: calls.append((config, revision))
    )

    migrate.upgrade_head()

    assert [statement for statement, _ in connection.statements] == [
        "SELECT pg_try_advisory_lock(%s)",
        "SELECT pg_advisory_unlock(%s)",
    ]
    assert calls[0][1] == "head"
    assert calls[0][0].config_file_name == str(migrate._CONFIG_PATH)


def test_upgrade_head_releases_advisory_lock_when_alembic_fails(monkeypatch) -> None:
    connection = _FakeConnection()
    settings = SimpleNamespace(
        pg_host="localhost",
        pg_port=5432,
        pg_db="pigeon_pool",
        psycopg_kwargs=dict,
    )

    monkeypatch.setattr(migrate, "get_settings", lambda: settings)
    monkeypatch.setattr(migrate.psycopg, "connect", lambda **_kwargs: connection)

    def fail_upgrade(_config, _revision) -> None:
        raise RuntimeError("migration failed")

    monkeypatch.setattr(migrate.command, "upgrade", fail_upgrade)

    with pytest.raises(RuntimeError, match="migration failed"):
        migrate.upgrade_head()

    assert [statement for statement, _ in connection.statements] == [
        "SELECT pg_try_advisory_lock(%s)",
        "SELECT pg_advisory_unlock(%s)",
    ]
