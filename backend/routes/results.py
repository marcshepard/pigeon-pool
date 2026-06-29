"""
Read-only results & standings APIs.

Endpoints (all require authentication):
- GET /results/weeks/{week}/picks
    Return all picks for a locked week, joined with game metadata (+ pigeon_name).
- GET /results/weeks/{week}/leaderboard
    Return leaderboard (score + rank + pigeon_name) for a locked week.
- GET /results/leaderboard
    Return leaderboard rows for all locked weeks.

Notes:
- "Locked" means tenant_weeks.lock_at <= now(); we never reveal picks for unlocked weeks.
- v_picks_filled supplies default (home, 0) rows for missing picks.
- v_weekly_leaderboard already ignores not-started games and includes pigeon_name.
- v_week_picks_with_names already filters to locked weeks (belt-and-suspenders privacy).
- All views and queries are filtered by tenant_id (from the authenticated user).
"""
# pylint: disable=line-too-long

from __future__ import annotations

from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from backend.utils.db import get_db
from backend.utils.logger import debug, info, warn
from .auth import require_user


router = APIRouter(prefix="/results", tags=["results"])


# =============================================================================
# Models
# =============================================================================

class PoolInfo(BaseModel):
    pigeon_count: int


class WeekPicksRow(BaseModel):
    """Pick row joined with game metadata for a specific locked week."""
    pigeon_number: int
    pigeon_name: str
    game_id: int
    week_number: int
    picked_home: bool
    predicted_margin: int
    home_abbr: str
    away_abbr: str
    kickoff_at: str
    status: str
    home_score: Optional[int] = None
    away_score: Optional[int] = None


class LeaderboardRow(BaseModel):
    """Leaderboard row for a particular week (lower score is better)."""
    pigeon_number: int
    pigeon_name: str
    week_number: int = Field(..., ge=1, le=18)
    score: int
    rank: int
    points: float


class YtdByWeek(BaseModel):
    """Per-week breakdown used in YTD responses."""
    week_number: int = Field(..., ge=1, le=18)
    score: int
    rank: int
    points: float

class YtdRow(BaseModel):
    """Aggregated YTD stats across all locked weeks for a player."""
    pigeon_number: int
    pigeon_name: str
    by_week: List[YtdByWeek]

# =============================================================================
# SQL
# =============================================================================

# Cheap guard: ensure the requested week is locked for this tenant.
WEEK_LOCKED_SQL = text("""
    SELECT 1
    FROM tenant_weeks
    WHERE tenant_id = :tenant_id
      AND week_number = :week
      AND lock_at <= now()
    LIMIT 1
""")

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
    FROM v_week_picks_with_names
    WHERE week_number = :week
      AND tenant_id = :tenant_id
    ORDER BY pigeon_number, kickoff_at, game_id
""")

WEEK_LEADERBOARD_SQL = text("""
    SELECT
      pigeon_number,
      pigeon_name,
      week_number,
      score,
      rank,
      points
    FROM v_weekly_leaderboard
    WHERE week_number = :week
      AND tenant_id = :tenant_id
    ORDER BY rank ASC, score ASC, pigeon_number ASC
""")

ALL_LOCKED_LEADERBOARD_SQL = text("""
    SELECT
      v.pigeon_number,
      v.pigeon_name,
      v.week_number,
      v.score,
      v.rank,
      v.points
    FROM v_weekly_leaderboard v
    JOIN tenant_weeks tw ON tw.tenant_id = v.tenant_id AND tw.week_number = v.week_number
    WHERE v.tenant_id = :tenant_id
      AND tw.lock_at <= now()
    ORDER BY v.week_number ASC, v.rank ASC, v.score ASC, v.pigeon_number ASC
""")


# =============================================================================
# Helpers
# =============================================================================

async def _ensure_week_locked(db: AsyncSession, week: int, tenant_id: int) -> None:
    """Raise 409 if the target week is not locked yet for this tenant."""
    res = await db.execute(WEEK_LOCKED_SQL, {"week": week, "tenant_id": tenant_id})
    if not res.first():
        warn("results: week not locked", week=week, tenant_id=tenant_id)
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Week {week} is not locked yet",
        )


# =============================================================================
# Endpoints
# =============================================================================

@router.get(
    "/pool-info",
    response_model=PoolInfo,
    summary="Active pigeon count for this tenant",
)
async def get_pool_info(
    db: AsyncSession = Depends(get_db),
    me=Depends(require_user),
):
    """Return the number of active pigeons in the tenant."""
    res = await db.execute(
        text("SELECT COUNT(*) FROM players WHERE tenant_id = :tid"),
        {"tid": me.tenant_id},
    )
    return PoolInfo(pigeon_count=res.scalar() or 0)


@router.get(
    "/weeks/{week}/picks",
    response_model=List[WeekPicksRow],
    summary="All picks + game metadata for a locked week",
)
async def get_week_picks(
    week: int,
    db: AsyncSession = Depends(get_db),
    me=Depends(require_user),  # privacy: require auth
):
    """Return all players' picks for the given locked week, plus game info (includes pigeon_name)."""
    debug("results: get_week_picks called", user=me.pigeon_number, week=week)
    await _ensure_week_locked(db, week, me.tenant_id)

    rows = (await db.execute(WEEK_PICKS_SQL, {"week": week, "tenant_id": me.tenant_id})).fetchall()
    info("results: week picks rows", week=week, count=len(rows))

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


@router.get(
    "/weeks/{week}/leaderboard",
    response_model=List[LeaderboardRow],
    summary="Leaderboard (score + rank + pigeon_name) for a locked week",
)
async def get_week_leaderboard(
    week: int,
    db: AsyncSession = Depends(get_db),
    me=Depends(require_user),
):
    """
    Return leaderboard rows for the given locked week, including pigeon_name.
    The view already excludes not-started games, so this works mid-week as a live board.
    """
    debug("results: get_week_leaderboard called", user=me.pigeon_number, week=week)
    await _ensure_week_locked(db, week, me.tenant_id)

    rows = (await db.execute(WEEK_LEADERBOARD_SQL, {"week": week, "tenant_id": me.tenant_id})).fetchall()
    info("results: week leaderboard rows", week=week, count=len(rows))

    return [
        LeaderboardRow(
            pigeon_number=r[0],
            pigeon_name=r[1],
            week_number=r[2],
            score=r[3],
            rank=r[4],
            points=r[5],
        )
        for r in rows
    ]


@router.get(
    "/leaderboard",
    response_model=List[LeaderboardRow],
    summary="Leaderboard rows across all locked weeks (includes pigeon_name)",
)
async def get_all_locked_leaderboards(
    db: AsyncSession = Depends(get_db),
    me=Depends(require_user),
):
    """Return concatenated leaderboard rows for all locked weeks (pigeon_name included)."""
    debug("results: get_all_locked_leaderboards called", user=me.pigeon_number)

    rows = (await db.execute(ALL_LOCKED_LEADERBOARD_SQL, {"tenant_id": me.tenant_id})).fetchall()
    info("results: all locked leaderboard rows", count=len(rows))

    return [
        LeaderboardRow(
            pigeon_number=r[0],
            pigeon_name=r[1],
            week_number=r[2],
            score=r[3],
            rank=r[4],
            points=r[5],
        )
        for r in rows
    ]
