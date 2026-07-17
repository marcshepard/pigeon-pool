"""
Commissioner-only endpoints for managing picks, players, users, locks, and email
within the active tenant. All data-access routes are scoped to me.tenant_id.
"""

#pylint: disable=line-too-long

from __future__ import annotations
import os
import secrets
import string
import tempfile
from typing import List, Optional
from datetime import datetime, timezone, timedelta
import traceback

from fastapi import APIRouter, Depends, HTTPException, status, Body, Response, UploadFile, File, Form
from pydantic import BaseModel, EmailStr
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from backend.utils.import_picks_xlsx import import_picks_pivot_xlsx_with_engine
from backend.utils.db import get_db
from backend.utils.logger import debug, info, warn, error
from backend.utils.emailer import send_bulk_email_to_all_users
from .auth import require_user, require_admin
from .results import WeekPicksRow
from .schedule import get_current_week

router = APIRouter(prefix="/admin", tags=["admin"])

# ---------------------------------------------------------------------------
# Admin week picks (all players, for commissioner review)
# ---------------------------------------------------------------------------

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
      AND tenant_id   = :tenant_id
    ORDER BY pigeon_number, kickoff_at, game_id
""")

@router.get(
    "/weeks/{week}/picks",
    response_model=List[WeekPicksRow],
    summary="All picks + game metadata for a week (commissioner only)",
)
async def get_week_picks(
    week: int,
    db: AsyncSession = Depends(get_db),
    me=Depends(require_user),
):
    """Return all players' picks for the given week, even if unlocked."""
    debug("admin: get_week_picks called", user=me.pigeon_number, week=week)
    if not getattr(me, "is_admin", False):
        warn("admin: non-commissioner attempted to access picks", user=me.pigeon_number, week=week)
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Commissioner access required")

    rows = (await db.execute(WEEK_PICKS_SQL, {"week": week, "tenant_id": me.tenant_id})).fetchall()
    info("admin: week picks rows", week=week, count=len(rows))

    return [
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
        for r in rows
    ]


# ---------------------------------------------------------------------------
# League (tenant) settings
# ---------------------------------------------------------------------------

UPDATE_TENANT_NAME_SQL = text("""
    UPDATE tenants SET name = :name WHERE tenant_id = :tenant_id
""")


class LeagueUpdate(BaseModel):
    name: str


@router.patch(
    "/league",
    status_code=204,
    summary="Rename this league (commissioner only)",
)
async def update_league(
    update: LeagueUpdate,
    db: AsyncSession = Depends(get_db),
    me=Depends(require_admin),
):
    name = update.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="League name cannot be empty")
    await db.execute(UPDATE_TENANT_NAME_SQL, {"name": name, "tenant_id": me.tenant_id})
    await db.commit()
    info("admin: league renamed", tenant_id=me.tenant_id, name=name)
    return Response(status_code=204)


# ---------------------------------------------------------------------------
# Lock-time management (tenant_weeks, not weeks.lock_at)
# ---------------------------------------------------------------------------

WEEK_EXISTS_SQL = text("SELECT 1 FROM weeks WHERE week_number = :week")

FIRST_KICKOFF_SQL = text("SELECT MIN(kickoff_at) FROM games WHERE week_number = :week")

TENANT_WEEK_LOCK_SQL = text("""
    SELECT lock_at FROM tenant_weeks
    WHERE tenant_id = :tenant_id AND week_number = :week
""")

UPSERT_TENANT_WEEK_LOCK_SQL = text("""
    INSERT INTO tenant_weeks (tenant_id, week_number, lock_at)
    VALUES (:tenant_id, :week, :lock_at)
    ON CONFLICT (tenant_id, week_number)
    DO UPDATE SET lock_at = EXCLUDED.lock_at
""")

TENANT_WEEKS_LOCKS_SQL = text("""
    SELECT week_number, lock_at
    FROM tenant_weeks
    WHERE tenant_id = :tenant_id
    ORDER BY week_number
""")


class WeekLockRow(BaseModel):
    week_number: int
    lock_at: datetime


@router.get(
    "/weeks/locks",
    response_model=List[WeekLockRow],
    summary="All weeks' lock times for this tenant (commissioner only)",
)
async def get_weeks_locks(
    db: AsyncSession = Depends(get_db),
    me=Depends(require_admin),
):
    debug("admin: get_weeks_locks called", user=me.pigeon_number)
    rows = (await db.execute(TENANT_WEEKS_LOCKS_SQL, {"tenant_id": me.tenant_id})).fetchall()
    info("admin: weeks lock rows", count=len(rows))
    return [WeekLockRow(week_number=r[0], lock_at=r[1]) for r in rows]


