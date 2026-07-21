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
from typing import List, Optional, Literal
from datetime import datetime, timezone, timedelta

from fastapi import APIRouter, Depends, HTTPException, status, Body, Response, UploadFile, File, Form
from pydantic import BaseModel, EmailStr, Field, field_validator, model_validator
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from backend.utils.import_picks_xlsx import import_picks_pivot_xlsx_with_engine
from backend.utils.db import get_db
from backend.utils.logger import debug, info, warn
from backend.utils.emailer import send_bulk_email_to_all_users
from backend.utils.validation import validate_pigeon_name
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

UPDATE_TENANT_RENAME_SETTING_SQL = text("""
    UPDATE tenants SET pigeons_can_rename = :pigeons_can_rename WHERE tenant_id = :tenant_id
""")


class LeagueUpdate(BaseModel):
    name: Optional[str] = None
    pigeons_can_rename: Optional[bool] = None


@router.patch(
    "/league",
    status_code=204,
    summary="Update this league's name and/or settings (commissioner only)",
)
async def update_league(
    update: LeagueUpdate,
    db: AsyncSession = Depends(get_db),
    me=Depends(require_admin),
):
    if update.name is not None:
        name = update.name.strip()
        if not name:
            raise HTTPException(status_code=400, detail="League name cannot be empty")
        await db.execute(UPDATE_TENANT_NAME_SQL, {"name": name, "tenant_id": me.tenant_id})
        info("admin: league renamed", tenant_id=me.tenant_id, name=name)

    if update.pigeons_can_rename is not None:
        await db.execute(UPDATE_TENANT_RENAME_SETTING_SQL, {
            "pigeons_can_rename": update.pigeons_can_rename,
            "tenant_id": me.tenant_id,
        })
        info("admin: pigeons_can_rename updated", tenant_id=me.tenant_id, value=update.pigeons_can_rename)

    await db.commit()
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

GET_ROSTER_SQL = text("""
    SELECT
        p.player_id,
        p.pigeon_number,
        p.pigeon_name,
        p.season_status,
        u.user_id,
        u.email,
        up.role,
        COALESCE(tm.primary_player_id = p.player_id, FALSE) AS is_primary
    FROM players p
    LEFT JOIN user_players up
      ON up.player_id = p.player_id
     AND up.role IN ('owner', 'manager')
    LEFT JOIN users u ON u.user_id = up.user_id
    LEFT JOIN tenant_members tm
      ON tm.tenant_id = p.tenant_id
     AND tm.user_id = up.user_id
    WHERE p.tenant_id = :tenant_id
    ORDER BY
        p.pigeon_number,
        CASE up.role WHEN 'owner' THEN 0 ELSE 1 END,
        LOWER(u.email)
""")

GET_PLAYER_FOR_UPDATE_SQL = text("""
    SELECT player_id
    FROM players
    WHERE player_id = :player_id AND tenant_id = :tenant_id
    FOR UPDATE
""")

NEXT_PIGEON_NUMBER_SQL = text("""
    SELECT candidate
    FROM generate_series(
        1,
        (SELECT COUNT(*) + 1 FROM players WHERE tenant_id = :tenant_id)
    ) AS numbers(candidate)
    WHERE NOT EXISTS (
        SELECT 1
        FROM players p
        WHERE p.tenant_id = :tenant_id
          AND p.pigeon_number = candidate
    )
    ORDER BY candidate
    LIMIT 1
""")

CREATE_PLAYER_SQL = text("""
    INSERT INTO players (
        tenant_id,
        pigeon_number,
        pigeon_name,
        season_status
    )
    VALUES (
        :tenant_id,
        :pigeon_number,
        :pigeon_name,
        :season_status
    )
    ON CONFLICT (tenant_id, pigeon_number) DO NOTHING
    RETURNING player_id
""")

UPDATE_PLAYER_SQL = text("""
    UPDATE players
    SET pigeon_name = :pigeon_name,
        season_status = :season_status
    WHERE player_id = :player_id AND tenant_id = :tenant_id
""")

DELETE_PLAYER_SQL = text("""
    DELETE FROM players
    WHERE player_id = :player_id AND tenant_id = :tenant_id
""")

GET_USER_BY_EMAIL_SQL = text("""
    SELECT user_id, email
    FROM users
    WHERE LOWER(email) = LOWER(:email)
""")

INSERT_USER_SQL = text("""
    INSERT INTO users (email, password_hash)
    VALUES (:email, :password_hash)
    ON CONFLICT DO NOTHING
    RETURNING user_id, email
""")

