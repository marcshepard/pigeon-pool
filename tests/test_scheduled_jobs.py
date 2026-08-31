"""Focused tests for tenant-safe scheduled-job helpers."""

import asyncio
from typing import cast

from sqlalchemy.ext.asyncio import AsyncSession

from backend.utils.scheduled_jobs import get_all_player_emails


class _NeverExecuteSession:
    async def execute(self, *_args, **_kwargs):
        raise AssertionError("An empty player scope must not execute an unfiltered query")


def test_empty_player_scope_returns_no_email_recipients():
    session = cast(AsyncSession, _NeverExecuteSession())

    recipients = asyncio.run(get_all_player_emails(session, []))

    assert recipients == []
