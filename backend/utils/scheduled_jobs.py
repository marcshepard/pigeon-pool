"""
utils/scheduled_jobs.py

Actual job implementations invoked by scheduler.py.
Each function is async and returns a small dict summary for scheduler logs.
ScoreSync is synchronous, so we run it in a worker thread with a raw psycopg
connection to avoid SQLAlchemy async/greenlet issues.
"""

from __future__ import annotations

import asyncio
from typing import Any

import psycopg
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from .logger import info
from .settings import get_settings
from .score_sync import ScoreSync
from .email import send_bulk_email_bcc  # top-level import per request

#pylint: disable=line-too-long

_SETTINGS = get_settings()

# ---------------------------------------------------------------------
# Kickoff sync (daily) — refresh *current + next* week kickoffs only
# ---------------------------------------------------------------------

async def run_kickoff_sync(session: AsyncSession) -> dict[str, Any]:
    """
    Daily task:
      - Find the current unlocked week.
      - Refresh kickoff_at for current week and next week (if any).
    Returns: {"weeks": [w, w+1?], "kickoffs_updated": n}
    """
    res = await session.execute(
        text("SELECT MIN(week_number) FROM weeks WHERE lock_at > now()")
    )
    row = res.first()
    current_week = row[0] if row and row[0] is not None else None

    if current_week is None:
        # Log daily even if we have nothing to do (useful in preseason or before bootstrap).
        info(
            "component=jobs",
            job="kickoff_sync",
            weeks=[],
            kickoffs_updated=0,
            note="no current week (nothing to refresh)",
        )
        return {"weeks": [], "kickoffs_updated": 0, "note": "no current week"}

    weeks_to_touch: list[int] = [int(current_week)]
    if current_week < 18:
        weeks_to_touch.append(int(current_week) + 1)

    def _work() -> int:
        total = 0
        with psycopg.connect(**_SETTINGS.psycopg_kwargs()) as conn:
            syncer = ScoreSync(conn)
            for wk in weeks_to_touch:
                total += syncer.refresh_kickoffs(wk)
        return total

    changed = await asyncio.to_thread(_work)

    # Always log once per day so you can see the heartbeat of this job.
    info(
        "component=jobs",
        job="kickoff_sync",
        weeks=weeks_to_touch,
        kickoffs_updated=changed,
        message="kickoff refresh complete",
    )
    return {"weeks": weeks_to_touch, "kickoffs_updated": changed}


# ---------------------------------------------------------------------
# Score polling (interval while games are live)
# ---------------------------------------------------------------------

async def run_poll_scores(session: AsyncSession) -> dict[str, Any]:
    """
    Poll live scores and status for the current week.
    Uses AsyncSession only to fetch the current week; ScoreSync runs in a thread.
    """
    res = await session.execute(text(
        "SELECT MAX(week_number) FROM weeks WHERE lock_at <= now()"
    ))
    row = res.first()
    if not row or row[0] is None:
        info("component=jobs", job="score_sync", week=None, games_updated=0, note="no current week")
        return {"updated": 0, "note": "no current week"}
    week = int(row[0])

    def _work() -> int:
        with psycopg.connect(**_SETTINGS.psycopg_kwargs()) as conn:
            return ScoreSync(conn).sync_scores_and_status(week)

    updated = await asyncio.to_thread(_work)

    # Log only when we actually ran (scheduler already guards with predicate).
    info(
        "component=jobs",
        job="score_sync",
        week=week,
        games_updated=updated,
        message="scores synced",
    )
    return {"week": week, "games_updated": updated}


# ---------------------------------------------------------------------
# Sunday wrap-up email (content-only; recipients fetched here)
# ---------------------------------------------------------------------

async def run_email_sun(session: AsyncSession) -> dict[str, Any]:
    """
    Send the Sunday-night summary email to all players (BCC in email.py).
    """
    rows = await session.execute(text("SELECT email FROM players ORDER BY pigeon_number"))
    emails = [r[0] for r in rows]
    # current week = latest week already locked
    res = await session.execute(text("SELECT MAX(week_number) FROM weeks WHERE lock_at <= now()"))
    row = res.first()
    week = int(row[0]) if row and row[0] is not None else None

    subject = f"Interim Results for week {week}"
    plain = (
        "To ALL Pigeons --\n\n"
        "The Week 6 Interim Results through Sunday are available at https://www.pigeonpool.com/picksheet.\n"
        "Outcomes for various MNF scores are available at https://www.pigeonpool.com/mnf-outcomes.\n\n"
        "--Andy (not really, as this email is automated from the pigeonpool app)"
    )
    html = (
        "<p>To <b>ALL Pigeons</b> --</p>"
        "<p>The Week 6 Interim Results through Sunday are available at "
        "<a href='https://www.pigeonpool.com/picksheet'>https://www.pigeonpool.com/picksheet</a>.</p>"
        "<p>Outcomes for various MNF scores are available at "
        "<a href='https://www.pigeonpool.com/mnf-outcomes'>https://www.pigeonpool.com/mnf-outcomes</a>.</p>"
        "<p>--Andy (not really, as this email is automated from the pigeonpool app)</p>"
    )

    ok = await asyncio.to_thread(send_bulk_email_bcc, emails, subject, plain, html)

    info(
        "component=jobs",
        job="email_sun",
        recipients=len(emails),
        sent=bool(ok),
        message="sunday wrap attempted",
    )
    return {"recipients": len(emails), "sent": bool(ok)}