GET_ACTIVE_PLAYER_ASSIGNMENTS_SQL = text("""
    SELECT up.user_id, up.role
    FROM user_players up
    WHERE up.player_id = :player_id
      AND up.role IN ('owner', 'manager')
""")

UPSERT_PLAYER_ASSIGNMENT_SQL = text("""
    INSERT INTO user_players (user_id, player_id, role)
    VALUES (:user_id, :player_id, :role)
    ON CONFLICT (user_id, player_id) DO UPDATE SET role = EXCLUDED.role
""")

DELETE_PLAYER_ASSIGNMENT_SQL = text("""
    DELETE FROM user_players
    WHERE user_id = :user_id
      AND player_id = :player_id
      AND role IN ('owner', 'manager')
""")

GET_PRIMARY_USERS_FOR_PLAYER_SQL = text("""
    SELECT user_id
    FROM tenant_members
    WHERE tenant_id = :tenant_id
      AND primary_player_id = :player_id
""")

GET_ALL_PLAYER_USERS_SQL = text("""
    SELECT user_id
    FROM user_players
    WHERE player_id = :player_id
    UNION
    SELECT user_id
    FROM tenant_members
    WHERE tenant_id = :tenant_id
      AND primary_player_id = :player_id
""")

GET_TENANT_MEMBER_SQL = text("""
    SELECT tm.role, tm.primary_player_id, u.email
    FROM tenant_members tm
    JOIN users u ON u.user_id = tm.user_id
    WHERE tm.tenant_id = :tenant_id
      AND tm.user_id = :user_id
""")

GET_USER_ACTIVE_ASSIGNMENTS_SQL = text("""
    SELECT p.player_id, p.pigeon_number
    FROM user_players up
    JOIN players p ON p.player_id = up.player_id
    WHERE up.user_id = :user_id
      AND p.tenant_id = :tenant_id
      AND up.role IN ('owner', 'manager')
    ORDER BY p.pigeon_number, p.player_id
""")

GET_USER_ACTIVE_ASSIGNMENTS_EXCLUDING_SQL = text("""
    SELECT p.player_id, p.pigeon_number
    FROM user_players up
    JOIN players p ON p.player_id = up.player_id
    WHERE up.user_id = :user_id
      AND p.tenant_id = :tenant_id
      AND p.player_id <> :exclude_player_id
      AND up.role IN ('owner', 'manager')
    ORDER BY p.pigeon_number, p.player_id
""")

GET_USER_VIEWER_ASSIGNMENT_SQL = text("""
    SELECT 1
    FROM user_players up
    JOIN players p ON p.player_id = up.player_id
    WHERE up.user_id = :user_id
      AND p.tenant_id = :tenant_id
      AND up.role = 'viewer'
    LIMIT 1
""")

GET_USER_VIEWER_ASSIGNMENT_EXCLUDING_SQL = text("""
    SELECT 1
    FROM user_players up
    JOIN players p ON p.player_id = up.player_id
    WHERE up.user_id = :user_id
      AND p.tenant_id = :tenant_id
      AND p.player_id <> :exclude_player_id
      AND up.role = 'viewer'
    LIMIT 1
""")

INSERT_TENANT_MEMBER_SQL = text("""
    INSERT INTO tenant_members (tenant_id, user_id, role, primary_player_id)
    VALUES (:tenant_id, :user_id, 'member', :primary_player_id)
    ON CONFLICT (tenant_id, user_id) DO NOTHING
""")

UPDATE_TENANT_MEMBER_PRIMARY_SQL = text("""
    UPDATE tenant_members
    SET primary_player_id = :primary_player_id
    WHERE tenant_id = :tenant_id
      AND user_id = :user_id
""")

DELETE_TENANT_MEMBER_SQL = text("""
    DELETE FROM tenant_members
    WHERE tenant_id = :tenant_id
      AND user_id = :user_id
""")


class PigeonPerson(BaseModel):
    user_id: int
    email: EmailStr
    is_primary: bool

class PigeonRow(BaseModel):
    player_id: int
    pigeon_number: int
    pigeon_name: str
    season_status: Literal["pending", "active", "out"]
    owner: Optional[PigeonPerson]
    managers: List[PigeonPerson] = Field(default_factory=list)


