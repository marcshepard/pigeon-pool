"""
Read-only results & standings APIs.

Endpoints (all require authentication):
- GET /results/weeks/{week}/picks
    Return all picks for a locked week, joined with game metadata.
- GET /results/weeks/{week}/leaderboard
    Return leaderboard (total_points + rank) for a locked week.
- GET /results/leaderboard
    Return leaderboard rows for all locked weeks.
- GET /results/ytd
    Return year-to-date aggregates per player across locked weeks.

Notes:
- "Locked" means weeks.lock_at <= now(); we never reveal picks for unlocked weeks.
- v_picks_filled supplies default (home, 0) rows for missing picks.
- v_weekly_leaderboard already ignores games that haven’t started.
"""
# pylint: disable=line-too-long

from __future__ import annotations

from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from backend.utils.db import get_db
from backend.utils.logger import debug, info, warn, error
from .auth import require_user

router = APIRouter(prefix="/results", tags=["results"])


# =============================================================================
# Models
# =============================================================================

class WeekPicksRow(BaseModel):
    """Pick row joined with game metadata for a specific locked week."""
    pigeon_number: int
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
    """Leaderboard row for a particular week (lower total_points is better)."""
    pigeon_number: int
    week_number: int = Field(..., ge=1, le=18)
    total_points: int
    rank: int


class YtdByWeek(BaseModel):
    """Per-week breakdown used in YTD responses."""
    week_number: int = Field(..., ge=1, le=18)
    total_points: int
    rank: int


class YtdRow(BaseModel):
    """Aggregated YTD stats across all locked weeks for a player."""
    pigeon_number: int
    total_points_ytd: int
    average_rank: float
    wins: int  # number of week-firsts (rank = 1)
    weeks_locked: List[int]
    by_week: List[YtdByWeek]


# =============================================================================
# SQL
# =============================================================================

WEEK_LOCKED_SQL = text("""
    SELECT 1
    FROM weeks
    WHERE week_number = :week
      AND lock_at <= now()
    LIMIT 1
""")

WEEK_PICKS_SQL = text("""
    SELECT
      f.pigeon_number,
      g.game_id,
      g.week_number,
      f.picked_home,
      f.predicted_margin,
      g.home_abbr,
      g.away_abbr,
      g.kickoff_at,
      g.status,
      g.home_score,
      g.away_score
    FROM v_picks_filled f
    JOIN games g ON g.game_id = f.game_id
    JOIN weeks w ON w.week_number = g.week_number
    WHERE g.week_number = :week
      AND w.lock_at <= now()              -- privacy: only locked weeks
    ORDER BY f.pigeon_number, g.kickoff_at, g.game_id
""")

WEEK_LEADERBOARD_SQL = text("""
    SELECT
      t.pigeon_number,
      t.week_number,
      t.total_points,
      t.rank
    FROM v_weekly_leaderboard t
    JOIN weeks w ON w.week_number = t.week_number
    WHERE t.week_number = :week
      AND w.lock_at <= now()
    ORDER BY t.rank ASC, t.total_points ASC, t.pigeon_number ASC
""")

ALL_LOCKED_LEADERBOARD_SQL = text("""
    SELECT
      t.pigeon_number,
      t.week_number,
      t.total_points,
      t.rank
    FROM v_weekly_leaderboard t
    JOIN weeks w ON w.week_number = t.week_number
    WHERE w.lock_at <= now()
    ORDER BY t.week_number ASC, t.rank ASC, t.total_points ASC, t.pigeon_number ASC
""")

# YTD: aggregate across locked weeks, include per-week breakdown
YTD_SUMMARY_SQL = text("""
    WITH locked as (
      SELECT week_number
      FROM weeks
      WHERE lock_at <= now()
    ),
    base as (
      SELECT l.week_number, v.pigeon_number, v.total_points, v.rank
      FROM v_weekly_leaderboard v
      JOIN locked l ON l.week_number = v.week_number
    ),
    agg as (
      SELECT
        pigeon_number,
        SUM(total_points)::int            AS total_points_ytd,
        AVG(rank)::float                  AS average_rank,
        SUM(CASE WHEN rank = 1 THEN 1 ELSE 0 END)::int AS wins
      FROM base
      GROUP BY pigeon_number
    ),
    weeks_seen as (
      SELECT array_agg(DISTINCT week_number ORDER BY week_number) AS weeks
      FROM (SELECT week_number FROM locked) s
    ),
    per_week as (
      SELECT
        b.pigeon_number,
        json_agg(
          json_build_object(
            'week_number', b.week_number,
            'total_points', b.total_points,
            'rank', b.rank
          )
          ORDER BY b.week_number
        ) AS by_week
      FROM base b
      GROUP BY b.pigeon_number
    )
    SELECT
      a.pigeon_number,
      a.total_points_ytd,
      a.average_rank,
      a.wins,
      COALESCE(ws.weeks, ARRAY[]::int[]) AS weeks_locked,
      COALESCE(pw.by_week, '[]'::json)   AS by_week
    FROM agg a
    LEFT JOIN weeks_seen ws ON TRUE
    LEFT JOIN per_week pw ON pw.pigeon_number = a.pigeon_number
    ORDER BY a.total_points_ytd ASC, a.average_rank ASC, a.pigeon_number ASC
""")

