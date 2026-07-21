"""Self-service settings for the signed-in tenant member."""

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from backend.utils.db import get_db
from backend.utils.logger import info
from .auth import require_user

router = APIRouter(prefix="/me", tags=["me"])


class PrimaryPigeonUpdate(BaseModel):
    player_id: int


SET_PRIMARY_PIGEON_SQL = text("""
    UPDATE tenant_members tm
       SET primary_player_id = :player_id
      FROM users u
     WHERE tm.user_id = u.user_id
       AND lower(u.email) = lower(:email)
       AND tm.tenant_id = :tenant_id
       AND EXISTS (
           SELECT 1
             FROM user_players up
             JOIN players p ON p.player_id = up.player_id
            WHERE up.user_id = u.user_id
              AND up.player_id = :player_id
              AND p.tenant_id = :tenant_id
              AND up.role IN ('owner', 'manager')
       )
    RETURNING tm.user_id
""")


@router.put(
    "/primary-pigeon",
    status_code=204,
    summary="Store the signed-in user's default pigeon for future sessions",
)
async def set_primary_pigeon(
    update: PrimaryPigeonUpdate,
    db: AsyncSession = Depends(get_db),
    me=Depends(require_user),
):
    """Persist a managed pigeon as the user's default without replacing the current JWT."""
    row = (await db.execute(SET_PRIMARY_PIGEON_SQL, {
        "player_id": update.player_id,
        "email": me.email,
        "tenant_id": me.tenant_id,
    })).first()
    if not row:
        await db.rollback()
        raise HTTPException(
            status_code=400,
            detail="Primary pigeon must be a pigeon you own or manage in this league",
        )

    await db.commit()
    info(
        "me: primary pigeon updated",
        tenant_id=me.tenant_id,
        user_id=row[0],
        player_id=update.player_id,
    )
    return Response(status_code=204)
