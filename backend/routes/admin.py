"""
Admin-only endpoints for managing and viewing picks.
"""

#pylint: disable=line-too-long

from __future__ import annotations
import os
import secrets
import string
import tempfile
from typing import List, Optional
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status, Body, Response, UploadFile, File, Form
from pydantic import BaseModel, EmailStr
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from backend.utils.db import get_db
from backend.utils.logger import debug, info, warn
from backend.utils.emailer import send_bulk_email_to_all_users
from backend.utils.import_picks_xlsx import import_picks_pivot_xlsx
from .auth import require_user, require_admin
from .results import WeekPicksRow
from .schedule import get_current_week

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


# ---------------- Lock adjustment APIs ----------------
WEEK_EXISTS_SQL = text("""
    SELECT 1 FROM weeks WHERE week_number = :week
""")

FIRST_KICKOFF_SQL = text("""
    SELECT MIN(kickoff_at) FROM games WHERE week_number = :week
""")

UPDATE_LOCK_SQL = text("""
    UPDATE weeks SET lock_at = :lock_at WHERE week_number = :week
""")

WEEKS_LOCKS_SQL = text("""
    SELECT week_number, lock_at FROM weeks ORDER BY week_number
""")

class WeekLockRow(BaseModel):
    """ The lock time for a given week """
    week_number: int
    lock_at: datetime

@router.get(
    "/weeks/locks",
    response_model=List[WeekLockRow],
    summary="All weeks' lock times (admin only)",
)
async def get_weeks_locks(
    db: AsyncSession = Depends(get_db),
    me=Depends(require_admin),
):
    """Return each week number and its lock_at time."""
    debug("admin: get_weeks_locks called", user=me.pigeon_number)
    rows = (await db.execute(WEEKS_LOCKS_SQL)).fetchall()
    info("admin: weeks lock rows", count=len(rows))
    out: List[WeekLockRow] = []
    for r in rows:
        out.append(WeekLockRow(week_number=r[0], lock_at=r[1]))
    return out

