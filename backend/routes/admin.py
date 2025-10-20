"""
Admin-only endpoints for managing and viewing picks.
"""
from __future__ import annotations

from typing import List

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from backend.utils.db import get_db
from backend.utils.logger import debug, info, warn, error
from backend.utils.submit_picks_to_andy import build_submit_body_from_db, submit_to_andy
from .auth import require_user
from .results import WeekPicksRow
from .picks import (
    PickOut as UserPickOut,
    PicksBulkIn as UserPicksBulkIn,
    _ensure_week_unlocked,
    _ensure_all_games_in_week,
    UPSERT_PICK_SQL,
    GET_PICKS_FOR_WEEK_SQL,
)

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


# =============================
# Admin pick management (by pigeon)
# =============================

@router.get(
    "/pigeons/{pigeon_number}/weeks/{week_number}/picks",
    response_model=List[UserPickOut],
    summary="Get picks for a pigeon in a week (admin only)",
)
async def admin_get_pigeon_picks_for_week(
    pigeon_number: int,
    week_number: int,
    db: AsyncSession = Depends(get_db),
    me=Depends(require_user),
):
    """ Return existing picks for a pigeon in a week """
    if not getattr(me, "is_admin", False):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin access required")

    result = await db.execute(
        GET_PICKS_FOR_WEEK_SQL,
        {"pigeon_number": pigeon_number, "week_number": week_number},
    )
    rows = result.fetchall()
    return [
        UserPickOut(
            pigeon_number=r[0],
            game_id=r[1],
            picked_home=r[2],
            predicted_margin=r[3],
            created_at=r[4],
        )
        for r in rows
    ]


@router.post(
    "/pigeons/{pigeon_number}/picks",
    response_model=List[UserPickOut],
    status_code=status.HTTP_201_CREATED,
    summary="Create or update a pigeon's picks for an unlocked week (admin only)",
)
async def admin_upsert_picks_bulk(
    pigeon_number: int,
    payload: UserPicksBulkIn,
    db: AsyncSession = Depends(get_db),
    me=Depends(require_user),
):
    """ Create or update picks for a pigeon in an unlocked week """
    if not getattr(me, "is_admin", False):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin access required")

    # Same guards as user flow
    await _ensure_week_unlocked(db, payload.week_number)
    await _ensure_all_games_in_week(db, payload.week_number, (p.game_id for p in payload.picks))

    out: List[UserPickOut] = []
    for p in payload.picks:
        res = await db.execute(
            UPSERT_PICK_SQL,
            {
                "pigeon_number": pigeon_number,
                "game_id": p.game_id,
                "picked_home": p.picked_home,
                "predicted_margin": p.predicted_margin,
            },
        )
        r = res.first()
        out.append(
            UserPickOut(
                pigeon_number=r[0],
                game_id=r[1],
                picked_home=r[2],
                predicted_margin=r[3],
                created_at=r[4],
            )
        )

    await db.commit()

    # Submit to Andy for that pigeon/week
    try:
        body = await build_submit_body_from_db(
            session=db, week=payload.week_number, pigeon_number=pigeon_number, pin=9182
        )
        await submit_to_andy(body, deadline_sec=20)
    except Exception as exc:  # pylint: disable=broad-except
        error(
            f"Failed to submit picks to Andy for pigeon {pigeon_number}, week {payload.week_number}: {exc}"
        )
        raise HTTPException(
            status_code=500,
            detail="Failed to submit to Andy's form (so you'll have to do that yourself)",
        ) from exc

    return out