class PigeonAggregateIn(BaseModel):
    pigeon_name: str
    owner_email: EmailStr
    manager_emails: List[EmailStr] = Field(default_factory=list)

    @field_validator("pigeon_name")
    @classmethod
    def _validate_pigeon_name(cls, v: str) -> str:
        return validate_pigeon_name(v)

    @model_validator(mode="after")
    def _validate_people(self):
        owner = str(self.owner_email).strip().casefold()
        managers = [str(email).strip().casefold() for email in self.manager_emails]
        if len(managers) != len(set(managers)):
            raise ValueError("Additional manager emails must be unique")
        if owner in managers:
            raise ValueError("Owner cannot also be an additional manager")
        return self


class PigeonCreate(PigeonAggregateIn):
    season_status: Literal["pending", "active", "out"] = "pending"


class PigeonUpdate(PigeonAggregateIn):
    season_status: Literal["pending", "active", "out"]


def _random_password_hash(length: int = 16) -> str:
    alphabet = string.ascii_letters + string.digits + string.punctuation
    return "".join(secrets.choice(alphabet) for _ in range(length))


def _normalize_email(email: EmailStr | str) -> str:
    return str(email).strip().casefold()


def _build_roster(rows) -> List[PigeonRow]:
    pigeons: dict[int, dict] = {}
    for row in rows:
        player_id = row[0]
        if player_id not in pigeons:
            pigeons[player_id] = {
                "player_id": player_id,
                "pigeon_number": row[1],
                "pigeon_name": row[2],
                "season_status": row[3],
                "owner": None,
                "managers": [],
            }
        if row[4] is None:
            continue
        person = PigeonPerson(user_id=row[4], email=row[5], is_primary=bool(row[7]))
        if row[6] == "owner":
            pigeons[player_id]["owner"] = person
        elif row[6] == "manager":
            pigeons[player_id]["managers"].append(person)
    return [PigeonRow(**pigeon) for pigeon in pigeons.values()]


async def _load_roster(db: AsyncSession, tenant_id: int) -> List[PigeonRow]:
    rows = (await db.execute(GET_ROSTER_SQL, {"tenant_id": tenant_id})).fetchall()
    return _build_roster(rows)


async def _load_pigeon(db: AsyncSession, tenant_id: int, player_id: int) -> Optional[PigeonRow]:
    return next(
        (pigeon for pigeon in await _load_roster(db, tenant_id) if pigeon.player_id == player_id),
        None,
    )


async def _find_or_create_user(db: AsyncSession, email: EmailStr | str) -> tuple[int, str]:
    normalized = _normalize_email(email)
    existing = (await db.execute(GET_USER_BY_EMAIL_SQL, {"email": normalized})).first()
    if existing:
        return existing[0], existing[1]

    created = (await db.execute(INSERT_USER_SQL, {
        "email": normalized,
        "password_hash": _random_password_hash(),
    })).first()
    if created:
        return created[0], created[1]

    # Another tenant may have created this global identity concurrently.
    existing = (await db.execute(GET_USER_BY_EMAIL_SQL, {"email": normalized})).first()
    if not existing:
        raise RuntimeError(f"Unable to find or create user {normalized}")
    return existing[0], existing[1]


async def _repair_tenant_membership(
    db: AsyncSession,
    tenant_id: int,
    user_id: int,
    *,
    preferred_player_id: Optional[int] = None,
    exclude_player_id: Optional[int] = None,
) -> None:
    params = {"tenant_id": tenant_id, "user_id": user_id}
    if exclude_player_id is None:
        assignment_rows = (await db.execute(GET_USER_ACTIVE_ASSIGNMENTS_SQL, params)).fetchall()
        viewer = (await db.execute(GET_USER_VIEWER_ASSIGNMENT_SQL, params)).first()
    else:
        params["exclude_player_id"] = exclude_player_id
        assignment_rows = (await db.execute(GET_USER_ACTIVE_ASSIGNMENTS_EXCLUDING_SQL, params)).fetchall()
        viewer = (await db.execute(GET_USER_VIEWER_ASSIGNMENT_EXCLUDING_SQL, params)).first()

    membership = (await db.execute(GET_TENANT_MEMBER_SQL, {
        "tenant_id": tenant_id,
        "user_id": user_id,
    })).first()

    if not assignment_rows:
        if not membership:
            return
        if membership[0] == "commissioner":
            raise HTTPException(
                status_code=409,
                detail=f"Commissioner {membership[2]} must remain assigned to at least one pigeon",
            )
        if viewer:
            raise HTTPException(
                status_code=409,
                detail=f"Cannot remove {membership[2]}'s final managed pigeon while viewer assignments remain",
            )
        await db.execute(DELETE_TENANT_MEMBER_SQL, {"tenant_id": tenant_id, "user_id": user_id})
        return

    assignment_ids = [row[0] for row in assignment_rows]
    if not membership:
        primary_player_id = (
            preferred_player_id
            if preferred_player_id in assignment_ids
            else assignment_ids[0]
        )
        await db.execute(INSERT_TENANT_MEMBER_SQL, {
            "tenant_id": tenant_id,
            "user_id": user_id,
            "primary_player_id": primary_player_id,
        })
        return

    if membership[1] not in assignment_ids:
        await db.execute(UPDATE_TENANT_MEMBER_PRIMARY_SQL, {
            "tenant_id": tenant_id,
            "user_id": user_id,
            "primary_player_id": assignment_ids[0],
        })