@router.patch(
    "/weeks/{week}/lock",
    status_code=204,
    summary="Adjust lock time for a week (commissioner only)",
)
async def adjust_week_lock(
    week: int,
    db: AsyncSession = Depends(get_db),
    me=Depends(require_admin),
    lock_at: datetime = Body(..., embed=True, description="New lock time (RFC3339/ISO8601)"),
):
    """
    Adjust the lock time for the given week within this tenant.
    Rules:
    - Only current or future weeks can be adjusted.
    - Current week can only be adjusted if still 'scheduled'.
    - New lock time must be >= now and <= the first scheduled kickoff.
    """
    debug("admin: adjust_week_lock called", user=me.pigeon_number, week=week)

    exists = (await db.execute(WEEK_EXISTS_SQL, {"week": week})).first()
    if not exists:
        raise HTTPException(status_code=404, detail=f"Week {week} not found")

    current = await get_current_week(db, me)
    current_week = int(current.week)
    current_status = str(current.status)

    if week < current_week:
        raise HTTPException(status_code=400, detail="Cannot adjust a past week")
    if week == current_week and current_status != "scheduled":
        raise HTTPException(status_code=400, detail="Current week is not in 'scheduled' state")

    new_lock = lock_at
    if new_lock.tzinfo is None:
        new_lock = new_lock.replace(tzinfo=timezone.utc)
    else:
        new_lock = new_lock.astimezone(timezone.utc)

    first_row = (await db.execute(FIRST_KICKOFF_SQL, {"week": week})).first()
    first_kickoff = first_row[0] if first_row else None
    if first_kickoff is None:
        raise HTTPException(status_code=400, detail=f"No games scheduled for week {week}")

    tuesday_before = first_kickoff.astimezone(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    days_since_tuesday = (tuesday_before.weekday() - 1) % 7
    tuesday_before = tuesday_before - timedelta(days=days_since_tuesday)

    if new_lock < tuesday_before:
        raise HTTPException(status_code=400, detail="Lock time must be no earlier than the Tuesday before the first kickoff")
    if new_lock > first_kickoff:
        raise HTTPException(status_code=400, detail="Lock time must be no later than the first scheduled kickoff")

    await db.execute(UPSERT_TENANT_WEEK_LOCK_SQL, {"tenant_id": me.tenant_id, "week": week, "lock_at": new_lock})
    await db.commit()
    info("admin: week lock updated", week=week, lock_at=new_lock.isoformat(), tenant_id=me.tenant_id)
    return Response(status_code=204)


# ---------------------------------------------------------------------------
# Season activation: copy default lock times into this tenant's tenant_weeks
# ---------------------------------------------------------------------------

DEFAULT_LOCK_AT_SQL = text("""
    SELECT week_number, default_lock_at FROM weeks ORDER BY week_number
""")

ACTIVATE_SEASON_SQL = text("""
    INSERT INTO tenant_weeks (tenant_id, week_number, lock_at)
    VALUES (:tenant_id, :week_number, :lock_at)
    ON CONFLICT (tenant_id, week_number) DO NOTHING
""")


@router.post(
    "/activate-season",
    status_code=204,
    summary="Copy default lock times into this tenant's schedule (commissioner only)",
)
async def activate_season(
    db: AsyncSession = Depends(get_db),
    me=Depends(require_admin),
):
    """
    Idempotent. Copies weeks.default_lock_at → tenant_weeks for this tenant.
    Skips weeks already present in tenant_weeks (use PATCH /weeks/{week}/lock to adjust).
    Errors if no default lock times exist (global schedule not yet imported for the season).
    """
    debug("admin: activate_season called", tenant_id=me.tenant_id)
    rows = (await db.execute(DEFAULT_LOCK_AT_SQL)).fetchall()
    ready = [(r[0], r[1]) for r in rows if r[1] is not None]
    if not ready:
        raise HTTPException(
            status_code=400,
            detail="No default lock times found. Import the season schedule first.",
        )
    for week_number, lock_at in ready:
        await db.execute(ACTIVATE_SEASON_SQL, {
            "tenant_id": me.tenant_id,
            "week_number": week_number,
            "lock_at": lock_at,
        })
    await db.commit()
    info("admin: season activated", tenant_id=me.tenant_id, weeks=len(ready))
    return Response(status_code=204)


# ---------------------------------------------------------------------------
# Player (pigeon) management
# ---------------------------------------------------------------------------

GET_PLAYERS_SQL = text("""
    SELECT
        p.player_id,
        p.pigeon_number,
        p.pigeon_name,
        u.email AS owner_email,
        p.season_status
    FROM players p
    LEFT JOIN user_players up ON up.player_id = p.player_id AND up.role = 'owner'
    LEFT JOIN users u ON u.user_id = up.user_id
    WHERE p.tenant_id = :tenant_id
    ORDER BY p.pigeon_number
""")

UPDATE_PLAYER_NAME_SQL = text("""
    UPDATE players
    SET pigeon_name = :pigeon_name
    WHERE player_id = :player_id AND tenant_id = :tenant_id
""")

UPDATE_PLAYER_STATUS_SQL = text("""
    UPDATE players
    SET season_status = :season_status
    WHERE player_id = :player_id AND tenant_id = :tenant_id
""")

GET_USER_ID_BY_EMAIL_SQL = text("""
    SELECT user_id FROM users WHERE LOWER(email) = LOWER(:email)
""")

DELETE_PLAYER_OWNER_SQL = text("""
    DELETE FROM user_players
    WHERE player_id = :player_id AND role = 'owner'
""")

INSERT_PLAYER_OWNER_SQL = text("""
    INSERT INTO user_players (user_id, player_id, role)
    VALUES (:user_id, :player_id, 'owner')
    ON CONFLICT (user_id, player_id) DO UPDATE SET role = 'owner'
""")

CHECK_PLAYER_EXISTS_SQL = text("""
    SELECT 1 FROM players WHERE player_id = :player_id AND tenant_id = :tenant_id
""")


CREATE_PLAYER_SQL = text("""
    INSERT INTO players (tenant_id, pigeon_number, pigeon_name)
    VALUES (:tenant_id, :pigeon_number, :pigeon_name)
    RETURNING player_id
""")

NEXT_PIGEON_NUMBER_SQL = text("""
    SELECT COALESCE(MAX(pigeon_number), 0) + 1 FROM players WHERE tenant_id = :tenant_id
""")


class PigeonRow(BaseModel):
    player_id: int
    pigeon_number: int
    pigeon_name: str
    owner_email: Optional[str]
    season_status: str = "pending"


class PigeonCreate(BaseModel):
    pigeon_name: str
    pigeon_number: Optional[int] = None  # auto-assigned if omitted


class PigeonUpdate(BaseModel):
    pigeon_name: Optional[str] = None
    owner_email: Optional[str] = None
    season_status: Optional[str] = None


@router.post(
    "/pigeons",
    status_code=201,
    response_model=PigeonRow,
    summary="Create a new player/pigeon in this tenant (commissioner only)",
)
async def create_pigeon(
    pigeon: PigeonCreate,
    db: AsyncSession = Depends(get_db),
    me=Depends(require_admin),
):
    """
    Create a new player in this tenant.
    pigeon_number is auto-assigned (next available) if not provided.
    """
    debug("admin: create_pigeon called", tenant_id=me.tenant_id, name=pigeon.pigeon_name)
    pn = pigeon.pigeon_number
    if pn is None:
        row = (await db.execute(NEXT_PIGEON_NUMBER_SQL, {"tenant_id": me.tenant_id})).first()
        pn = row[0]
    try:
        result = (await db.execute(CREATE_PLAYER_SQL, {
            "tenant_id": me.tenant_id,
            "pigeon_number": pn,
            "pigeon_name": pigeon.pigeon_name,
        })).first()
        await db.commit()
    except Exception as exc:
        await db.rollback()
        raise HTTPException(status_code=409, detail=f"Pigeon #{pn} already exists in this tenant") from exc
    player_id = result[0]
    info("admin: pigeon created", tenant_id=me.tenant_id, player_id=player_id, pigeon_number=pn)
    return PigeonRow(player_id=player_id, pigeon_number=pn, pigeon_name=pigeon.pigeon_name, owner_email=None, season_status="pending")


@router.get(
    "/pigeons",
    response_model=List[PigeonRow],
    summary="List all players with their owners (commissioner only)",
)
async def get_pigeons(
    db: AsyncSession = Depends(get_db),
    me=Depends(require_admin),
):
    debug("admin: get_pigeons called", tenant_id=me.tenant_id)
    rows = (await db.execute(GET_PLAYERS_SQL, {"tenant_id": me.tenant_id})).fetchall()
    info("admin: pigeons retrieved", count=len(rows))
    return [
        PigeonRow(player_id=r[0], pigeon_number=r[1], pigeon_name=r[2], owner_email=r[3], season_status=r[4])
        for r in rows
    ]


@router.patch(
    "/pigeons/{player_id}",
    status_code=200,
    summary="Update player name and/or owner (commissioner only)",
)
async def update_pigeon(
    player_id: int,
    update: PigeonUpdate,
    db: AsyncSession = Depends(get_db),
    me=Depends(require_admin),
):
    debug("admin: update_pigeon called", tenant_id=me.tenant_id, player_id=player_id)

    exists = (await db.execute(CHECK_PLAYER_EXISTS_SQL, {"player_id": player_id, "tenant_id": me.tenant_id})).first()
    if not exists:
        raise HTTPException(status_code=404, detail=f"Player {player_id} not found in this tenant")

    if update.pigeon_name is not None:
        await db.execute(UPDATE_PLAYER_NAME_SQL, {
            "pigeon_name": update.pigeon_name,
            "player_id": player_id,
            "tenant_id": me.tenant_id,
        })
        info("admin: player name updated", player_id=player_id, name=update.pigeon_name)

    if update.season_status is not None:
        if update.season_status not in ("pending", "active", "out"):
            raise HTTPException(status_code=400, detail="season_status must be pending, active, or out")
        await db.execute(UPDATE_PLAYER_STATUS_SQL, {
            "season_status": update.season_status,
            "player_id": player_id,
            "tenant_id": me.tenant_id,
        })
        info("admin: player season_status updated", player_id=player_id, season_status=update.season_status)

    if "owner_email" in (update.model_fields_set or set()):
        await db.execute(DELETE_PLAYER_OWNER_SQL, {"player_id": player_id})
        if update.owner_email:
            user_row = (await db.execute(GET_USER_ID_BY_EMAIL_SQL, {"email": update.owner_email})).first()
            if not user_row:
                await db.rollback()
                raise HTTPException(status_code=404, detail=f"User {update.owner_email} not found")
            await db.execute(INSERT_PLAYER_OWNER_SQL, {"user_id": user_row[0], "player_id": player_id})
            info("admin: player owner updated", player_id=player_id, owner=update.owner_email)
        else:
            info("admin: player owner removed", player_id=player_id)

    await db.commit()
    return Response(status_code=200)


# ---------------------------------------------------------------------------
# Payout configuration
# ---------------------------------------------------------------------------

GET_PAYOUTS_SQL = text("""
    SELECT place, points FROM tenant_payouts
    WHERE tenant_id = :tenant_id
    ORDER BY place
""")

DELETE_PAYOUTS_SQL = text("DELETE FROM tenant_payouts WHERE tenant_id = :tenant_id")

UPSERT_PAYOUT_SQL = text("""
    INSERT INTO tenant_payouts (tenant_id, place, points)
    VALUES (:tenant_id, :place, :points)
    ON CONFLICT (tenant_id, place) DO UPDATE SET points = EXCLUDED.points
""")


class PayoutRow(BaseModel):
    place: int
    points: int


@router.get(
    "/payouts",
    response_model=List[PayoutRow],
    summary="Get payout amounts for this tenant (any member)",
)
async def get_payouts(
    db: AsyncSession = Depends(get_db),
    me=Depends(require_user),
):
    rows = (await db.execute(GET_PAYOUTS_SQL, {"tenant_id": me.tenant_id})).fetchall()
    return [PayoutRow(place=r[0], points=r[1]) for r in rows]


@router.put(
    "/payouts",
    status_code=204,
    summary="Replace payout table for this tenant (commissioner only)",
)
async def put_payouts(
    payouts: List[PayoutRow],
    db: AsyncSession = Depends(get_db),
    me=Depends(require_admin),
):
    if not payouts:
        raise HTTPException(status_code=400, detail="Payout list cannot be empty")
    await db.execute(DELETE_PAYOUTS_SQL, {"tenant_id": me.tenant_id})
    for row in payouts:
        await db.execute(UPSERT_PAYOUT_SQL, {
            "tenant_id": me.tenant_id,
            "place": row.place,
            "points": row.points,
        })
    await db.commit()
    info("admin: payouts updated", tenant_id=me.tenant_id, places=len(payouts))
    return Response(status_code=204)


# ---------------------------------------------------------------------------
# User management
# ---------------------------------------------------------------------------

GET_USERS_SQL = text("""
    SELECT
        u.user_id,
        u.email,
        tm.primary_player_id,
        p_primary.pigeon_number AS primary_pigeon,
        COALESCE(
            json_agg(p_sec.pigeon_number ORDER BY p_sec.pigeon_number)
            FILTER (WHERE p_sec.pigeon_number IS NOT NULL),
            '[]'
        ) AS secondary_pigeons
    FROM tenant_members tm
    JOIN users u ON u.user_id = tm.user_id
    LEFT JOIN players p_primary ON p_primary.player_id = tm.primary_player_id
    LEFT JOIN user_players up_sec
        ON up_sec.user_id = tm.user_id
       AND up_sec.role IN ('manager', 'viewer')
    LEFT JOIN players p_sec
        ON p_sec.player_id = up_sec.player_id
       AND p_sec.tenant_id = :tenant_id
       AND p_sec.player_id <> tm.primary_player_id
    WHERE tm.tenant_id = :tenant_id
    GROUP BY u.user_id, u.email, tm.primary_player_id, p_primary.pigeon_number
    ORDER BY u.email
""")

DELETE_USER_SQL = text("DELETE FROM users WHERE LOWER(email) = LOWER(:email)")

CHECK_USER_OWNS_PLAYER_SQL = text("""
    SELECT p.pigeon_number
    FROM user_players up
    JOIN players p ON p.player_id = up.player_id
    WHERE up.user_id = (SELECT user_id FROM users WHERE LOWER(email) = LOWER(:email))
      AND up.role = 'owner'
      AND p.tenant_id = :tenant_id
    LIMIT 1
""")

DELETE_USER_TENANT_PLAYERS_SQL = text("""
    DELETE FROM user_players
    WHERE user_id = (SELECT user_id FROM users WHERE LOWER(email) = LOWER(:email))
      AND player_id IN (SELECT player_id FROM players WHERE tenant_id = :tenant_id)
""")

GET_PLAYER_BY_NUMBER_SQL = text("""
    SELECT player_id FROM players WHERE tenant_id = :tenant_id AND pigeon_number = :pigeon_number
""")

INSERT_USER_PRIMARY_SQL = text("""
    INSERT INTO user_players (user_id, player_id, role)
    VALUES (
        (SELECT user_id FROM users WHERE LOWER(email) = LOWER(:email)),
        :player_id,
        'manager'
    )
    ON CONFLICT (user_id, player_id) DO UPDATE SET role = 'manager'
""")

UPDATE_TENANT_MEMBER_PRIMARY_SQL = text("""
    INSERT INTO tenant_members (tenant_id, user_id, role, primary_player_id)
    VALUES (:tenant_id, (SELECT user_id FROM users WHERE LOWER(email) = LOWER(:email)), 'member', :player_id)
    ON CONFLICT (tenant_id, user_id) DO UPDATE SET primary_player_id = EXCLUDED.primary_player_id
""")

INSERT_USER_SECONDARY_SQL = text("""
    INSERT INTO user_players (user_id, player_id, role)
    VALUES (
        (SELECT user_id FROM users WHERE LOWER(email) = LOWER(:email)),
        :player_id,
        'manager'
    )
    ON CONFLICT (user_id, player_id) DO UPDATE SET role = 'manager'
""")

INSERT_USER_SQL = text("""
    INSERT INTO users (email, password_hash)
    VALUES (:email, :password_hash)
    RETURNING user_id
""")


class UserRow(BaseModel):
    email: str
    primary_pigeon: Optional[int]
    secondary_pigeons: List[int]


class UserUpdate(BaseModel):
    primary_pigeon: Optional[int] = None
    secondary_pigeons: List[int] = []


class UserCreate(BaseModel):
    email: EmailStr
    primary_pigeon: int  # pigeon_number within this tenant; player must exist before creating user


def _random_password_hash(length: int = 16) -> str:
    alphabet = string.ascii_letters + string.digits + string.punctuation
    return "".join(secrets.choice(alphabet) for _ in range(length))


@router.get(
    "/users",
    response_model=List[UserRow],
    summary="List all users in this tenant (commissioner only)",
)
async def get_users(
    db: AsyncSession = Depends(get_db),
    me=Depends(require_admin),
):
    debug("admin: get_users called", tenant_id=me.tenant_id)
    rows = (await db.execute(GET_USERS_SQL, {"tenant_id": me.tenant_id})).fetchall()
    info("admin: users retrieved", count=len(rows))
    return [
        UserRow(email=r[1], primary_pigeon=r[3], secondary_pigeons=r[4] or [])
        for r in rows
    ]


@router.post(
    "/users",
    status_code=201,
    response_model=UserRow,
    summary="Create a new user and assign their primary pigeon (commissioner only)",
)
async def create_user(
    user: UserCreate,
    db: AsyncSession = Depends(get_db),
    me=Depends(require_admin),
):
    """
    Atomically adds the user to this tenant with the given primary pigeon. If the email
    belongs to an existing user (e.g. a member of another tenant), that account is linked
    into this tenant rather than creating a duplicate. Otherwise a new user account is
    created with a random placeholder password; the user must use password-reset before
    first login. The pigeon must already exist in this tenant.
    """
    debug("admin: create_user called", tenant_id=me.tenant_id, email=user.email)

    existing = (await db.execute(GET_USER_ID_BY_EMAIL_SQL, {"email": user.email})).first()

    player_row = (await db.execute(GET_PLAYER_BY_NUMBER_SQL, {
        "tenant_id": me.tenant_id,
        "pigeon_number": user.primary_pigeon,
    })).first()
    if not player_row:
        raise HTTPException(status_code=404, detail=f"Pigeon #{user.primary_pigeon} not found in this tenant")
    player_id = player_row[0]

    if existing:
        uid = existing[0]
        already_member = (await db.execute(text("""
            SELECT 1 FROM tenant_members WHERE tenant_id = :tenant_id AND user_id = :uid
        """), {"tenant_id": me.tenant_id, "uid": uid})).first()
        if already_member:
            raise HTTPException(status_code=409, detail=f"User {user.email} already exists in this league")
    else:
        result = (await db.execute(INSERT_USER_SQL, {
            "email": user.email,
            "password_hash": _random_password_hash(),
        })).first()
        uid = result[0]

    await db.execute(INSERT_PLAYER_OWNER_SQL, {"user_id": uid, "player_id": player_id})

    await db.execute(text("""
        INSERT INTO tenant_members (tenant_id, user_id, role, primary_player_id)
        VALUES (:tenant_id, :uid, 'member', :player_id)
    """), {"tenant_id": me.tenant_id, "uid": uid, "player_id": player_id})

    await db.commit()
    info("admin: user created", email=user.email, player_id=player_id)
    return UserRow(email=user.email, primary_pigeon=user.primary_pigeon, secondary_pigeons=[])


@router.put(
    "/users/{email}",
    status_code=200,
    summary="Update a user's player assignments within this tenant (commissioner only)",
)
async def update_user(
    email: str,
    update: UserUpdate,
    db: AsyncSession = Depends(get_db),
    me=Depends(require_admin),
):
    """Replace all player assignments for this user within the active tenant."""
    debug("admin: update_user called", tenant_id=me.tenant_id, email=email)

    user_row = (await db.execute(GET_USER_ID_BY_EMAIL_SQL, {"email": email})).first()
    if not user_row:
        raise HTTPException(status_code=404, detail=f"User {email} not found")

    # Remove all existing assignments within this tenant
    await db.execute(DELETE_USER_TENANT_PLAYERS_SQL, {"email": email, "tenant_id": me.tenant_id})

    primary_player_id = None

    if update.primary_pigeon is not None:
        row = (await db.execute(GET_PLAYER_BY_NUMBER_SQL, {
            "tenant_id": me.tenant_id,
            "pigeon_number": update.primary_pigeon,
        })).first()
        if not row:
            await db.rollback()
            raise HTTPException(status_code=404, detail=f"Pigeon #{update.primary_pigeon} not found in this tenant")
        primary_player_id = row[0]
        await db.execute(INSERT_USER_PRIMARY_SQL, {"email": email, "player_id": primary_player_id})
        await db.execute(UPDATE_TENANT_MEMBER_PRIMARY_SQL, {
            "tenant_id": me.tenant_id,
            "email": email,
            "player_id": primary_player_id,
        })
        info("admin: user primary player set", email=email, player_id=primary_player_id)

    for pigeon_num in update.secondary_pigeons:
        row = (await db.execute(GET_PLAYER_BY_NUMBER_SQL, {
            "tenant_id": me.tenant_id,
            "pigeon_number": pigeon_num,
        })).first()
        if not row:
            warn("admin: secondary pigeon not found", pigeon=pigeon_num, tenant_id=me.tenant_id)
            continue
        await db.execute(INSERT_USER_SECONDARY_SQL, {"email": email, "player_id": row[0]})

    if update.secondary_pigeons:
        info("admin: user secondary pigeons set", email=email, pigeons=update.secondary_pigeons)

    await db.commit()
    return Response(status_code=200)


@router.delete(
    "/users/{email}",
    status_code=204,
    summary="Delete a user (commissioner only)",
)
async def delete_user(
    email: str,
    db: AsyncSession = Depends(get_db),
    me=Depends(require_admin),
):
    """Delete a user. Returns 409 if the user owns a player in this tenant."""
    debug("admin: delete_user called", tenant_id=me.tenant_id, email=email)

    owned = (await db.execute(CHECK_USER_OWNS_PLAYER_SQL, {"email": email, "tenant_id": me.tenant_id})).first()
    if owned:
        raise HTTPException(
            status_code=409,
            detail=f"User owns pigeon #{owned[0]}. Reassign ownership first.",
        )

    result = await db.execute(DELETE_USER_SQL, {"email": email})
    if result.rowcount == 0:
        raise HTTPException(status_code=404, detail=f"User {email} not found")

    await db.commit()
    info("admin: user deleted", email=email)
    return Response(status_code=204)


# ---------------------------------------------------------------------------
# Bulk email
# ---------------------------------------------------------------------------

GET_TENANT_EMAILS_SQL = text("""
    SELECT DISTINCT u.email
    FROM tenant_members tm
    JOIN users u ON u.user_id = tm.user_id
    WHERE tm.tenant_id = :tenant_id
      AND u.email IS NOT NULL AND u.email != ''
    ORDER BY u.email
""")


class BulkEmailRequest(BaseModel):
    subject: str
    text: str


@router.post(
    "/bulk-email",
    status_code=204,
    summary="Send a bulk email to all users in this tenant (commissioner only)",
)
async def send_bulk_email(
    req: BulkEmailRequest,
    db: AsyncSession = Depends(get_db),
    me=Depends(require_admin),
):
    debug("admin: send_bulk_email called", tenant_id=me.tenant_id, subject=req.subject)
    rows = (await db.execute(GET_TENANT_EMAILS_SQL, {"tenant_id": me.tenant_id})).fetchall()
    emails = [r[0] for r in rows if r[0]]
    ok = send_bulk_email_to_all_users(emails, req.subject, req.text)
    if not ok:
        raise HTTPException(status_code=500, detail="Failed to send bulk email.")
    return Response(status_code=204)


# ---------------------------------------------------------------------------
# XLSX pick import (disabled — needs update for player_id schema)
# ---------------------------------------------------------------------------

@router.post(
    "/import-picks-xlsx",
    status_code=200,
    summary="Bulk import picks from XLSX (commissioner only) — DISABLED",
)
async def import_picks_xlsx_api(
    week: int = Form(...),
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
    _=Depends(require_admin),
):
    """
    Import picks from an XLSX workbook. Only available for the original league (tenant 1);
    this is the legacy interface for Andy's external pick-entry system.
    """
    if me.tenant_id != 1:
        raise HTTPException(
            status_code=403,
            detail="XLSX import is only available for the original league.",
        )

    contents = await file.read()
    with tempfile.NamedTemporaryFile(suffix=".xlsx", delete=False) as tmp:
        tmp.write(contents)
        tmp_path = tmp.name

    import asyncio as _asyncio
    try:
        processed = await _asyncio.to_thread(
            import_picks_pivot_xlsx_with_engine,
            tmp_path,
            week,
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Import failed: {exc}") from exc
    finally:
        os.unlink(tmp_path)

    info("admin: xlsx picks imported", tenant_id=me.tenant_id, week=week, processed=processed)
    return {"processed": processed}