# ---------------------------------------------------------------------
# Monday wrap-up email
# ---------------------------------------------------------------------

async def run_email_mon(session: AsyncSession) -> dict[str, Any]:
    """
    Send the Monday-night wrap-up email to all players (BCC in email.py).
    """
    rows = await session.execute(text("SELECT email FROM players ORDER BY pigeon_number"))
    emails = [r[0] for r in rows]

    # current week = latest week already locked
    res = await session.execute(text("SELECT MAX(week_number) FROM weeks WHERE lock_at <= now()"))
    row = res.first()
    week = int(row[0]) if row and row[0] is not None else None

    # winners
    # fetch winners (one or many if tie)
    winners = await session.execute(text("""
        WITH w AS (
        SELECT MAX(week_number) AS w
        FROM weeks
        WHERE lock_at <= now()
        )
        SELECT pigeon_name, score
        FROM v_weekly_leaderboard
        WHERE week_number = (SELECT w FROM w)
        AND rank = 1
        ORDER BY score, pigeon_name
    """))
    winners = [r[0] for r in winners.all()]

    subject = f"Weekly {week} Results"
    plain = (
        "To ALL Pigeons --\n\n"
        f"Congratulations to {' and '.join(winners)} for the first place finish in Week {week}!\n"
        "The final results are available at https://www.pigeonpool.com/picksheet.\n"
        "The year-to-date summulative scores are available at  https://www.pigeonpool.com/mnf-outcomes.\n\n"
        "Don't forget to enter your picks for next week before the Tuesday midnight deadline at https://www.pigeonpool.com/picks!\n\n"
        "--Andy (not really, as this email is automated from the pigeonpool app)"
    )
    html = (
        "<p>To <b>ALL Pigeons</b> --</p>"
        f"<p>Congratulations to <b>{' and '.join(winners)}</b> for the first place finish in Week {week}!</p>"
        "<p>The final results are available at "
        "<a href='https://www.pigeonpool.com/picksheet'>https://www.pigeonpool.com/picksheet</a>.</p>"
        "<p>The year-to-date summulative scores are available at "
        "<a href='https://www.pigeonpool.com/mnf-outcomes'>https://www.pigeonpool.com/mnf-outcomes</a>.</p>"
        "<p>Don't forget to enter your picks for next week before the Tuesday midnight deadline at "
        "<a href='https://www.pigeonpool.com/picks'>https://www.pigeonpool.com/picks</a>!</p>"
        "<p>--Andy (not really, as this email is automated from the pigeonpool app)</p>"
    )

    ok = await asyncio.to_thread(send_bulk_email_bcc, emails, subject, plain, html)

    info(
        "component=jobs",
        job="email_mon",
        recipients=len(emails),
        sent=bool(ok),
        message="monday wrap attempted",
    )
    return {"recipients": len(emails), "sent": bool(ok)}


# ---------------------------------------------------------------------
# Tuesday reminder email (only to users missing picks)
# ---------------------------------------------------------------------

async def run_email_tue_warn(session: AsyncSession) -> dict[str, Any]:
    """
    Send a Tuesday warning email to players who haven't submitted all picks
    for the upcoming (next unlocked) week.
    """
    q = text(
        """
        WITH next_week AS (SELECT MIN(week_number) AS w FROM weeks WHERE lock_at > now())
        SELECT DISTINCT pl.email
        FROM v_picks_filled f
        JOIN players pl ON pl.pigeon_number = f.pigeon_number
        JOIN games g ON g.game_id = f.game_id
        WHERE f.is_made = FALSE
          AND g.week_number = (SELECT w FROM next_week)
        ORDER BY pl.email
        """
    )
    rows = await session.execute(q)
    emails = [r[0] for r in rows]

    if not emails:
        info(
            "component=jobs",
            job="email_tue_warn",
            recipients=0,
            sent=True,
            note="no missing picks",
            message="tuesday warning skipped",
        )
        return {"recipients": 0, "sent": True, "note": "no missing picks"}

    subject = "Pigeon Pool Reminder: Enter Your Picks"
    plain = (
        "Hi! It looks like you haven’t submitted all your picks for this week.\n"
        "Please log in and enter them before tonight’s deadline.\n\n"
        "Good luck!"
    )
    html = (
        "<h2>Friendly Reminder</h2>"
        "<p>It looks like you haven’t submitted all your picks for this week.</p>"
        "<p>Please log in and enter them before tonight’s deadline.</p>"
        "<p>Good luck!</p>"
    )

    ok = await asyncio.to_thread(send_bulk_email_bcc, emails, subject, plain, html)

    info(
        "component=jobs",
        job="email_tue_warn",
        recipients=len(emails),
        sent=bool(ok),
        message="tuesday warning attempted",
    )
    return {"recipients": len(emails), "sent": bool(ok)}
