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
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

from sqlalchemy import bindparam, text
from sqlalchemy.ext.asyncio import AsyncSession

from .logger import info
from .score_sync import ScoreSync
from .emailer import send_bulk_email_bcc
from .settings import get_settings

#pylint: disable=line-too-long

PT = ZoneInfo("America/Los_Angeles")

def _format_lock_pt(lock_utc: datetime) -> str:
    """Format a UTC lock datetime in Pacific Time, e.g. 'Wednesday, Sep 10 at 11:59 PM PDT'."""
    lock_pt = lock_utc.astimezone(PT)
    hour = lock_pt.hour % 12 or 12
    ampm = "AM" if lock_pt.hour < 12 else "PM"
    return f"{lock_pt.strftime('%A, %b')} {lock_pt.day} at {hour}:{lock_pt.minute:02d} {ampm} {lock_pt.strftime('%Z')}"


# ---------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------

async def _get_all_tenants(session: AsyncSession) -> list[tuple[int, str]]:
    """Return [(tenant_id, name), ...] for all tenants."""
    rows = await session.execute(text("SELECT tenant_id, name FROM tenants ORDER BY tenant_id"))
    return [(r[0], r[1]) for r in rows.fetchall()]


async def _get_tenant_emails(session: AsyncSession, tenant_id: int) -> list[str]:
    """Return distinct emails for all members of a tenant."""
    rows = await session.execute(text("""
        SELECT DISTINCT lower(u.email)
          FROM tenant_members tm
          JOIN users u ON u.user_id = tm.user_id
         WHERE tm.tenant_id = :tenant_id
           AND u.email IS NOT NULL AND u.email != ''
         ORDER BY 1
    """), {"tenant_id": tenant_id})
    return [r[0] for r in rows.fetchall() if r[0]]


async def get_all_player_emails(
    session: AsyncSession,
    player_ids: list[int] | None = None,
    include_viewers: bool = True,
) -> list[str]:
    """
    Return distinct emails for users mapped to players.
    - If player_ids is None: all mapped users.
    - If provided: only users mapped to those players.
    - include_viewers=False will exclude viewer-only accounts.
    """
    base_sql = """
        SELECT DISTINCT lower(u.email) AS email
          FROM user_players up
          JOIN users u ON u.user_id = up.user_id
    """

    params = {}
    filters = []

    if player_ids:
        filters.append("up.player_id IN :nums")
        params["nums"] = tuple(set(int(n) for n in player_ids))
    if not include_viewers:
        filters.append("up.role IN ('owner','manager')")

    if filters:
        base_sql += " WHERE " + " AND ".join(filters)
    base_sql += " ORDER BY 1"

    q = text(base_sql)
    if "nums" in params:
        q = q.bindparams(bindparam("nums", expanding=True))

    rows = await session.execute(q, params)
    return [r[0] for r in rows if r[0]]


# ---------------------------------------------------------------------
# Kickoff sync (global, no tenant scoping needed)
# ---------------------------------------------------------------------
async def run_kickoff_sync(session: AsyncSession) -> dict[str, Any]:
    """
    Daily task: refresh kickoff_at for current week and next week across all tenants.
    Uses the minimum unlocked week across all tenant_weeks as the anchor.
    """
    res = await session.execute(
        text("SELECT MIN(week_number) FROM tenant_weeks WHERE lock_at > now()")
    )
    row = res.first()
    current_week = row[0] if row and row[0] is not None else None

    if current_week is None:
        info("component=jobs", job="kickoff_sync", weeks=[], kickoffs_updated=0,
             note="no current week (nothing to refresh)")
        return {"weeks": [], "kickoffs_updated": 0, "note": "no current week"}

    weeks_to_touch: list[int] = [int(current_week)]
    if current_week < 18:
        weeks_to_touch.append(int(current_week) + 1)

    syncer = ScoreSync(session)
    changed = 0
    for wk in weeks_to_touch:
        changed += await syncer.refresh_kickoffs(wk)

    info("component=jobs", job="kickoff_sync", weeks=weeks_to_touch,
         kickoffs_updated=changed, message="kickoff refresh complete")
    return {"weeks": weeks_to_touch, "kickoffs_updated": changed}


# ---------------------------------------------------------------------
# Score polling (interval while games are live)
# ---------------------------------------------------------------------
async def run_poll_scores(session: AsyncSession) -> dict[str, Any]:
    """Poll live scores for the current week (global across all tenants)."""
    res = await session.execute(text(
        "SELECT MAX(week_number) FROM tenant_weeks WHERE lock_at <= now()"
    ))
    row = res.first()
    if not row or row[0] is None:
        info("component=jobs", job="score_sync", week=None, games_updated=0, note="no current week")
        return {"updated": 0, "note": "no current week"}
    week = int(row[0])

    syncer = ScoreSync(session)
    updated = await syncer.sync_scores_and_status(week)

    now = datetime.now()
    time_str = now.strftime("%H:%M")
    info("component=jobs", job="score_sync", time=time_str, week=week,
         games_updated=updated, message=f"Scores synced at {time_str} - {updated} game(s) updated")
    return {"week": week, "games_updated": updated}


