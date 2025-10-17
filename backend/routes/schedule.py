"""
 Endpoint for retrieving scheduling info
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import List, Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from backend.utils.db import get_db

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

# ---------- Helpers ----------

def _is_locked(lock_at: datetime) -> bool:
    """ Is the week locked (i.e. lock_at is in the past) """
    return lock_at <= datetime.now(timezone.utc)


# ---------- Endpoints ----------

@router.get("/current_weeks", summary="Get current live and next-picks week numbers")
async def get_current_weeks(db: AsyncSession = Depends(get_db)):
    """ Next unlocked week (for entering picks) """
    next_row = (await db.execute(text("""
        SELECT week_number
        FROM weeks
        WHERE lock_at > now()
        ORDER BY lock_at ASC
        LIMIT 1
    """))).first()
    next_picks_week = next_row[0] if next_row else None

    # "Live" week = latest locked week started but not completed
    live_row = (await db.execute(text("""
        SELECT g.week_number
        FROM games g
        JOIN weeks w ON w.week_number = g.week_number
        WHERE w.lock_at <= now()
            AND EXISTS ( -- At least one game started
                    SELECT 1
                    FROM games g2
                    WHERE g2.week_number = g.week_number
                        AND g2.status IN ('in_progress', 'final')
            )
            AND EXISTS ( -- But not all games completed
                    SELECT 1
                    FROM games g3
                    WHERE g3.week_number = g.week_number
                        AND g3.status != 'final'
            )
        ORDER BY g.week_number DESC
        LIMIT 1
    """))).first()
    live_week = live_row[0] if live_row else None

    return {"next_picks_week": next_picks_week, "live_week": live_week}


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
