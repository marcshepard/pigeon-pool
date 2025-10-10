"""
Endpoint for users to create and managing their picks
"""

from __future__ import annotations

from typing import List, Iterable
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field, field_validator
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import text

from backend.utils.db import get_db
from .auth import require_user

router = APIRouter(prefix="/picks", tags=["picks"])


# =========================
# Pydantic models
# =========================
class PickIn(BaseModel):
    """ Input model for a single pick """
    game_id: int = Field(..., description="Target game_id")
    picked_home: bool = Field(..., description="True = pick home team, False = pick away team")
    predicted_margin: int = Field(..., ge=0, description="Non-negative winning margin")

class PickOut(BaseModel):
    """ Output model for a single pick """
    pigeon_number: int
    game_id: int
    picked_home: bool
    predicted_margin: int
    created_at: datetime | None = None # None if no pick submitted (predicted_margin will be 0)

class PicksBulkIn(BaseModel):
    """Input model for bulk upsert of picks"""
    week_number: int = Field(..., ge=1, le=18)
    picks: List[PickIn]

    @field_validator("picks")
    @classmethod
    def no_duplicates(cls, v: List[PickIn]):
        """Ensure no duplicate game_id in payload"""
        seen = set()
        for p in v:
            if p.game_id in seen:
                raise ValueError(f"Duplicate game_id {p.game_id} in payload")
            seen.add(p.game_id)
        return v


# =========================
# Helper queries
# =========================
CHECK_WEEK_SQL = text("""
    SELECT lock_at
    FROM weeks
    WHERE week_number = :week_number
""")

GAMES_FOR_WEEK_SQL = text("""
    SELECT game_id
    FROM games
    WHERE week_number = :week_number
""")

GAME_WITH_WEEK_SQL = text("""
    SELECT g.week_number, w.lock_at
    FROM games g
    JOIN weeks w ON w.week_number = g.week_number
    WHERE g.game_id = :game_id
""")

UPSERT_PICK_SQL = text("""
    INSERT INTO picks (pigeon_number, game_id, picked_home, predicted_margin)
    VALUES (:pigeon_number, :game_id, :picked_home, :predicted_margin)
    ON CONFLICT (pigeon_number, game_id)
    DO UPDATE SET
        picked_home = EXCLUDED.picked_home,
        predicted_margin = EXCLUDED.predicted_margin,
        created_at = now()
    RETURNING pigeon_number, game_id, picked_home, predicted_margin, created_at
""")

GET_PICKS_FOR_WEEK_SQL = text("""
    SELECT p.pigeon_number, p.game_id, p.picked_home, p.predicted_margin, p.created_at
    FROM v_picks_filled p
    JOIN games g ON g.game_id = p.game_id
    WHERE p.pigeon_number = :pigeon_number
      AND g.week_number = :week_number
    ORDER BY p.game_id
""")


# =========================
# Utilities
# =========================
async def _ensure_week_unlocked(db: AsyncSession, week_number: int) -> None:
    row = (await db.execute(CHECK_WEEK_SQL, {"week_number": week_number})).first()
    if not row:
        raise HTTPException(status_code=404, detail=f"Week {week_number} not found")
    (lock_at,) = row
    now = datetime.now(timezone.utc)
    if lock_at <= now:
        raise HTTPException(status_code=409, detail=f"Week {week_number} is locked")

async def _ensure_game_unlocked(db: AsyncSession, game_id: int) -> int:
    row = (await db.execute(GAME_WITH_WEEK_SQL, {"game_id": game_id})).first()
    if not row:
        raise HTTPException(status_code=404, detail=f"Game {game_id} not found")
    week_number, lock_at = row
    now = datetime.now(timezone.utc)
    if lock_at <= now:
        raise HTTPException(status_code=409, detail=f"Week {week_number} is locked")
    return week_number

async def _ensure_all_games_in_week(
    db: AsyncSession, week_number: int, game_ids: Iterable[int]
) -> None:
    if not game_ids:
        return
    rows = await db.execute(GAMES_FOR_WEEK_SQL, {"week_number": week_number})
    valid_ids = {r[0] for r in rows.fetchall()}
    missing = [gid for gid in game_ids if gid not in valid_ids]
    if missing:
        raise HTTPException(
            status_code=400,
            detail=f"These game_id(s) are not in week {week_number}: {sorted(missing)}"
        )


# =========================
# Endpoints
# =========================
@router.get(
    "/{week_number}",
    response_model=List[PickOut],
    summary="Get my picks for a week"
)
async def get_my_picks_for_week(
    week_number: int,
    db: AsyncSession = Depends(get_db),
    me=Depends(require_user),
):
    """ Return existing picks regardless of lock status (read-only after lock) """
    result = await db.execute(
        GET_PICKS_FOR_WEEK_SQL,
        {"pigeon_number": me.pigeon_number, "week_number": week_number},
    )
    rows = result.fetchall()
    return [
        PickOut(
            pigeon_number=r[0],
            game_id=r[1],
            picked_home=r[2],
            predicted_margin=r[3],
            created_at=r[4],
        )
        for r in rows
    ]


@router.post(
    "",
    response_model=List[PickOut],
    status_code=status.HTTP_201_CREATED,
    summary="Create or update picks for unlocked weeks"
)
async def upsert_picks_bulk(
    payload: PicksBulkIn,
    db: AsyncSession = Depends(get_db),
    me=Depends(require_user),
):
    """ App-layer guard (DB trigger will also enforce) """
    await _ensure_week_unlocked(db, payload.week_number)
    await _ensure_all_games_in_week(db, payload.week_number, (p.game_id for p in payload.picks))

    out: List[PickOut] = []
    # Perform upserts; rely on ON CONFLICT to update existing rows
    for p in payload.picks:
        res = await db.execute(
            UPSERT_PICK_SQL,
            {
                "pigeon_number": me.pigeon_number,
                "game_id": p.game_id,
                "picked_home": p.picked_home,
                "predicted_margin": p.predicted_margin,
            },
        )
        r = res.first()
        out.append(
            PickOut(
                pigeon_number=r[0],
                game_id=r[1],
                picked_home=r[2],
                predicted_margin=r[3],
                created_at=r[4],
            )
        )

    # Commit once for the batch
    await db.commit()
    return out