# ---------------------------------------------------------------------
# Sunday wrap-up email — one email per tenant
# ---------------------------------------------------------------------
async def run_email_sun(session: AsyncSession) -> dict[str, Any]:
    """
    Send the Sunday-night summary email, one per tenant.
    Each email is scoped to the tenant's current locked week and member list.
    """
    delay_minutes = get_settings().email_delay_minutes
    if delay_minutes > 0:
        info("component=jobs", job="email_sun",
             message=f"waiting {delay_minutes} minutes before sending email")
        await asyncio.sleep(delay_minutes * 60)

    tenants = await _get_all_tenants(session)
    total_recipients = 0
    total_sent = 0

    for tenant_id, tenant_name in tenants:
        res = await session.execute(text(
            "SELECT MAX(week_number) FROM tenant_weeks WHERE tenant_id = :tid AND lock_at <= now()"
        ), {"tid": tenant_id})
        row = res.first()
        week = int(row[0]) if row and row[0] is not None else None
        if week is None:
            continue

        emails = await _get_tenant_emails(session, tenant_id)
        if not emails:
            continue

        subject = f"[{tenant_name}] Interim Results for week {week}"
        plain = (
            f"To ALL {tenant_name} Pigeons --\n\n"
            f"The Week {week} Interim Results through Sunday are available at https://www.pigeonpool.com/picks-and-results.\n"
            "Outcomes for various MNF scores are available at https://www.pigeonpool.com/analytics?tab=1.\n\n"
            f"--{tenant_name}"
        )
        html = (
            f"<p>To ALL {tenant_name} Pigeons --</p>"
            f"<p>The Week {week} Interim Results through Sunday are available at "
            "<a href='https://www.pigeonpool.com/picks-and-results'>https://www.pigeonpool.com/picks-and-results</a>.</p>"
            "<p>Outcomes for various MNF scores are available at "
            "<a href='https://www.pigeonpool.com/analytics?tab=1'>https://www.pigeonpool.com/analytics?tab=1</a>.</p>"
            f"<p>--{tenant_name}</p>"
        )

        ok = await asyncio.to_thread(send_bulk_email_bcc, emails, subject, plain, html)
        total_recipients += len(emails)
        total_sent += 1 if ok else 0

        info("component=jobs", job="email_sun", tenant_id=tenant_id,
             recipients=len(emails), sent=bool(ok))

    return {"tenants": len(tenants), "total_recipients": total_recipients, "emails_sent": total_sent}


