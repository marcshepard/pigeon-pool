"""
Admin-only endpoints for managing and viewing picks.
"""
from __future__ import annotations

from typing import List
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status, Body, Response

from pydantic import BaseModel

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from backend.utils.db import get_db
from backend.utils.logger import debug, info, warn
from .auth import require_user, require_admin
from .results import WeekPicksRow
from .schedule import get_current_week

#pylint: disable=line-too-long

router = APIRouter(prefix="/admin", tags=["admin"])

# SQL (reuse from results.py)
WEEK_PICKS_SQL = text("""
    SELECT
      pigeon_number,
      pigeon_name,
      game_id,
      week_number,
      picked_home,
      predicted_margin,
      home_abbr,
      away_abbr,
      kickoff_at,
      status,
      home_score,
      away_score
    FROM v_admin_week_picks_with_names
    WHERE week_number = :week
    ORDER BY pigeon_number, kickoff_at, game_id
""")

@router.get(
    "/weeks/{week}/picks",
    response_model=List[WeekPicksRow],
    summary="All picks + game metadata for a week (admin only)",
)
async def get_week_picks(
    week: int,
    db: AsyncSession = Depends(get_db),
    me=Depends(require_user),  # privacy: require auth
):
    """Return all players' picks for the given week, even if unlocked."""
    debug("admin: get_week_picks called", user=me.pigeon_number, week=week)
    if not getattr(me, "is_admin", False):
        warn("admin: non-admin attempted to access picks", user=me.pigeon_number, week=week)
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Admin access required",
        )

    rows = (await db.execute(WEEK_PICKS_SQL, {"week": week})).fetchall()
    info("admin: week picks rows", week=week, count=len(rows))

    out: List[WeekPicksRow] = []
    for r in rows:
        out.append(
            WeekPicksRow(
                pigeon_number=r[0],
                pigeon_name=r[1],
                game_id=r[2],
                week_number=r[3],
                picked_home=r[4],
                predicted_margin=r[5],
                home_abbr=r[6],
                away_abbr=r[7],
                kickoff_at=r[8].isoformat(),
                status=r[9],
                home_score=r[10],
                away_score=r[11],
            )
        )
    return out


# ---------------- Lock adjustment APIs ----------------
WEEK_EXISTS_SQL = text("""
    SELECT 1 FROM weeks WHERE week_number = :week
""")

FIRST_KICKOFF_SQL = text("""
    SELECT MIN(kickoff_at) FROM games WHERE week_number = :week
""")

UPDATE_LOCK_SQL = text("""
    UPDATE weeks SET lock_at = :lock_at WHERE week_number = :week
""")

WEEKS_LOCKS_SQL = text("""
    SELECT week_number, lock_at FROM weeks ORDER BY week_number
""")

class WeekLockRow(BaseModel):
    """ The lock time for a given week """
    week_number: int
    lock_at: datetime

@router.get(
    "/weeks/locks",
    response_model=List[WeekLockRow],
    summary="All weeks' lock times (admin only)",
)
async def get_weeks_locks(
    db: AsyncSession = Depends(get_db),
    me=Depends(require_admin),
):
    """Return each week number and its lock_at time."""
    debug("admin: get_weeks_locks called", user=me.pigeon_number)
    rows = (await db.execute(WEEKS_LOCKS_SQL)).fetchall()
    info("admin: weeks lock rows", count=len(rows))
    out: List[WeekLockRow] = []
    for r in rows:
        out.append(WeekLockRow(week_number=r[0], lock_at=r[1]))
    return out

@router.patch(
    "/weeks/{week}/lock",
    status_code=204,
    summary="Adjust lock time for a week (admin only)",
)
async def adjust_week_lock(
    week: int,
    db: AsyncSession = Depends(get_db),
    me=Depends(require_admin),
    lock_at: datetime = Body(..., embed=True, description="New lock time (RFC3339/ISO8601)"),
):
    """
    Adjust the lock time for the given week.

    Rules:
    - Only current or future weeks can be adjusted (no past weeks).
    - Current week can be adjusted only if its state is "scheduled" (no games started).
    - New lock time must be >= now and <= the first scheduled kickoff for that week.
    """
    debug("admin: adjust_week_lock called", user=me.pigeon_number, week=week)

    # Ensure week exists
    exists = (await db.execute(WEEK_EXISTS_SQL, {"week": week})).first()
    if not exists:
        raise HTTPException(status_code=404, detail=f"Week {week} not found")

    # Get current week number and status via schedule API
    current = await get_current_week(db)  # CurrentWeek model
    current_week = int(current.week)
    current_status = str(current.status)

    # Only allow current or future weeks (no past weeks)
    if week < current_week:
        raise HTTPException(status_code=400, detail="Cannot adjust a past week")

    # If adjusting the current playing week, ensure still scheduled
    if week == current_week and current_status != "scheduled":
        raise HTTPException(status_code=400, detail="Current week is not in 'scheduled' state")

    # Normalize input datetime to UTC-aware
    new_lock = lock_at
    if new_lock.tzinfo is None:
        new_lock = new_lock.replace(tzinfo=timezone.utc)
    else:
        new_lock = new_lock.astimezone(timezone.utc)

    # Fetch first kickoff for the requested week
    first_row = (await db.execute(FIRST_KICKOFF_SQL, {"week": week})).first()
    first_kickoff = first_row[0] if first_row else None
    if first_kickoff is None:
        raise HTTPException(status_code=400, detail=f"No games scheduled for week {week}")

    # Calculate the Tuesday before the first kickoff
    tuesday_before = first_kickoff.astimezone(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    # Go backwards to Tuesday
    tuesday_before = tuesday_before.replace(day=tuesday_before.day - ((tuesday_before.weekday() - 1) % 7))
    # Enforce time window: tuesday_before <= lock_at <= first_kickoff
    if new_lock < tuesday_before:
        raise HTTPException(status_code=400, detail="Lock time must be no earlier than the Tuesday before the first scheduled kickoff for that week")
    if new_lock > first_kickoff:
        raise HTTPException(status_code=400, detail="Lock time must be no later than the first scheduled kickoff for that week")

    # Perform the update
    await db.execute(UPDATE_LOCK_SQL, {"week": week, "lock_at": new_lock})
    await db.commit()
    info("admin: week lock updated", week=week, lock_at=new_lock.isoformat())
    return Response(status_code=204)
