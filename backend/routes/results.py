"""
Read-only results & standings APIs.

Endpoints (all require authentication):
- GET /results/weeks/{week}/picks
    Return all picks for a locked week, joined with game metadata (+ pigeon_name).
- GET /results/weeks/{week}/leaderboard
    Return leaderboard (score + rank + pigeon_name) for a locked week.
- GET /results/leaderboard
    Return leaderboard rows for all locked weeks.
- GET /results/ytd
    Return year-to-date aggregates per player across locked weeks (+ pigeon_name).

Notes:
- "Locked" means weeks.lock_at <= now(); we never reveal picks for unlocked weeks.
- v_picks_filled supplies default (home, 0) rows for missing picks.
- v_weekly_leaderboard already ignores not-started games and includes pigeon_name.
- v_week_picks_with_names already filters to locked weeks (belt-and-suspenders privacy).
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


class YtdByWeek(BaseModel):
    """Per-week breakdown used in YTD responses."""
    week_number: int = Field(..., ge=1, le=18)
    score: int
    rank: int


class YtdRow(BaseModel):
    """Aggregated YTD stats across all locked weeks for a player."""
    pigeon_number: int
    pigeon_name: str
    total_points_ytd: int
    average_rank: float
    wins: int  # number of week-firsts (rank = 1)
    weeks_locked: List[int]
    by_week: List[YtdByWeek]


# =============================================================================
# SQL
# =============================================================================

# Keep a cheap guard to ensure the requested week is locked;
# even though v_week_picks_with_names already filters locked weeks,
# we want a clear 409 for /weeks/{week} endpoints.
WEEK_LOCKED_SQL = text("""
    SELECT 1
    FROM weeks
    WHERE week_number = :week
      AND lock_at <= now()
    LIMIT 1
""")

# Now that we have a convenience view with names + privacy,
# use it directly for weekly picks.
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
    ORDER BY pigeon_number, kickoff_at, game_id
""")

# v_weekly_leaderboard already contains pigeon_name.
WEEK_LEADERBOARD_SQL = text("""
    SELECT
      pigeon_number,
      pigeon_name,
      week_number,
      score,
      rank
    FROM v_weekly_leaderboard
    WHERE week_number = :week
    ORDER BY rank ASC, score ASC, pigeon_number ASC
""")

ALL_LOCKED_LEADERBOARD_SQL = text("""
    SELECT
      v.pigeon_number,
      v.pigeon_name,
      v.week_number,
      v.score,
      v.rank
    FROM v_weekly_leaderboard v
    JOIN weeks w ON w.week_number = v.week_number
    WHERE w.lock_at <= now()
    ORDER BY v.week_number ASC, v.rank ASC, v.score ASC, v.pigeon_number ASC
""")

# YTD: aggregate across locked weeks, include pigeon_name and per-week breakdown
YTD_SUMMARY_SQL = text("""
    WITH locked AS (
      SELECT week_number
      FROM weeks
      WHERE lock_at <= now()
    ),
    base AS (
      SELECT v.pigeon_number, v.pigeon_name, v.week_number, v.score, v.rank
      FROM v_weekly_leaderboard v
      JOIN locked l ON l.week_number = v.week_number
    ),
    agg AS (
      SELECT
        pigeon_number,
        max(pigeon_name)                AS pigeon_name,   -- name is stable per pigeon
        SUM(score)::int          AS total_points_ytd,
        AVG(rank)::float                AS average_rank,
        SUM(CASE WHEN rank = 1 THEN 1 ELSE 0 END)::int AS wins
      FROM base
      GROUP BY pigeon_number
    ),
    weeks_seen AS (
      SELECT array_agg(DISTINCT week_number ORDER BY week_number) AS weeks
      FROM (SELECT week_number FROM locked) s
    ),
    per_week AS (
      SELECT
        b.pigeon_number,
        json_agg(
          json_build_object(
            'week_number', b.week_number,
            'score', b.score,
            'rank', b.rank
          )
          ORDER BY b.week_number
        ) AS by_week
      FROM base b
      GROUP BY b.pigeon_number
    )
    SELECT
      a.pigeon_number,
      a.pigeon_name,
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
    """Return all players' picks for the given locked week, plus game info (includes pigeon_name)."""
    debug("results: get_week_picks called", user=me.pigeon_number, week=week)
    await _ensure_week_locked(db, week)

    rows = (await db.execute(WEEK_PICKS_SQL, {"week": week})).fetchall()
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
    await _ensure_week_locked(db, week)

    rows = (await db.execute(WEEK_LEADERBOARD_SQL, {"week": week})).fetchall()
    info("results: week leaderboard rows", week=week, count=len(rows))

    return [
        LeaderboardRow(
            pigeon_number=r[0],
            pigeon_name=r[1],
            week_number=r[2],
            score=r[3],
            rank=r[4],
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

    rows = (await db.execute(ALL_LOCKED_LEADERBOARD_SQL)).fetchall()
    info("results: all locked leaderboard rows", count=len(rows))

    return [
        LeaderboardRow(
            pigeon_number=r[0],
            pigeon_name=r[1],
            week_number=r[2],
            score=r[3],
            rank=r[4],
        )
        for r in rows
    ]


@router.get(
    "/ytd",
    response_model=List[YtdRow],
    summary="Year-to-date totals per player (locked weeks only, includes pigeon_name)",
)
async def get_ytd(
    db: AsyncSession = Depends(get_db),
    me=Depends(require_user),
):
    """
    Aggregate YTD results across all locked weeks.
    Returns per-player totals, average rank, wins, weeks_locked, a by-week breakdown,
    and the player's display name (pigeon_name).
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
        # r[5] is int[] weeks; r[6] is JSON array of {week_number,score,rank}
        weeks_locked = list(r[5]) if r[5] is not None else []
        by_week_json = r[6] or []

        out.append(
            YtdRow(
                pigeon_number=r[0],
                pigeon_name=r[1],
                total_points_ytd=r[2],
                average_rank=float(r[3]),
                wins=r[4],
                weeks_locked=weeks_locked,
                by_week=[YtdByWeek(**bw) for bw in by_week_json],
            )
        )
    return out