# ---------------------------------------------------------------------
# Monday wrap-up email — one email per tenant
# ---------------------------------------------------------------------
async def run_email_mon(session: AsyncSession) -> dict[str, Any]:
    """
    Send the Monday-night wrap-up email, one per tenant.
    Includes the week winner and next-week deadline for each tenant.
    """
    delay_minutes = get_settings().email_delay_minutes
    if delay_minutes > 0:
        info("component=jobs", job="email_mon",
             message=f"waiting {delay_minutes} minutes before sending email")
        await asyncio.sleep(delay_minutes * 60)

    tenants = await _get_all_tenants(session)
    total_recipients = 0
    total_sent = 0

    for tenant_id, tenant_name in tenants:
        res = await session.execute(text(
            "SELECT MAX(week_number) FROM tenant_weeks WHERE tenant_id = :tid AND lock_at <= now()"
        ), {"tid": tenant_id})
        row = res.first()
        week = int(row[0]) if row and row[0] is not None else None
        if week is None:
            continue

        winners_res = await session.execute(text("""
            SELECT pigeon_name, score
              FROM v_weekly_leaderboard
             WHERE tenant_id = :tid AND week_number = :week AND rank = 1
             ORDER BY score, pigeon_name
        """), {"tid": tenant_id, "week": week})
        winners = [r[0] for r in winners_res.all()]

        next_lock_res = await session.execute(text(
            "SELECT lock_at FROM tenant_weeks WHERE tenant_id = :tid AND lock_at > now() ORDER BY lock_at LIMIT 1"
        ), {"tid": tenant_id})
        next_lock_row = next_lock_res.first()
        deadline_str = (
            _format_lock_pt(next_lock_row[0].replace(tzinfo=timezone.utc) if next_lock_row[0].tzinfo is None else next_lock_row[0])
            if next_lock_row else "the upcoming deadline"
        )

        emails = await _get_tenant_emails(session, tenant_id)
        if not emails:
            continue

        subject = f"[{tenant_name}] Week {week} Results"
        winner_str = " and ".join(winners) if winners else "the winner"
        plain = (
            f"To ALL {tenant_name} Pigeons --\n\n"
            f"Congratulations to {winner_str} for the first place finish in Week {week}!\n"
            "The final results are available at https://www.pigeonpool.com/picks-and-results.\n"
            "The year-to-date cumulative scores are available at https://www.pigeonpool.com/year-to-date.\n\n"
            f"Don't forget to enter your picks before the deadline: {deadline_str}.\n\n"
            f"--{tenant_name}"
        )
        html = (
            f"<p>To ALL {tenant_name} Pigeons --</p>"
            f"<p>Congratulations to <b>{winner_str}</b> for the first place finish in Week {week}!</p>"
            "<p>The final results are available at "
            "<a href='https://www.pigeonpool.com/picks-and-results'>https://www.pigeonpool.com/picks-and-results</a>.</p>"
            "<p>The year-to-date cumulative scores are available at "
            "<a href='https://www.pigeonpool.com/year-to-date'>https://www.pigeonpool.com/year-to-date</a>.</p>"
            f"<p>Don't forget to enter your picks before the deadline: {deadline_str}.</p>"
            f"<p>--{tenant_name}</p>"
        )

        ok = await asyncio.to_thread(send_bulk_email_bcc, emails, subject, plain, html)
        total_recipients += len(emails)
        total_sent += 1 if ok else 0

        info("component=jobs", job="email_mon", tenant_id=tenant_id,
             week=week, recipients=len(emails), sent=bool(ok))

    return {"tenants": len(tenants), "total_recipients": total_recipients, "emails_sent": total_sent}


# ---------------------------------------------------------------------
# Tuesday reminder email — one pass per tenant
# ---------------------------------------------------------------------
async def run_email_tue_warn(session: AsyncSession) -> dict[str, Any]:
    """
    Send a Tuesday warning email to players who haven't submitted all picks
    for the upcoming week, one pass per tenant.
    """
    tenants = await _get_all_tenants(session)
    total_recipients = 0
    total_sent = 0

    for tenant_id, tenant_name in tenants:
        rows = await session.execute(text("""
            WITH next_week AS (
                SELECT MIN(week_number) AS w, MIN(lock_at) AS lock_at
                  FROM tenant_weeks
                 WHERE tenant_id = :tid AND lock_at > now()
            )
            SELECT DISTINCT f.player_id, (SELECT lock_at FROM next_week) AS lock_at
              FROM v_picks_filled f
              JOIN games g ON g.game_id = f.game_id
             WHERE f.is_made = FALSE
               AND f.tenant_id = :tid
               AND g.week_number = (SELECT w FROM next_week)
             ORDER BY f.player_id
        """), {"tid": tenant_id})
        rows_list = rows.all()
        player_ids = [r[0] for r in rows_list]
        lock_at_raw = rows_list[0][1] if rows_list else None
        deadline_str = (
            _format_lock_pt(lock_at_raw.replace(tzinfo=timezone.utc) if lock_at_raw and lock_at_raw.tzinfo is None else lock_at_raw)
            if lock_at_raw else "the upcoming deadline"
        )

        emails = await get_all_player_emails(session, player_ids)
        if not emails:
            continue

        subject = f"[{tenant_name}] Reminder: Enter Your Picks"
        plain = (
            "Friendly Reminder\n\n"
            "It looks like you haven't submitted your picks for this week. "
            f"Please make sure to get them in before the pick entry deadline: {deadline_str}.\n\n"
            "Good luck!\n"
            f"--{tenant_name}"
        )
        html = (
            "<p><b>Friendly Reminder</b></p>"
            "<p>It looks like you haven't submitted your picks for this week. "
            f"Please make sure to get them in before the pick entry deadline: {deadline_str}.</p>"
            "<p>Good luck!</p>"
            f"<p>--{tenant_name}</p>"
        )

        ok = await asyncio.to_thread(send_bulk_email_bcc, emails, subject, plain, html)
        total_recipients += len(emails)
        total_sent += 1 if ok else 0

        info("component=jobs", job="email_tue_warn", tenant_id=tenant_id,
             recipients=len(emails), sent=bool(ok))

    if total_recipients == 0:
        info("component=jobs", job="email_tue_warn", recipients=0, sent=True,
             note="no missing picks across any tenant")
        return {"recipients": 0, "sent": True, "note": "no missing picks"}

    return {"tenants": len(tenants), "total_recipients": total_recipients, "emails_sent": total_sent}
