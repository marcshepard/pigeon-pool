"""
utils/scheduler.py

Lightweight in-app scheduler for the Pigeon Pool backend.
---------------------------------------------------------
* Quiet 1-minute heartbeat loop (no per-minute logs)
* Fixed, known jobs: kickoff_sync, score_sync, email_sun, email_mon, email_tue_warn
* Uses scheduler_runs table for idempotence
* Uses Postgres advisory locks to avoid concurrent runs
* Calendar logic based on America/Los_Angeles time (PST)
"""

from __future__ import annotations

import asyncio
import time
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from .db import AsyncSessionLocal
from .logger import info, error
from .settings import get_settings
from .scheduled_jobs import (
    run_kickoff_sync,
    run_poll_scores,
    run_email_sun,
    run_email_mon,
    run_email_tue_warn,
)

#pylint: disable=line-too-long

# -------------------------------------------------------------------
# Configuration
# -------------------------------------------------------------------

_SETTINGS = get_settings()
PST = ZoneInfo("America/Los_Angeles")

HEARTBEAT_SECONDS = _SETTINGS.heartbeat_seconds
LIVE_POLL_SECONDS = _SETTINGS.live_poll_seconds
KICKOFF_SYNC_HOUR = _SETTINGS.kickoff_sync_hour
TUE_WARNING_HOUR = _SETTINGS.tue_warning_hour

# -------------------------------------------------------------------
# Utilities
# -------------------------------------------------------------------

def _now_pst() -> datetime:
    """Return current time in PST."""
    return datetime.now(PST)

def _now_utc() -> datetime:
    """Timezone-aware UTC 'now' (use for DB and interval deltas)."""
    return datetime.now(timezone.utc)

def _start_of_local_week_sun(dt: datetime) -> datetime:
    """Return Sunday 00:00 of current local week."""
    dow = (dt.weekday() + 1) % 7  # Sunday = 0
    return dt.replace(hour=0, minute=0, second=0, microsecond=0) - timedelta(days=dow)


def _local_monday_start(dt: datetime) -> datetime:
    return _start_of_local_week_sun(dt) + timedelta(days=1)


def _local_tuesday_start(dt: datetime) -> datetime:
    return _start_of_local_week_sun(dt) + timedelta(days=2)


def _job_key(job_name: str) -> int:
    """Stable integer for advisory locking."""
    return abs(hash(job_name)) % (2**31)


async def _get_last_run(session: AsyncSession, job: str):
    res = await session.execute(
        text("SELECT last_at FROM scheduler_runs WHERE job_name=:j"),
        {"j": job},
    )
    row = res.first()
    return row[0] if row else None


async def _touch_last_run(session: AsyncSession, job: str):
    await session.execute(
        text(
            """
            INSERT INTO scheduler_runs (job_name,last_at)
            VALUES (:j, now())
            ON CONFLICT (job_name)
            DO UPDATE SET last_at=EXCLUDED.last_at
            """
        ),
        {"j": job},
    )
    await session.commit()

# -------------------------------------------------------------------
# Predicates
# -------------------------------------------------------------------

async def _any_live_games(session: AsyncSession) -> bool:
    q = text(
        """
        SELECT 1 FROM games
        WHERE kickoff_at <= now() AND status <> 'final'
        LIMIT 1
        """
    )
    res = await session.execute(q)
    return res.first() is not None


async def _all_sun_games_final_and_week_not_done(session: AsyncSession) -> bool:
    q = text("""
    WITH current_week AS (
      SELECT MAX(week_number) AS w
      FROM weeks
      WHERE lock_at <= now()
    )
    SELECT
      (NOT EXISTS (
        SELECT 1
        FROM games
        WHERE week_number = (SELECT w FROM current_week)
          AND EXTRACT(ISODOW FROM (kickoff_at AT TIME ZONE 'America/Los_Angeles')) = 7  -- Sunday (ISO: Mon=1..Sun=7)
          AND status <> 'final'
      ))
      AND EXISTS (
        SELECT 1
        FROM games
        WHERE week_number = (SELECT w FROM current_week)
          AND status <> 'final'
      )
    """)
    res = await session.execute(q)
    return bool(res.scalar())

async def _all_games_final(session: AsyncSession) -> bool:
    # current week = latest locked week
    q = text(
        """
        WITH current_week AS (
          SELECT MAX(week_number) AS w
          FROM weeks
          WHERE lock_at <= now()
        )
        SELECT NOT EXISTS (
          SELECT 1
          FROM games
          WHERE week_number = (SELECT w FROM current_week)
            AND status <> 'final'
        )
        """
    )
    res = await session.execute(q)
    return bool(res.scalar())


async def _missing_picks_exist(session: AsyncSession) -> bool:
    q = text(
        """
        WITH next_week AS (SELECT MIN(week_number) AS w FROM weeks WHERE lock_at > now())
        SELECT 1
        FROM v_picks_filled f
        JOIN games g ON g.game_id=f.game_id
        WHERE f.is_made=FALSE
          AND g.week_number=(SELECT w FROM next_week)
        LIMIT 1
        """
    )
    res = await session.execute(q)
    return res.first() is not None

# -------------------------------------------------------------------
# Core job runner
# -------------------------------------------------------------------

