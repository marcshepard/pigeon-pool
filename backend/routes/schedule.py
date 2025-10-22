"""
 Endpoint for retrieving scheduling info
"""

from __future__ import annotations

from datetime import datetime
from typing import List, Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from backend.utils.db import get_db

#pylint: disable=line-too-long

router = APIRouter(prefix="/schedule", tags=["schedule"])

# ---------- Models ----------

class WeekOut(BaseModel):
    """ Basic info about a week """
    week_number: int = Field(..., ge=1, le=18)
    lock_at: datetime
    is_locked: bool

class GameOut(BaseModel):
    """ Basic info about a game """
    game_id: int
    week_number: int
    kickoff_at: datetime
    home_abbr: str
    away_abbr: str
    status: str
    home_score: Optional[int] = None
    away_score: Optional[int] = None

class PickLite(BaseModel):
    """ Lightweight pick info for board view """
    game_id: int
    picked_home: bool
    predicted_margin: int

class CurrentWeek(BaseModel):
    """ Current scheduling state """
    week: int
    status: str  # "scheduled" | "in_progress" | "final"

# ---------- SQL ----------

CURRENT_WEEK_SQL = text("""
    SELECT week_number, lock_at
    FROM weeks
    WHERE lock_at > now()
    ORDER BY lock_at ASC
    LIMIT 1
""")

WEEK_BY_NUMBER_SQL = text("""
    SELECT week_number, lock_at
    FROM weeks
    WHERE week_number = :week_number
""")

GAMES_FOR_WEEK_SQL = text("""
    SELECT game_id, week_number, kickoff_at, home_abbr, away_abbr, status, home_score, away_score
    FROM games
    WHERE week_number = :week_number
    ORDER BY kickoff_at, game_id
""")

MY_PICKS_FOR_WEEK_SQL = text("""
    SELECT p.game_id, p.picked_home, p.predicted_margin
    FROM picks p
    JOIN games g ON g.game_id = p.game_id
    WHERE p.pigeon_number = :pigeon_number
      AND g.week_number = :week_number
""")


# ---------- Endpoints ----------


@router.get("/current_week", response_model=CurrentWeek, summary="Get current live and next-picks week numbers")
async def get_current_week(db: AsyncSession = Depends(get_db)):
    """ Next unlocked week (for entering picks) """
    next_row = (await db.execute(text("""
        SELECT week_number
        FROM weeks
        WHERE lock_at < now()
        ORDER BY lock_at DESC
        LIMIT 1
    """))).first()

    current_week = next_row[0] if (next_row and next_row[0] > 1) else 1

    # Get all games for current_week
    games_result = await db.execute(text("""
        SELECT status FROM games WHERE week_number = :week_number
    """), {"week_number": current_week})
    game_statuses = [row[0] for row in games_result.fetchall()]

    if not game_statuses:
        status = "scheduled"
    elif all(s == "final" for s in game_statuses):
        status = "final"
    elif all(s == "scheduled" for s in game_statuses):
        status = "scheduled"
    else:
        status = "in_progress"

    return CurrentWeek(
        week=current_week,
        status=status,
    )


@router.get("/{week_number}/games", response_model=List[GameOut], summary="List games for a week")
async def get_games_for_week(week_number: int, db: AsyncSession = Depends(get_db)):
    """ List all games scheduled for a given week """
    result = await db.execute(GAMES_FOR_WEEK_SQL, {"week_number": week_number})
    rows = result.fetchall()
    return [
        GameOut(
            game_id=r[0],
            week_number=r[1],
            kickoff_at=r[2],
            home_abbr=r[3],
            away_abbr=r[4],
            status=r[5],
            home_score=r[6],
            away_score=r[7],
        )
        for r in rows
    ]