async def _replace_player_assignments(
    db: AsyncSession,
    player_id: int,
    desired_roles: dict[int, str],
) -> set[int]:
    rows = (await db.execute(GET_ACTIVE_PLAYER_ASSIGNMENTS_SQL, {"player_id": player_id})).fetchall()
    existing_roles = {row[0]: row[1] for row in rows}
    affected_user_ids = set(existing_roles) | set(desired_roles)

    existing_owner_id = next(
        (user_id for user_id, role in existing_roles.items() if role == "owner"),
        None,
    )
    desired_owner_id = next(user_id for user_id, role in desired_roles.items() if role == "owner")

    # Release the partial single-owner constraint before promoting a new owner.
    if existing_owner_id is not None and existing_owner_id != desired_owner_id:
        if desired_roles.get(existing_owner_id) == "manager":
            await db.execute(UPSERT_PLAYER_ASSIGNMENT_SQL, {
                "user_id": existing_owner_id,
                "player_id": player_id,
                "role": "manager",
            })
        else:
            await db.execute(DELETE_PLAYER_ASSIGNMENT_SQL, {
                "user_id": existing_owner_id,
                "player_id": player_id,
            })

    for user_id, role in existing_roles.items():
        if role == "manager" and user_id not in desired_roles:
            await db.execute(DELETE_PLAYER_ASSIGNMENT_SQL, {
                "user_id": user_id,
                "player_id": player_id,
            })

    for user_id, role in desired_roles.items():
        if existing_roles.get(user_id) != role:
            await db.execute(UPSERT_PLAYER_ASSIGNMENT_SQL, {
                "user_id": user_id,
                "player_id": player_id,
                "role": role,
            })

    return affected_user_ids


def _roster_conflict(exc: IntegrityError) -> HTTPException:
    detail = str(exc.orig).lower()
    if "pigeon_name" in detail or "players_tenant_id_pigeon_name_key" in detail:
        return HTTPException(status_code=409, detail="That pigeon name is already in use")
    return HTTPException(status_code=409, detail="Roster change conflicts with existing data")


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
    """Atomically create a pigeon with its required owner and optional managers."""
    debug("admin: create_pigeon called", tenant_id=me.tenant_id, name=pigeon.pigeon_name)

    try:
        async with db.begin():
            current = await get_current_week(db, me)
            if current.any_locked:
                raise HTTPException(status_code=409, detail="Season has started; pigeons can no longer be added")

            player_id = None
            pigeon_number = None
            for _ in range(3):
                number_row = (await db.execute(NEXT_PIGEON_NUMBER_SQL, {"tenant_id": me.tenant_id})).first()
                if number_row is None:
                    continue
                pigeon_number = number_row[0]
                created = (await db.execute(CREATE_PLAYER_SQL, {
                    "tenant_id": me.tenant_id,
                    "pigeon_number": pigeon_number,
                    "pigeon_name": pigeon.pigeon_name,
                    "season_status": pigeon.season_status,
                })).first()
                if created:
                    player_id = created[0]
                    break
            if player_id is None:
                raise HTTPException(status_code=409, detail="Could not allocate a pigeon number; please retry")

            owner_id, _ = await _find_or_create_user(db, pigeon.owner_email)
            desired_roles = {owner_id: "owner"}
            for manager_email in pigeon.manager_emails:
                manager_id, _ = await _find_or_create_user(db, manager_email)
                desired_roles[manager_id] = "manager"

            for user_id, role in desired_roles.items():
                await db.execute(UPSERT_PLAYER_ASSIGNMENT_SQL, {
                    "user_id": user_id,
                    "player_id": player_id,
                    "role": role,
                })
                await _repair_tenant_membership(
                    db,
                    me.tenant_id,
                    user_id,
                    preferred_player_id=player_id,
                )

            created_pigeon = await _load_pigeon(db, me.tenant_id, player_id)
            if created_pigeon is None:
                raise RuntimeError("Created pigeon could not be reloaded")
    except IntegrityError as exc:
        raise _roster_conflict(exc) from exc

    info("admin: pigeon created", tenant_id=me.tenant_id, player_id=player_id, pigeon_number=pigeon_number)
    return created_pigeon


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
    pigeons = await _load_roster(db, me.tenant_id)
    info("admin: pigeons retrieved", count=len(pigeons))
    return pigeons


