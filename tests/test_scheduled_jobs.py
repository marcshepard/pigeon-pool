"""Focused tests for tenant-safe scheduled-job helpers."""

import asyncio
from datetime import UTC, datetime
from types import SimpleNamespace
from typing import cast
from unittest.mock import AsyncMock, Mock

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from backend.utils import scheduled_jobs
from backend.utils.scheduled_jobs import get_all_player_emails


class _NeverExecuteSession:
    async def execute(self, *_args, **_kwargs):
        raise AssertionError("An empty player scope must not execute an unfiltered query")


def test_empty_player_scope_returns_no_email_recipients():
    session = cast(AsyncSession, _NeverExecuteSession())

    recipients = asyncio.run(get_all_player_emails(session, []))

    assert recipients == []


def test_disabled_tuesday_reminders_skip_email_work(db_conn, test_data, monkeypatch):
    """Use the real tenant selection SQL and prove disabled leagues never reach email work."""
    db_conn.rollback()
    session = AsyncMock(spec=AsyncSession)

    async def execute(query):
        with db_conn.cursor() as cur:
            cur.execute(str(query))
            return Mock(fetchall=Mock(return_value=cur.fetchall()))

    session.execute.side_effect = execute
    recipients = AsyncMock()
    send = Mock()
    monkeypatch.setattr(scheduled_jobs, "get_all_player_emails", recipients)
    monkeypatch.setattr(scheduled_jobs, "send_bulk_email_bcc", send)
    try:
        # Transactional change rolls back, including preferences in non-test leagues.
        with db_conn.cursor() as cur:
            cur.execute("UPDATE tenants SET tuesday_reminders_enabled = false")
        all_tenants = asyncio.run(scheduled_jobs._get_all_tenants(session))
        assert test_data["tenant_a_id"] in {tid for tid, _ in all_tenants}
        assert test_data["tenant_b_id"] in {tid for tid, _ in all_tenants}
        result = asyncio.run(scheduled_jobs.run_email_tue_warn(session))
        assert result["recipients"] == 0
        recipients.assert_not_awaited()
        send.assert_not_called()
        with db_conn.cursor() as cur:
            cur.execute(
                "UPDATE tenants SET tuesday_reminders_enabled = true WHERE tenant_id = %s",
                (test_data["tenant_b_id"],),
            )
        enabled = asyncio.run(scheduled_jobs._get_all_tenants(session, tuesday_reminders_only=True))
        assert enabled == [(test_data["tenant_b_id"], "_Test League B")]
    finally:
        db_conn.rollback()


@pytest.mark.parametrize(
    "tenant_id, lock_at, expected_deadline",
    [
        (1, datetime(2026, 10, 7, 2, 30, tzinfo=UTC), "Tuesday, Oct 6 at 5 PM Pacific Time"),
        (1, datetime(2026, 10, 7, 2, 30, tzinfo=UTC).replace(tzinfo=None), "Tuesday, Oct 6 at 5 PM Pacific Time"),
        (2, datetime(2026, 10, 7, 2, 30, tzinfo=UTC), "Tuesday, Oct 6 at 7:30 PM PDT"),
        (1, None, "5 PM Pacific Time"),
        (2, None, "the upcoming deadline"),
    ],
)
def test_monday_email_next_week_reminder(monkeypatch, tenant_id, lock_at, expected_deadline):
    session = AsyncMock(spec=AsyncSession)
    session.execute.side_effect = [
        Mock(first=Mock(return_value=(4,))),
        Mock(all=Mock(return_value=[("Winner", 10)])),
        Mock(first=Mock(return_value=(lock_at,) if lock_at else None)),
    ]
    monkeypatch.setattr(scheduled_jobs, "get_settings", lambda: SimpleNamespace(email_delay_minutes=0))
    monkeypatch.setattr(
        scheduled_jobs, "_get_all_tenants", AsyncMock(return_value=[(tenant_id, "Test League")])
    )
    monkeypatch.setattr(
        scheduled_jobs, "_get_tenant_emails", AsyncMock(return_value=["member@test.invalid"])
    )
    send = Mock(return_value=True)
    monkeypatch.setattr(scheduled_jobs, "send_bulk_email_bcc", send)

    result = asyncio.run(scheduled_jobs.run_email_mon(session))

    send.assert_called_once()
    _, subject, plain, html = send.call_args.args
    assert subject == "[Test League] Week 4 Results"
    reminder = f"Don't forget to enter next weeks picks before the deadline: {expected_deadline}."
    assert reminder in plain
    assert f"<p>{reminder}</p>" in html
    assert result["emails_sent"] == 1


@pytest.mark.parametrize("week", [6, 18, None])
def test_kickoff_refresh_uses_one_unfinished_week(monkeypatch, week):
    session = AsyncMock(spec=AsyncSession)
    session.execute.return_value = Mock(scalar=Mock(return_value=week))
    syncer = Mock(refresh_kickoffs=AsyncMock(return_value=3))
    factory = Mock(return_value=syncer)
    monkeypatch.setattr(scheduled_jobs, "ScoreSync", factory)

    result = asyncio.run(scheduled_jobs.run_kickoff_sync(session))

    assert result["weeks"] == ([] if week is None else [week])
    assert result["kickoffs_updated"] == (0 if week is None else 3)
    if week is None:
        factory.assert_not_called()
    else:
        syncer.refresh_kickoffs.assert_awaited_once_with(week)
    assert str(session.execute.call_args.args[0]) == (
        "SELECT MIN(week_number) FROM games WHERE status <> 'final'"
    )


@pytest.mark.parametrize("statuses, expected", [
    (["final", "scheduled", "scheduled"], 7),
    (["final", "in_progress", "scheduled"], 7),
    (["final", "final", "scheduled"], 8),
    (["final", "final", "final"], None),
])
def test_kickoff_week_selection_uses_game_completion(db_conn, monkeypatch, statuses, expected):
    """Exercise the job's selection SQL on deterministic rows without editing shared games."""
    session = AsyncMock(spec=AsyncSession)
    syncer = Mock(refresh_kickoffs=AsyncMock(return_value=0))
    monkeypatch.setattr(scheduled_jobs, "ScoreSync", Mock(return_value=syncer))
    async def execute(query):
        # Substitute a local CTE for games while retaining the actual selection query.
        with db_conn.cursor() as cur:
            cur.execute(
                "WITH games(week_number, status) AS (VALUES (6, %s), (7, %s), (8, %s)) " + str(query),
                tuple(statuses),
            )
            return Mock(scalar=Mock(return_value=cur.fetchone()[0]))

    session.execute.side_effect = execute
    result = asyncio.run(scheduled_jobs.run_kickoff_sync(session))
    assert result["weeks"] == ([] if expected is None else [expected])
    if expected is None:
        syncer.refresh_kickoffs.assert_not_awaited()
    else:
        syncer.refresh_kickoffs.assert_awaited_once_with(expected)
