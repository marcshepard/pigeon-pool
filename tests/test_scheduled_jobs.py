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