# =============================================================================
# Helpers
# =============================================================================

async def _ensure_week_locked(db: AsyncSession, week: int) -> None:
    """Raise 409 if the target week is not locked yet."""
    res = await db.execute(WEEK_LOCKED_SQL, {"week": week})
    if not res.first():
        warn("results: week not locked", week=week)
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Week {week} is not locked yet",
        )


# =============================================================================
# Endpoints
# =============================================================================

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
    """Return all players' picks for the given locked week, plus game info."""
    debug("results: get_week_picks called", user=me.pigeon_number, week=week)
    await _ensure_week_locked(db, week)

    rows = (await db.execute(WEEK_PICKS_SQL, {"week": week})).fetchall()
    info("results: week picks rows", week=week, count=len(rows))

    out: List[WeekPicksRow] = []
    for r in rows:
        out.append(
            WeekPicksRow(
                pigeon_number=r[0],
                game_id=r[1],
                week_number=r[2],
                picked_home=r[3],
                predicted_margin=r[4],
                home_abbr=r[5],
                away_abbr=r[6],
                kickoff_at=r[7].isoformat(),
                status=r[8],
                home_score=r[9],
                away_score=r[10],
            )
        )
    return out


@router.get(
    "/weeks/{week}/leaderboard",
    response_model=List[LeaderboardRow],
    summary="Leaderboard (total_points + rank) for a locked week",
)
async def get_week_leaderboard(
    week: int,
    db: AsyncSession = Depends(get_db),
    me=Depends(require_user),
):
    """
    Return leaderboard rows for the given locked week.
    The view already excludes not-started games, so this works mid-week as a live board.
    """
    debug("results: get_week_leaderboard called", user=me.pigeon_number, week=week)
    await _ensure_week_locked(db, week)

    rows = (await db.execute(WEEK_LEADERBOARD_SQL, {"week": week})).fetchall()
    info("results: week leaderboard rows", week=week, count=len(rows))

    return [
        LeaderboardRow(
            pigeon_number=r[0],
            week_number=r[1],
            total_points=r[2],
            rank=r[3],
        )
        for r in rows
    ]


@router.get(
    "/leaderboard",
    response_model=List[LeaderboardRow],
    summary="Leaderboard rows across all locked weeks",
)
async def get_all_locked_leaderboards(
    db: AsyncSession = Depends(get_db),
    me=Depends(require_user),
):
    """Return concatenated leaderboard rows for all locked weeks."""
    debug("results: get_all_locked_leaderboards called", user=me.pigeon_number)

    rows = (await db.execute(ALL_LOCKED_LEADERBOARD_SQL)).fetchall()
    info("results: all locked leaderboard rows", count=len(rows))

    return [
        LeaderboardRow(
            pigeon_number=r[0],
            week_number=r[1],
            total_points=r[2],
            rank=r[3],
        )
        for r in rows
    ]


@router.get(
    "/ytd",
    response_model=List[YtdRow],
    summary="Year-to-date totals per player (locked weeks only)",
)
async def get_ytd(
    db: AsyncSession = Depends(get_db),
    me=Depends(require_user),
):
    """
    Aggregate YTD results across all locked weeks.
    Returns per-player totals, average rank, wins, weeks_locked, and a by-week breakdown.
    """
    debug("results: get_ytd called", user=me.pigeon_number)

    try:
        result = await db.execute(YTD_SUMMARY_SQL)
        rows = result.fetchall()
        info("results: ytd rows", count=len(rows))
    except Exception as ex:  # pylint: disable=broad-except
        error("results: ytd query failed", err=str(ex))
        raise

    out: List[YtdRow] = []
    for r in rows:
        # r[5] is JSON array; r[4] is int[] from SQL
        weeks_locked = list(r[4]) if r[4] is not None else []
        by_week_json = r[5] or []  # already JSON from json_agg

        out.append(
            YtdRow(
                pigeon_number=r[0],
                total_points_ytd=r[1],
                average_rank=float(r[2]),
                wins=r[3],
                weeks_locked=weeks_locked,
                by_week=[YtdByWeek(**bw) for bw in by_week_json],
            )
        )
    return out
