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
from datetime import datetime

from sqlalchemy import bindparam, text
from sqlalchemy.ext.asyncio import AsyncSession

from .logger import info
from .score_sync import ScoreSync
from .emailer import send_bulk_email_bcc
from .settings import get_settings

#pylint: disable=line-too-long


# ---------------------------------------------------------------------
# Helper to get all emails (primary + secondary)
# ---------------------------------------------------------------------
async def get_all_player_emails(
    session: AsyncSession,
    pigeon_numbers: list[int] | None = None,
    include_viewers: bool = True,   # optional filter
) -> list[str]:
    """
    Return distinct emails for users mapped to pigeons.
    - If pigeon_numbers is None: all mapped users.
    - If provided: only users mapped to those pigeons.
    - include_viewers=False will exclude viewer-only accounts.
    """
    base_sql = """
        SELECT DISTINCT lower(u.email) AS email
          FROM user_players up
          JOIN users u ON u.user_id = up.user_id
    """

    params = {}
    filters = []

    if pigeon_numbers:
        # Use expanding bind param for portability
        filters.append("up.pigeon_number IN :nums")
        params["nums"] = tuple(set(int(n) for n in pigeon_numbers))
    if not include_viewers:
        filters.append("up.role IN ('owner','manager')")

    if filters:
        base_sql += " WHERE " + " AND ".join(filters)
    base_sql += " ORDER BY 1"

    q = text(base_sql)
    if "nums" in params:
        q = q.bindparams(bindparam("nums", expanding=True))

    rows = await session.execute(q, params)
    # Dedup + non-null guard (DISTINCT already helps)
    emails = [r[0] for r in rows if r[0]]
    return emails

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


    syncer = ScoreSync(session)
    changed = 0
    for wk in weeks_to_touch:
        changed += await syncer.refresh_kickoffs(wk)

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

    # Use async ScoreSync directly
    syncer = ScoreSync(session)
    updated = await syncer.sync_scores_and_status(week)

    # Log with timestamp and update count for monitoring
    now = datetime.now()
    time_str = now.strftime("%H:%M")
    info(
        "component=jobs",
        job="score_sync",
        time=time_str,
        week=week,
        games_updated=updated,
        message=f"Scores synced at {time_str} - {updated} game(s) updated",
    )
    return {"week": week, "games_updated": updated}


# ---------------------------------------------------------------------
# Sunday wrap-up email (content-only; recipients fetched here)
# ---------------------------------------------------------------------
async def run_email_sun(session: AsyncSession) -> dict[str, Any]:
    """
    Send the Sunday-night summary email to all players (BCC in email.py).
    Delays EMAIL_DELAY_MINUTES after SNF ends to allow frontend to refresh.
    """
    # Wait for configured delay (allows FE auto-refresh to pick up state change)
    delay_minutes = get_settings().email_delay_minutes
    if delay_minutes > 0:
        info(
            "component=jobs",
            job="email_sun",
            message=f"waiting {delay_minutes} minutes before sending email",
        )
        await asyncio.sleep(delay_minutes * 60)

    # current week = latest week already locked
    res = await session.execute(text("SELECT MAX(week_number) FROM weeks WHERE lock_at <= now()"))
    row = res.first()
    week = int(row[0]) if row and row[0] is not None else None

    emails = await get_all_player_emails(session)
    subject = f"Interim Results for week {week}"
    plain = (
        "To ALL Pigeons --\n\n"
        "The Week 6 Interim Results through Sunday are available at https://www.pigeonpool.com/picks-and-results.\n"
        "Outcomes for various MNF scores are available at https://www.pigeonpool.com/analytics?tab=1.\n\n"
        "--Andy (not really, as this email is automated from the pigeonpool app)"
    )
    html = (
        "<p>To ALL Pigeons --</p>"
        "<p>The Week 6 Interim Results through Sunday are available at https://www.pigeonpool.com/picks-and-results.</p>"
        "<p>Outcomes for various MNF scores are available at https://www.pigeonpool.com/analytics?tab=1.</p>"
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
    Delays EMAIL_DELAY_MINUTES after MNF ends to allow frontend to refresh.
    """
    # Wait for configured delay (allows FE auto-refresh to pick up state change)
    delay_minutes = get_settings().email_delay_minutes
    if delay_minutes > 0:
        info(
            "component=jobs",
            job="email_mon",
            message=f"waiting {delay_minutes} minutes before sending email",
        )
        await asyncio.sleep(delay_minutes * 60)

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

    emails = await get_all_player_emails(session)
    subject = f"Weekly {week} Results"
    plain = (
        "To ALL Pigeons --\n\n"
        f"Congratulations to {' and '.join(winners)} for the first place finish in Week {week}!\n"
        "The final results are available at https://www.pigeonpool.com/picks-and-results.\n"
        "The year-to-date cummulative scores are available at  https://www.pigeonpool.com/year-to-date.\n\n"
        "Don't forget to enter your picks in before the Tuesday's 5PM PST deadline at https://www.pigeonpool.com/enter-picks!\n\n"
        "--Andy (not really, as this email is automated from the pigeonpool app)"
    )
    html = (
        "<p>To ALL Pigeons --</p>"
        f"<p>Congratulations to <b>{' and '.join(winners)}</b> for the first place finish in Week {week}!</p>"
        "<p>The final results are available at <a href='https://www.pigeonpool.com/picks-and-results'>https://www.pigeonpool.com/picks-and-results</a>.</p>"
        "<p>The year-to-date cummulative scores are available at https://www.pigeonpool.com/year-to-date.</p>"
        "<p>Don't forget to enter your picks in before Tuesday's 5PM PST deadline at https://www.pigeonpool.com/enter-picks.</p>"
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
    q = text("""
WITH next_week AS (SELECT MIN(week_number) AS w FROM weeks WHERE lock_at > now())
SELECT DISTINCT pl.pigeon_number
FROM v_picks_filled f
JOIN players pl ON pl.pigeon_number = f.pigeon_number
JOIN games g ON g.game_id = f.game_id
WHERE f.is_made = FALSE
  AND g.week_number = (SELECT w FROM next_week)
ORDER BY pl.pigeon_number
""")
    rows = await session.execute(q)
    pigeon_numbers = [r[0] for r in rows]
    emails = await get_all_player_emails(session, pigeon_numbers)

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
        "Friendly Reminder"
        "It looks like you haven’t submitted all your picks for this week.\n"
        "I will leave the entry form open for another couple hours at https://www.pigeonpool.com/enter-picks.\n\n"
        "Good luck!"
        "--Andy (not really, as this email is automated from the pigeonpool app)"
    )
    html = (
        "<p>Friendly Reminder</p>"
        "<p>It looks like you haven’t submitted all your picks for this week.</p>"
        "<p>I will leave the entry form open for another couple hours at https://www.pigeonpool.com/enter-picks.</p>"
        "<p/>"
        "<p>Good luck!</p>"
        "<p>--Andy (not really, as this email is automated from the pigeonpool app)</p>"
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
