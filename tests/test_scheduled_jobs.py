"""Focused tests for tenant-safe scheduled-job helpers."""

import asyncio
from datetime import UTC, datetime
from types import SimpleNamespace
from typing import cast
from unittest.mock import AsyncMock, Mock

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from backend.utils import scheduled_jobs, scheduler
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


@pytest.mark.parametrize("day, expected_player", [(13, 101), (14, 102), (15, None)])
def test_reminders_only_include_todays_unlocked_deadlines(db_conn, monkeypatch, day, expected_player):
    """Run both real SQL filters for Tuesday/Wednesday leagues without touching shared rows."""
    now = datetime(2026, 10, day, 17, tzinfo=scheduler.PST)
    session = AsyncMock(spec=AsyncSession)

    async def execute(query, params=None):
        sql = str(query).strip()
        assert sql.startswith("WITH ")
        # Deterministic input rows shadow the real tables/view for this query only.
        fixture = """
            WITH tenant_weeks(tenant_id, week_number, lock_at) AS (VALUES
                (101, 6, TIMESTAMPTZ '2026-10-14 06:59:00+00'),
                (102, 6, TIMESTAMPTZ '2026-10-15 06:59:00+00'),
                (101, 7, TIMESTAMPTZ '2026-10-21 06:59:00+00'),
                (102, 7, TIMESTAMPTZ '2026-10-22 06:59:00+00')),
            games(game_id, week_number) AS (VALUES (1, 6), (2, 7)),
            v_picks_filled(tenant_id, player_id, game_id, is_made) AS (VALUES
                (101, 101, 1, false), (102, 102, 1, false),
                (102, 103, 1, true), (101, 101, 2, false), (102, 102, 2, false)),
        """
        sql = sql[5:].replace("now()", f"TIMESTAMPTZ '{now.isoformat()}'")
        sql = sql.replace(":tid", "%(tid)s")
        with db_conn.cursor() as cur:
            cur.execute(fixture + sql, params)
            rows = cur.fetchall()
        return Mock(all=Mock(return_value=rows), first=Mock(return_value=rows[0] if rows else None))

    session.execute.side_effect = execute
    monkeypatch.setattr(scheduled_jobs, "_get_all_tenants", AsyncMock(return_value=[
        (101, "Tuesday Pool"), (102, "Hawk Pool"),
    ]))

    async def emails(_session, player_ids):
        return [f"{pid}@test.invalid" for pid in player_ids]

    monkeypatch.setattr(scheduled_jobs, "get_all_player_emails", emails)
    send = Mock(return_value=True)
    monkeypatch.setattr(scheduled_jobs, "send_bulk_email_bcc", send)

    assert asyncio.run(scheduler._missing_picks_exist(session)) == (expected_player is not None)
    result = asyncio.run(scheduled_jobs.run_email_tue_warn(session))

    if expected_player is None:
        send.assert_not_called()
        assert result["recipients"] == 0
    else:
        send.assert_called_once()
        recipients, _, plain, html = send.call_args.args
        assert recipients == [f"{expected_player}@test.invalid"]
        expected_day = "Tuesday, Oct 13" if day == 13 else "Wednesday, Oct 14"
        assert f"{expected_day} at 11:59 PM PDT" in plain
        assert f"{expected_day} at 11:59 PM PDT" in html


@pytest.mark.parametrize("day, hour, last_day, expected", [
    (13, 16, None, False),  # Before the reminder hour.
    (13, 17, None, True),
    (14, 16, 13, False),
    (14, 17, 13, True),  # Tuesday's completion must not suppress Wednesday.
    (14, 18, 14, False),  # Repeated heartbeat/restart must not resend today.
])
def test_reminder_scheduler_runs_once_per_deadline_day(monkeypatch, day, hour, last_day, expected):
    now = datetime(2026, 10, day, hour, tzinfo=scheduler.PST)
    last = datetime(2026, 10, last_day, 17, tzinfo=scheduler.PST).astimezone(UTC) if last_day else None
    session = AsyncMock(spec=AsyncSession)
    context = AsyncMock()
    context.__aenter__.return_value = session
    monkeypatch.setattr(scheduler, "AsyncSessionLocal", lambda: context)
    monkeypatch.setattr(scheduler, "_now_pst", lambda: now)
    monkeypatch.setattr(scheduler, "_now_utc", lambda: now.astimezone(UTC))
    monkeypatch.setattr(scheduler, "TUE_WARNING_HOUR", 17)

    async def last_run(_session, job):
        return last if job == "email_tue_warn" else now

    monkeypatch.setattr(scheduler, "_get_last_run", last_run)
    run = AsyncMock()
    monkeypatch.setattr(scheduler, "_maybe_run", run)
    # Cancel after exactly one coordinator heartbeat.
    monkeypatch.setattr(scheduler.asyncio, "sleep", AsyncMock(side_effect=asyncio.CancelledError))
    with pytest.raises(asyncio.CancelledError):
        asyncio.run(scheduler._coordinator_loop())

    reminders = [call for call in run.await_args_list if call.args[1] == "email_tue_warn"]
    assert len(reminders) == int(expected)
    if expected:
        assert reminders[0].args[3:] == (scheduled_jobs.run_email_tue_warn, scheduler._missing_picks_exist)


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