@router.patch(
    "/weeks/{week}/lock",
    status_code=204,
    summary="Adjust lock time for a week (admin only)",
)
async def adjust_week_lock(
    week: int,
    db: AsyncSession = Depends(get_db),
    me=Depends(require_admin),
    lock_at: datetime = Body(..., embed=True, description="New lock time (RFC3339/ISO8601)"),
):
    """
    Adjust the lock time for the given week.

    Rules:
    - Only current or future weeks can be adjusted (no past weeks).
    - Current week can be adjusted only if its state is "scheduled" (no games started).
    - New lock time must be >= now and <= the first scheduled kickoff for that week.
    """
    debug("admin: adjust_week_lock called", user=me.pigeon_number, week=week)

    # Ensure week exists
    exists = (await db.execute(WEEK_EXISTS_SQL, {"week": week})).first()
    if not exists:
        raise HTTPException(status_code=404, detail=f"Week {week} not found")

    # Get current week number and status via schedule API
    current = await get_current_week(db)  # CurrentWeek model
    current_week = int(current.week)
    current_status = str(current.status)

    # Only allow current or future weeks (no past weeks)
    if week < current_week:
        raise HTTPException(status_code=400, detail="Cannot adjust a past week")

    # If adjusting the current playing week, ensure still scheduled
    if week == current_week and current_status != "scheduled":
        raise HTTPException(status_code=400, detail="Current week is not in 'scheduled' state")

    # Normalize input datetime to UTC-aware
    new_lock = lock_at
    if new_lock.tzinfo is None:
        new_lock = new_lock.replace(tzinfo=timezone.utc)
    else:
        new_lock = new_lock.astimezone(timezone.utc)

    # Fetch first kickoff for the requested week
    first_row = (await db.execute(FIRST_KICKOFF_SQL, {"week": week})).first()
    first_kickoff = first_row[0] if first_row else None
    if first_kickoff is None:
        raise HTTPException(status_code=400, detail=f"No games scheduled for week {week}")

    # Calculate the Tuesday before the first kickoff
    tuesday_before = first_kickoff.astimezone(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    # Go backwards to Tuesday
    tuesday_before = tuesday_before.replace(day=tuesday_before.day - ((tuesday_before.weekday() - 1) % 7))
    # Enforce time window: tuesday_before <= lock_at <= first_kickoff
    if new_lock < tuesday_before:
        raise HTTPException(status_code=400, detail="Lock time must be no earlier than the Tuesday before the first scheduled kickoff for that week")
    if new_lock > first_kickoff:
        raise HTTPException(status_code=400, detail="Lock time must be no later than the first scheduled kickoff for that week")

    # Perform the update
    await db.execute(UPDATE_LOCK_SQL, {"week": week, "lock_at": new_lock})
    await db.commit()
    info("admin: week lock updated", week=week, lock_at=new_lock.isoformat())
    return Response(status_code=204)


# ---------------- Pigeon Management APIs ----------------

GET_PIGEONS_SQL = text("""
    SELECT 
        p.pigeon_number,
        p.pigeon_name,
        u.email as owner_email
    FROM players p
    LEFT JOIN user_players up ON p.pigeon_number = up.pigeon_number AND up.role = 'owner'
    LEFT JOIN users u ON up.user_id = u.user_id
    ORDER BY p.pigeon_number
""")

UPDATE_PIGEON_SQL = text("""
    UPDATE players 
    SET pigeon_name = :pigeon_name 
    WHERE pigeon_number = :pigeon_number
""")

GET_USER_ID_BY_EMAIL_SQL = text("""
    SELECT user_id FROM users WHERE LOWER(email) = LOWER(:email)
""")

DELETE_PIGEON_OWNER_SQL = text("""
    DELETE FROM user_players 
    WHERE pigeon_number = :pigeon_number AND role = 'owner'
""")

INSERT_PIGEON_OWNER_SQL = text("""
    INSERT INTO user_players (user_id, pigeon_number, role, is_primary)
    VALUES (:user_id, :pigeon_number, 'owner', TRUE)
""")

CHECK_PIGEON_EXISTS_SQL = text("""
    SELECT 1 FROM players WHERE pigeon_number = :pigeon_number
""")

class PigeonRow(BaseModel):
    """A pigeon with its owner"""
    pigeon_number: int
    pigeon_name: str
    owner_email: Optional[str]

class PigeonUpdate(BaseModel):
    """Update pigeon name and/or owner"""
    pigeon_name: Optional[str] = None
    owner_email: Optional[str] = None

@router.get(
    "/pigeons",
    response_model=List[PigeonRow],
    summary="List all pigeons with their owners (admin only)",
)
async def get_pigeons(
    db: AsyncSession = Depends(get_db),
    me=Depends(require_admin),
):
    """Return all 68 pigeons with their names and owner emails."""
    debug("admin: get_pigeons called", user=me.pigeon_number)
    rows = (await db.execute(GET_PIGEONS_SQL)).fetchall()
    info("admin: pigeons retrieved", count=len(rows))

    out: List[PigeonRow] = []
    for r in rows:
        out.append(PigeonRow(
            pigeon_number=r[0],
            pigeon_name=r[1],
            owner_email=r[2],
        ))
    return out

@router.patch(
    "/pigeons/{pigeon_number}",
    status_code=200,
    summary="Update pigeon name and/or owner (admin only)",
)
async def update_pigeon(
    pigeon_number: int,
    update: PigeonUpdate,
    db: AsyncSession = Depends(get_db),
    me=Depends(require_admin),
):
    """
    Update a pigeon's name and/or owner.
    
    - pigeon_name: New name for the pigeon (optional)
    - owner_email: Email of new owner, or null to unassign (optional)
    """
    debug("admin: update_pigeon called", user=me.pigeon_number, pigeon=pigeon_number)

    # Validate pigeon exists
    exists = (await db.execute(CHECK_PIGEON_EXISTS_SQL, {"pigeon_number": pigeon_number})).first()
    if not exists:
        raise HTTPException(status_code=404, detail=f"Pigeon {pigeon_number} not found")

    # Update name if provided
    if update.pigeon_name is not None:
        await db.execute(UPDATE_PIGEON_SQL, {
            "pigeon_number": pigeon_number,
            "pigeon_name": update.pigeon_name,
        })
        info("admin: pigeon name updated", pigeon=pigeon_number, name=update.pigeon_name)

    # Update owner if provided (including null to unassign)
    if update.owner_email is not None or (hasattr(update, '__fields_set__') and 'owner_email' in update.__fields_set__):
        # Remove existing owner
        await db.execute(DELETE_PIGEON_OWNER_SQL, {"pigeon_number": pigeon_number})

        # Add new owner if email provided
        if update.owner_email:
            user_row = (await db.execute(GET_USER_ID_BY_EMAIL_SQL, {"email": update.owner_email})).first()
            if not user_row:
                await db.rollback()
                raise HTTPException(status_code=404, detail=f"User with email {update.owner_email} not found")

            user_id = user_row[0]
            await db.execute(INSERT_PIGEON_OWNER_SQL, {
                "user_id": user_id,
                "pigeon_number": pigeon_number,
            })
            info("admin: pigeon owner updated", pigeon=pigeon_number, owner=update.owner_email)
        else:
            info("admin: pigeon owner removed", pigeon=pigeon_number)

    await db.commit()
    return Response(status_code=200)


# ---------------- User Management APIs ----------------

GET_USERS_SQL = text("""
    SELECT 
        u.user_id,
        u.email,
        up_primary.pigeon_number as primary_pigeon,
        COALESCE(
            json_agg(up_secondary.pigeon_number ORDER BY up_secondary.pigeon_number) 
            FILTER (WHERE up_secondary.pigeon_number IS NOT NULL),
            '[]'
        ) as secondary_pigeons
    FROM users u
    LEFT JOIN user_players up_primary 
        ON u.user_id = up_primary.user_id AND up_primary.is_primary = TRUE
    LEFT JOIN user_players up_secondary 
        ON u.user_id = up_secondary.user_id 
        AND up_secondary.is_primary = FALSE 
        AND up_secondary.role IN ('manager', 'viewer')
    GROUP BY u.user_id, u.email, up_primary.pigeon_number
    ORDER BY u.email
""")

DELETE_USER_SQL = text("""
    DELETE FROM users WHERE LOWER(email) = LOWER(:email)
""")

CHECK_USER_OWNS_PIGEON_SQL = text("""
    SELECT pigeon_number 
    FROM user_players 
    WHERE user_id = (SELECT user_id FROM users WHERE LOWER(email) = LOWER(:email))
    AND role = 'owner'
    LIMIT 1
""")

DELETE_USER_PIGEONS_SQL = text("""
    DELETE FROM user_players 
    WHERE user_id = (SELECT user_id FROM users WHERE LOWER(email) = LOWER(:email))
""")

INSERT_USER_PRIMARY_SQL = text("""
    INSERT INTO user_players (user_id, pigeon_number, role, is_primary)
    VALUES (
        (SELECT user_id FROM users WHERE LOWER(email) = LOWER(:email)),
        :pigeon_number,
        'manager',
        TRUE
    )
""")

INSERT_USER_SECONDARY_SQL = text("""
    INSERT INTO user_players (user_id, pigeon_number, role, is_primary)
    VALUES (
        (SELECT user_id FROM users WHERE LOWER(email) = LOWER(:email)),
        :pigeon_number,
        'manager',
        FALSE
    )
""")

INSERT_USER_SQL = text("""
    INSERT INTO users (email, password_hash, is_admin)
    VALUES (:email, :password_hash, FALSE)
    RETURNING user_id
""")

class UserRow(BaseModel):
    """A user with their pigeon assignments"""
    email: str
    primary_pigeon: Optional[int]
    secondary_pigeons: List[int]

class UserUpdate(BaseModel):
    """Update user's pigeon assignments"""
    primary_pigeon: Optional[int] = None
    secondary_pigeons: List[int] = []

class UserCreate(BaseModel):
    """Create a new user"""
    email: EmailStr

def generate_random_password_hash(length: int = 16) -> str:
    """Generate a random password for new users"""
    alphabet = string.ascii_letters + string.digits + string.punctuation
    return ''.join(secrets.choice(alphabet) for _ in range(length))

@router.get(
    "/users",
    response_model=List[UserRow],
    summary="List all users with their pigeon assignments (admin only)",
)
async def get_users(
    db: AsyncSession = Depends(get_db),
    me=Depends(require_admin),
):
    """Return all users with their primary and secondary pigeons."""
    debug("admin: get_users called", user=me.pigeon_number)
    rows = (await db.execute(GET_USERS_SQL)).fetchall()
    info("admin: users retrieved", count=len(rows))

    out: List[UserRow] = []
    for r in rows:
        out.append(UserRow(
            email=r[1],
            primary_pigeon=r[2],
            secondary_pigeons=r[3] if r[3] else [],
        ))
    return out

@router.post(
    "/users",
    status_code=201,
    response_model=UserRow,
    summary="Create a new user (admin only)",
)
async def create_user(
    user: UserCreate,
    db: AsyncSession = Depends(get_db),
    me=Depends(require_admin),
):
    """
    Create a new user with a random password.
    User will need to reset password on first login.
    """
    debug("admin: create_user called", user=me.pigeon_number, email=user.email)

    # Check if user already exists
    existing = (await db.execute(GET_USER_ID_BY_EMAIL_SQL, {"email": user.email})).first()
    if existing:
        raise HTTPException(status_code=409, detail=f"User with email {user.email} already exists")

    # Generate random password hash
    password_hash = generate_random_password_hash()

    # Insert user
    await db.execute(INSERT_USER_SQL, {
        "email": user.email,
        "password_hash": password_hash,
    })
    await db.commit()

    info("admin: user created", email=user.email)

    return UserRow(
        email=user.email,
        primary_pigeon=None,
        secondary_pigeons=[],
    )

@router.put(
    "/users/{email}",
    status_code=200,
    summary="Update user's pigeon assignments (admin only)",
)
async def update_user(
    email: str,
    update: UserUpdate,
    db: AsyncSession = Depends(get_db),
    me=Depends(require_admin),
):
    """
    Update a user's primary and secondary pigeon assignments.
    Replaces all existing assignments.
    """
    debug("admin: update_user called", user=me.pigeon_number, email=email)

    # Validate user exists
    user_row = (await db.execute(GET_USER_ID_BY_EMAIL_SQL, {"email": email})).first()
    if not user_row:
        raise HTTPException(status_code=404, detail=f"User with email {email} not found")

    # Delete all existing pigeon assignments
    await db.execute(DELETE_USER_PIGEONS_SQL, {"email": email})

    # Add primary pigeon if specified
    if update.primary_pigeon is not None:
        await db.execute(INSERT_USER_PRIMARY_SQL, {
            "email": email,
            "pigeon_number": update.primary_pigeon,
        })
        info("admin: user primary pigeon set", email=email, pigeon=update.primary_pigeon)

    # Add secondary pigeons
    for pigeon_num in update.secondary_pigeons:
        await db.execute(INSERT_USER_SECONDARY_SQL, {
            "email": email,
            "pigeon_number": pigeon_num,
        })

    if update.secondary_pigeons:
        info("admin: user secondary pigeons set", email=email, pigeons=update.secondary_pigeons)

    await db.commit()
    return Response(status_code=200)

@router.delete(
    "/users/{email}",
    status_code=204,
    summary="Delete a user (admin only)",
)
async def delete_user(
    email: str,
    db: AsyncSession = Depends(get_db),
    me=Depends(require_admin),
):
    """
    Delete a user. Returns 409 if user owns a pigeon.
    """
    debug("admin: delete_user called", user=me.pigeon_number, email=email)

    # Check if user owns any pigeon
    owned = (await db.execute(CHECK_USER_OWNS_PIGEON_SQL, {"email": email})).first()
    if owned:
        raise HTTPException(
            status_code=409,
            detail=f"User owns pigeon #{owned[0]}. Reassign ownership first."
        )

    # Delete user (cascade will handle user_players)
    result = await db.execute(DELETE_USER_SQL, {"email": email})

    if result.rowcount == 0:
        raise HTTPException(status_code=404, detail=f"User with email {email} not found")

    await db.commit()
    info("admin: user deleted", email=email)
    return Response(status_code=204)

# --- Bulk Email API ---
class BulkEmailRequest(BaseModel):
    """ Request body for bulk email """
    subject: str
    text: str


# SQL to fetch all user emails
GET_ALL_USER_EMAILS_SQL = text("""
    SELECT DISTINCT email
    FROM users
    WHERE email IS NOT NULL AND email != ''
    ORDER BY email
""")

@router.post(
    "/bulk-email",
    status_code=204,
    summary="Send a bulk email to all users (admin only)",
)
async def send_bulk_email(
    req: BulkEmailRequest,
    db: AsyncSession = Depends(get_db),
    me=Depends(require_admin),
):
    """Send a plain text email to all users."""
    debug("admin: send_bulk_email called", user=me.pigeon_number, subject=req.subject)
    rows = (await db.execute(GET_ALL_USER_EMAILS_SQL)).fetchall()
    emails = [r[0] for r in rows if r[0]]
    ok = send_bulk_email_to_all_users(emails, req.subject, req.text)
    if not ok:
        raise HTTPException(status_code=500, detail="Failed to send bulk email.")
    return Response(status_code=204)

# -----------------------------------------------------------------------------
# Bulk Import Picks from XLSX (Admin)
# -----------------------------------------------------------------------------
@router.post(
    "/import-picks-xlsx",
    status_code=200,
    summary="Bulk import picks from XLSX for a given week (admin only)",
)
async def import_picks_xlsx_api(
    week: int = Form(...),
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
    _=Depends(require_admin),  # noqa: ARG001
):
    """Import picks for a given week from an uploaded XLSX file."""
    if not 1 <= week <= 18:
        raise HTTPException(status_code=400, detail="Week must be between 1 and 18.")
    # Save uploaded file to a temp file
    with tempfile.NamedTemporaryFile(delete=False, suffix=".xlsx") as tmp:
        contents = await file.read()
        tmp.write(contents)
        tmp_path = tmp.name
    try:
        # Use a sync connection for compatibility with import_picks_pivot_xlsx
        sync_conn = await db.connection()
        raw_conn = sync_conn.connection
        processed = import_picks_pivot_xlsx(xlsx_path=tmp_path, conn=raw_conn, only_week=week)
        await db.commit()
    except Exception as e:
        await db.rollback()
        raise HTTPException(status_code=500, detail=f"Import failed: {e}") from e
    finally:
        os.unlink(tmp_path)
    return {"processed": processed}
