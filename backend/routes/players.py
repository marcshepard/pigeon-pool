"""
Self-service endpoints for pigeons to manage their own identity.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, field_validator
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from backend.utils.db import get_db
from backend.utils.logger import info
from backend.utils.validation import validate_pigeon_name
from .auth import require_user

router = APIRouter(prefix="/players", tags=["players"])

TENANT_RENAME_SETTING_SQL = text("""
    SELECT pigeons_can_rename FROM tenants WHERE tenant_id = :tenant_id
""")

AUTHZ_SQL = text("""
    SELECT 1
      FROM user_players up
      JOIN users u ON u.user_id = up.user_id
     WHERE lower(u.email) = lower(:email)
       AND up.player_id = :player_id
       AND up.role IN ('owner','manager')
     LIMIT 1
""")

UPDATE_PLAYER_NAME_SQL = text("""
    UPDATE players
    SET pigeon_name = :pigeon_name
    WHERE player_id = :player_id AND tenant_id = :tenant_id
    RETURNING pigeon_number
""")


class PlayerRenameIn(BaseModel):
    pigeon_name: str

    @field_validator("pigeon_name")
    @classmethod
    def _validate_pigeon_name(cls, v: str) -> str:
        return validate_pigeon_name(v)


class PlayerRenameOut(BaseModel):
    player_id: int
    pigeon_number: int
    pigeon_name: str


@router.patch(
    "/{player_id}/name",
    response_model=PlayerRenameOut,
    summary="Rename a pigeon you own or manage (if the league allows self-service renames)",
)
async def rename_player(
    player_id: int,
    update: PlayerRenameIn,
    db: AsyncSession = Depends(get_db),
    me=Depends(require_user),
):
    setting_row = (await db.execute(TENANT_RENAME_SETTING_SQL, {"tenant_id": me.tenant_id})).first()
    if not setting_row or not setting_row[0]:
        raise HTTPException(status_code=403, detail="This league does not allow pigeons to rename themselves")

    authz_row = (await db.execute(AUTHZ_SQL, {"email": me.email, "player_id": player_id})).first()
    if not authz_row:
        raise HTTPException(status_code=403, detail="Not allowed to rename this pigeon")

    try:
        result = (await db.execute(UPDATE_PLAYER_NAME_SQL, {
            "pigeon_name": update.pigeon_name,
            "player_id": player_id,
            "tenant_id": me.tenant_id,
        })).first()
        await db.commit()
    except Exception as exc:
        await db.rollback()
        raise HTTPException(status_code=409, detail="That name is already taken") from exc

    if not result:
        raise HTTPException(status_code=404, detail=f"Player {player_id} not found in this tenant")

    info("players: self-service rename", player_id=player_id, name=update.pigeon_name)
    return PlayerRenameOut(player_id=player_id, pigeon_number=result[0], pigeon_name=update.pigeon_name)