async def _advisory_lock(session: AsyncSession, key: int) -> bool:
    res = await session.execute(text("SELECT pg_try_advisory_lock(:k)"), {"k": key})
    return bool(res.scalar())


async def _advisory_unlock(session: AsyncSession, key: int):
    await session.execute(text("SELECT pg_advisory_unlock(:k)"), {"k": key})


async def _maybe_run(session: AsyncSession, job_name: str, due: bool, run_fn, predicate=None):
    """Run a job if due and predicate returns True."""
    if not due:
        return

    lock_key = _job_key(job_name)
    if not await _advisory_lock(session, lock_key):
        return

    try:
        if predicate and not await predicate(session):
            return

        start_ns = time.perf_counter_ns()
        try:
            result = await run_fn(session)
            await _touch_last_run(session, job_name)
            dur = (time.perf_counter_ns() - start_ns) // 1_000_000
            info(
                "component=scheduler",
                job=job_name,
                now_local=_now_pst().isoformat(),
                duration_ms=dur,
                result=result,
                message="run ok",
            )
        except Exception as ex:  # pylint: disable=broad-except
            dur = (time.perf_counter_ns() - start_ns) // 1_000_000
            error(
                "component=scheduler",
                job=job_name,
                now_local=_now_pst().isoformat(),
                duration_ms=dur,
                err_type=type(ex).__name__,
                err=str(ex),
                message="run failed",
            )
    finally:
        await _advisory_unlock(session, lock_key)

# -------------------------------------------------------------------
# Main loop
# -------------------------------------------------------------------

_SCHEDULER_TASK: asyncio.Task | None = None  # conforms to UPPER_CASE for constant-like globals


async def _coordinator_loop():
    """
    Main heartbeat loop.
    Evaluates each job and runs when due.
    """
    while True:
        now_loc = _now_pst()
        try:
            async with AsyncSessionLocal() as session:
                # kickoff_sync (daily)
                if now_loc.hour >= KICKOFF_SYNC_HOUR:
                    last_run = await _get_last_run(session, "kickoff_sync")
                    if not last_run or last_run.astimezone(PST).date() != now_loc.date():
                        await _maybe_run(session, "kickoff_sync", True, run_kickoff_sync)

                # score_sync (interval)
                last_score = await _get_last_run(session, "score_sync")
                due_score = (
                    not last_score
                    or (_now_utc() - last_score.astimezone(timezone.utc)).total_seconds() >= LIVE_POLL_SECONDS
                )
                await _maybe_run(session, "score_sync", due_score, run_poll_scores, _any_live_games)

                # email_sun
                if now_loc.weekday() == 6 and now_loc.hour >= 18:
                    last_sun = await _get_last_run(session, "email_sun")
                    gate = _start_of_local_week_sun(now_loc)
                    if not last_sun or last_sun.astimezone(PST) < gate:
                        await _maybe_run(
                            session,
                            "email_sun",
                            True,
                            run_email_sun,
                            _all_sun_games_final_and_week_not_done,
                        )

                # email_mon
                if now_loc.weekday() == 0 and now_loc.hour >= 18:
                    last_mon = await _get_last_run(session, "email_mon")
                    gate = _local_monday_start(now_loc)
                    if not last_mon or last_mon.astimezone(PST) < gate:
                        await _maybe_run(session, "email_mon", True, run_email_mon, _all_games_final)

                # email_tue_warn
                if now_loc.weekday() == 1 and now_loc.hour >= TUE_WARNING_HOUR:
                    last_warn = await _get_last_run(session, "email_tue_warn")
                    gate = _local_tuesday_start(now_loc)
                    if not last_warn or last_warn.astimezone(PST) < gate:
                        await _maybe_run(
                            session,
                            "email_tue_warn",
                            True,
                            run_email_tue_warn,
                            _missing_picks_exist,
                        )

        except Exception as ex:  # pylint: disable=broad-except
            error(
                "component=scheduler",
                job="loop",
                now_local=now_loc.isoformat(),
                err_type=type(ex).__name__,
                err=str(ex),
                message="loop error",
            )

        await asyncio.sleep(HEARTBEAT_SECONDS)

# -------------------------------------------------------------------
# Public interface
# -------------------------------------------------------------------

def start_scheduler() -> None:
    """Start the background scheduler task (non-blocking)."""
    global _SCHEDULER_TASK  # pylint: disable=global-statement
    if _SCHEDULER_TASK and not _SCHEDULER_TASK.done():
        return
    loop = asyncio.get_event_loop()
    _SCHEDULER_TASK = loop.create_task(_coordinator_loop())
    info(
        "component=scheduler",
        event="bootstrap",
        now_local=_now_pst().isoformat(),
        message="scheduler started",
    )


async def stop_scheduler() -> None:
    """Stop the scheduler task gracefully."""
    global _SCHEDULER_TASK  # pylint: disable=global-statement
    if not _SCHEDULER_TASK:
        return
    _SCHEDULER_TASK.cancel()
    try:
        await _SCHEDULER_TASK
    except asyncio.CancelledError:
        pass
    _SCHEDULER_TASK = None
    info(
        "component=scheduler",
        event="bootstrap",
        now_local=_now_pst().isoformat(),
        message="scheduler stopped",
    )