@router.put(
    "/pigeons/{player_id}",
    status_code=200,
    response_model=PigeonRow,
    summary="Replace a pigeon's roster aggregate (commissioner only)",
)
async def update_pigeon(
    player_id: int,
    update: PigeonUpdate,
    db: AsyncSession = Depends(get_db),
    me=Depends(require_admin),
):
    debug("admin: update_pigeon called", tenant_id=me.tenant_id, player_id=player_id)
    try:
        async with db.begin():
            exists = (await db.execute(GET_PLAYER_FOR_UPDATE_SQL, {
                "player_id": player_id,
                "tenant_id": me.tenant_id,
            })).first()
            if not exists:
                raise HTTPException(status_code=404, detail=f"Player {player_id} not found in this tenant")

            existing_rows = (await db.execute(GET_ACTIVE_PLAYER_ASSIGNMENTS_SQL, {
                "player_id": player_id,
            })).fetchall()
            affected_user_ids = {row[0] for row in existing_rows}
            primary_rows = (await db.execute(GET_PRIMARY_USERS_FOR_PLAYER_SQL, {
                "tenant_id": me.tenant_id,
                "player_id": player_id,
            })).fetchall()
            affected_user_ids.update(row[0] for row in primary_rows)

            owner_id, _ = await _find_or_create_user(db, update.owner_email)
            desired_roles = {owner_id: "owner"}
            for manager_email in update.manager_emails:
                manager_id, _ = await _find_or_create_user(db, manager_email)
                desired_roles[manager_id] = "manager"

            affected_user_ids.update(await _replace_player_assignments(db, player_id, desired_roles))
            await db.execute(UPDATE_PLAYER_SQL, {
                "tenant_id": me.tenant_id,
                "player_id": player_id,
                "pigeon_name": update.pigeon_name,
                "season_status": update.season_status,
            })

            for user_id in affected_user_ids:
                await _repair_tenant_membership(
                    db,
                    me.tenant_id,
                    user_id,
                    preferred_player_id=player_id if user_id in desired_roles else None,
                )

            updated_pigeon = await _load_pigeon(db, me.tenant_id, player_id)
            if updated_pigeon is None:
                raise RuntimeError("Updated pigeon could not be reloaded")
    except IntegrityError as exc:
        raise _roster_conflict(exc) from exc

    info("admin: pigeon updated", tenant_id=me.tenant_id, player_id=player_id)
    return updated_pigeon


@router.delete(
    "/pigeons/{player_id}",
    status_code=204,
    summary="Delete a pigeon (commissioner only)",
)
async def delete_pigeon(
    player_id: int,
    db: AsyncSession = Depends(get_db),
    me=Depends(require_admin),
):
    """Atomically delete a preseason pigeon and repair affected memberships."""
    debug("admin: delete_pigeon called", tenant_id=me.tenant_id, player_id=player_id)

    async with db.begin():
        current = await get_current_week(db, me)
        if current.any_locked:
            raise HTTPException(status_code=409, detail="Season has started; pigeons can no longer be deleted")

        exists = (await db.execute(GET_PLAYER_FOR_UPDATE_SQL, {
            "player_id": player_id,
            "tenant_id": me.tenant_id,
        })).first()
        if not exists:
            raise HTTPException(status_code=404, detail=f"Player {player_id} not found in this tenant")

        affected_rows = (await db.execute(GET_ALL_PLAYER_USERS_SQL, {
            "tenant_id": me.tenant_id,
            "player_id": player_id,
        })).fetchall()
        for row in affected_rows:
            await _repair_tenant_membership(
                db,
                me.tenant_id,
                row[0],
                exclude_player_id=player_id,
            )

        await db.execute(DELETE_PLAYER_SQL, {"player_id": player_id, "tenant_id": me.tenant_id})

    info("admin: pigeon deleted", tenant_id=me.tenant_id, player_id=player_id)
    return Response(status_code=204)


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
    _: AsyncSession = Depends(get_db),
    me=Depends(require_admin),
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
