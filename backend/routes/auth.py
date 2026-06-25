"""
Authentication-related endpoints and helpers, using email/password and bearer tokens.

JWT token shape (Stage 5+):
  sub  = str(player_id)   -- stable player identity
  uid  = user_id          -- for DB joins
  tid  = tenant_id        -- active tenant scope
  typ  = "session"
  iat, exp
"""

# pylint: disable=line-too-long

from datetime import datetime, timedelta, timezone
import os
import binascii
from typing import List, Optional, Tuple
import re

import jwt
import psycopg
from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials

from passlib.hash import bcrypt
from pydantic import BaseModel, EmailStr

from backend.utils.settings import get_settings
from backend.utils.logger import debug, info, warn, error
from backend.utils.emailer import send_email

# --- Config ---
S = get_settings()
DB_CFG = S.psycopg_kwargs()
JWT_SECRET = S.jwt_secret
JWT_ALG = S.jwt_alg
FRONTEND_ORIGIN = S.frontend_origins[0]
RESET_TTL_MINUTES = S.reset_ttl_minutes
SESSION_MINUTES = S.session_minutes
SLIDE_THRESHOLD_SECONDS = S.slide_threshold_seconds

bearer = HTTPBearer(
    auto_error=False,
    scheme_name="BearerAuth",
    bearerFormat="JWT",
)

# --- DB helper ---
def db():
    return psycopg.connect(**DB_CFG)

# --- Models ---
class LoginIn(BaseModel):
    email: EmailStr
    password: str

class AltPigeon(BaseModel):
    pigeon_number: int
    pigeon_name: str

class TenantInfo(BaseModel):
    tenant_id: int
    name: str
    role: str  # 'commissioner' or 'member'

class MeOut(BaseModel):
    player_id: int
    pigeon_number: int
    pigeon_name: str
    email: EmailStr
    is_admin: bool
    tenant_id: int
    session: dict
    alt_pigeons: List[AltPigeon] = []
    available_tenants: List[TenantInfo] = []

class LoginOut(BaseModel):
    ok: bool
    access_token: str
    token_type: str = "bearer"
    expires_at: str
    user: MeOut

class SelectContextIn(BaseModel):
    tenant_id: int

class PasswordResetRequestIn(BaseModel):
    email: EmailStr

class PasswordResetConfirmIn(BaseModel):
    token: str
    new_password: str

# --- JWT helpers ---
def make_session_token(player_id: int, tenant_id: int, email: str, uid: int) -> tuple[str, int]:
    """Create a session JWT and return (token, exp_epoch_seconds)."""
    now = datetime.now(timezone.utc)
    exp = now + timedelta(minutes=SESSION_MINUTES)
    exp_epoch = int(exp.timestamp())
    payload = {
        "sub": str(player_id),
        "uid": uid,
        "tid": tenant_id,
        "email": email,
        "typ": "session",
        "iat": int(now.timestamp()),
        "exp": exp_epoch,
    }
    token = jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALG)
    return token, exp_epoch

def parse_session_token(token: str) -> dict:
    try:
        data = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALG])
    except jwt.PyJWTError as exc:
        warn(f"Session token decode error: {exc}")
        raise HTTPException(status_code=401, detail="Invalid or expired session") from exc
    if data.get("typ") != "session":
        raise HTTPException(status_code=401, detail="Wrong token type")
    return data

# --- Queries ---
def find_user(cur, email: str) -> Optional[Tuple]:
    """Returns (user_id, email, password_hash) or None."""
    cur.execute(
        "SELECT user_id, email, password_hash FROM users WHERE lower(email) = lower(%s)",
        (email.strip(),)
    )
    return cur.fetchone()

def select_tenant_context(cur, user_id: int, tenant_id: int = None) -> Optional[Tuple]:
    """
    Pick the tenant context for a user.
    If tenant_id is given, validate membership in that specific tenant.
    Otherwise, auto-select: most-recently-used first, then any tenant.
    Returns (player_id, pigeon_number, pigeon_name, tenant_id, is_commissioner, tenant_name) or None.
    """
    if tenant_id is not None:
        cur.execute("""
            SELECT p.player_id, p.pigeon_number, p.pigeon_name,
                   tm.tenant_id, (tm.role = 'commissioner') AS is_admin,
                   t.name
              FROM tenant_members tm
              JOIN players p ON p.player_id = tm.primary_player_id
              JOIN tenants t ON t.tenant_id = tm.tenant_id
             WHERE tm.user_id = %s AND tm.tenant_id = %s
        """, (user_id, tenant_id))
    else:
        cur.execute("""
            SELECT p.player_id, p.pigeon_number, p.pigeon_name,
                   tm.tenant_id, (tm.role = 'commissioner') AS is_admin,
                   t.name
              FROM tenant_members tm
              JOIN players p ON p.player_id = tm.primary_player_id
              JOIN tenants t ON t.tenant_id = tm.tenant_id
             WHERE tm.user_id = %s
             ORDER BY tm.last_used_at DESC NULLS LAST
             LIMIT 1
        """, (user_id,))
    return cur.fetchone()

def set_last_used_at(cur, user_id: int, tenant_id: int) -> None:
    cur.execute(
        "UPDATE tenant_members SET last_used_at = now() WHERE user_id = %s AND tenant_id = %s",
        (user_id, tenant_id)
    )

def get_available_tenants(cur, user_id: int) -> List[TenantInfo]:
    cur.execute("""
        SELECT t.tenant_id, t.name, tm.role
          FROM tenant_members tm
          JOIN tenants t ON t.tenant_id = tm.tenant_id
         WHERE tm.user_id = %s
         ORDER BY tm.last_used_at DESC NULLS LAST, t.name
    """, (user_id,))
    return [
        TenantInfo(tenant_id=r[0], name=r[1], role=r[2])
        for r in cur.fetchall()
    ]

# --- Password reset helpers ---
def make_reset_token(user_id: int) -> str:
    now = datetime.now(timezone.utc)
    exp = now + timedelta(minutes=RESET_TTL_MINUTES)
    jti = binascii.hexlify(os.urandom(16)).decode()
    payload = {
        "sub": str(user_id),
        "typ": "reset",
        "jti": jti,
        "iat": int(now.timestamp()),
        "exp": int(exp.timestamp()),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALG)

def parse_reset_token(token: str) -> dict:
    try:
        data = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALG])
    except jwt.PyJWTError as exc:
        raise HTTPException(status_code=401, detail="Invalid or expired reset token") from exc
    if data.get("typ") != "reset":
        raise HTTPException(status_code=401, detail="Wrong token type")
    if "sub" not in data or "jti" not in data:
        raise HTTPException(status_code=401, detail="Malformed reset token")
    return data

def ensure_reset_table(conn: psycopg.Connection) -> None:
    with conn.cursor() as cur:
        cur.execute("""
            CREATE TABLE IF NOT EXISTS password_reset_uses (
              jti TEXT PRIMARY KEY,
              user_id BIGINT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
              used_at TIMESTAMPTZ NOT NULL DEFAULT now()
            );
        """)
        conn.commit()

def jti_already_used(cur: psycopg.Cursor, jti: str) -> bool:
    cur.execute("SELECT 1 FROM password_reset_uses WHERE jti = %s", (jti,))
    return cur.fetchone() is not None

def mark_jti_used(cur: psycopg.Cursor, jti: str, user_id: int) -> None:
    cur.execute(
        "INSERT INTO password_reset_uses (jti, user_id) VALUES (%s, %s) ON CONFLICT DO NOTHING",
        (jti, user_id),
    )

def sent_password_reset_email(to_email: str, token: str) -> None:
    origins = S.frontend_origins
    if isinstance(origins, list):
        base_url = origins[0] if origins else ""
    elif isinstance(origins, str):
        m = re.search(r"https?://[^,\]\[]+", origins)
        base_url = m.group(0) if m else ""
    else:
        base_url = ""

    subject = "Pigeon Pool Password Reset"
    plain_text = (
        "You requested a password reset for your Pigeon Pool account.\n\n"
        "If you did not make this request, you can ignore this email.\n\n"
        "To reset your password, click the link below:\n\n"
        f"{base_url}/reset-password?token={token}\n\n"
        "This link will expire in 30 minutes."
    )
    html = (
        "<p>You requested a password reset for your Pigeon Pool account.</p>"
        "<p>If you did not make this request, you can ignore this email.</p>"
        "<p>To reset your password, click the link below:</p>"
        f'<p><a href="{base_url}/reset-password?token={token}">Reset Password</a></p>'
        "<p>This link will expire in 30 minutes.</p>"
    )
    send_email(to_email, subject, plain_text, html)

# --- Bearer auth dependency ---
def current_user(creds: HTTPAuthorizationCredentials = Depends(bearer)) -> MeOut:
    """
    Validate Authorization: Bearer <token> and return MeOut.
    Token must carry: sub (player_id), uid (user_id), tid (tenant_id).
    Verifies the user/player/tenant mapping against the DB on every request.
    """
    if not creds:
        raise HTTPException(status_code=401, detail="Missing Authorization header")
    if (creds.scheme or "").lower() != "bearer":
        raise HTTPException(status_code=401, detail="Authorization must be Bearer <token>")

    data = parse_session_token(creds.credentials)
    try:
        player_id = int(data["sub"])
        uid = int(data["uid"])
        tenant_id = int(data["tid"])
        exp_ts = int(data["exp"])
    except (KeyError, ValueError, TypeError) as exc:
        warn("Malformed session token payload", exc=exc)
        raise HTTPException(status_code=401, detail="Malformed session token") from None

    with db() as conn, conn.cursor() as cur:
        cur.execute("""
            SELECT p.player_id, p.pigeon_number, p.pigeon_name, u.email,
                   (tm.role = 'commissioner') AS is_admin, tm.tenant_id
              FROM user_players up
              JOIN players p  ON p.player_id  = up.player_id
              JOIN users u    ON u.user_id    = up.user_id
              JOIN tenant_members tm
                ON tm.user_id   = up.user_id
               AND tm.tenant_id = p.tenant_id
             WHERE up.user_id   = %s
               AND up.player_id = %s
               AND p.tenant_id  = %s
             LIMIT 1
        """, (uid, player_id, tenant_id))
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=401, detail="User/player/tenant mapping not found")

        return MeOut(
            player_id=row[0],
            pigeon_number=row[1],
            pigeon_name=row[2],
            email=row[3],
            is_admin=row[4],
            tenant_id=row[5],
            session={"expires_at": datetime.fromtimestamp(exp_ts, tz=timezone.utc).isoformat()},
        )

# --- Router ---
router = APIRouter(prefix="/auth", tags=["auth"])

def _build_login_response(uid: int, email: str, ctx) -> dict:
    """
    Given a resolved tenant context row (player_id, pigeon_number, pigeon_name,
    tenant_id, is_admin, tenant_name), build a full LoginOut dict.
    """
    player_id, pn, name, tenant_id, is_admin, _tenant_name = ctx
    token, exp_ts = make_session_token(player_id, tenant_id, email, uid=uid)
    me_out = MeOut(
        player_id=player_id,
        pigeon_number=pn,
        pigeon_name=name,
        email=email,
        is_admin=is_admin,
        tenant_id=tenant_id,
        session={"expires_at": datetime.fromtimestamp(exp_ts, tz=timezone.utc).isoformat()},
    )
    return {
        "ok": True,
        "access_token": token,
        "token_type": "bearer",
        "expires_at": me_out.session["expires_at"],
        "user": me_out,
    }

@router.post("/login", response_model=LoginOut)
def login(payload: LoginIn):
    """Login and return a Bearer token scoped to the user's most-recently-used tenant."""
    debug("In login")

    with db() as conn, conn.cursor() as cur:
        user_row = find_user(cur, payload.email)
        if not user_row:
            raise HTTPException(status_code=401, detail="Invalid credentials")

        uid, email, stored_hash = user_row

        ok = False
        try:
            if stored_hash and stored_hash.startswith("$2"):
                ok = bcrypt.verify(payload.password, stored_hash)
            else:
                ok = payload.password == stored_hash
        except (ValueError, TypeError):
            ok = False

        if not ok:
            raise HTTPException(status_code=401, detail="Invalid credentials")

        ctx = select_tenant_context(cur, uid)
        if not ctx:
            raise HTTPException(status_code=403, detail="No tenant/player assigned to this user")

        set_last_used_at(cur, uid, ctx[3])  # ctx[3] = tenant_id
        conn.commit()

    return _build_login_response(uid, email, ctx)


@router.post("/select-context", response_model=LoginOut)
def select_context(payload: SelectContextIn, creds: HTTPAuthorizationCredentials = Depends(bearer)):
    """
    Switch the active tenant. Validates that the caller is a member of the requested
    tenant, then issues a new session token scoped to that tenant.
    Requires a valid session token (any tenant).
    """
    debug("In select_context", requested_tenant=payload.tenant_id)

    if not creds:
        raise HTTPException(status_code=401, detail="Missing Authorization header")

    data = parse_session_token(creds.credentials)
    try:
        uid = int(data["uid"])
        email = data["email"]
    except (KeyError, ValueError, TypeError):
        raise HTTPException(status_code=401, detail="Malformed session token") from None

    with db() as conn, conn.cursor() as cur:
        ctx = select_tenant_context(cur, uid, tenant_id=payload.tenant_id)
        if not ctx:
            raise HTTPException(status_code=403, detail="Not a member of that tenant")

        set_last_used_at(cur, uid, payload.tenant_id)
        conn.commit()

    return _build_login_response(uid, email, ctx)


@router.get("/me", response_model=MeOut)
def me(user: MeOut = Depends(current_user)):
    debug("In me")

    with db() as conn, conn.cursor() as cur:
        # Alt pigeons within the active tenant
        cur.execute("""
            SELECT p.player_id, p.pigeon_number, p.pigeon_name
              FROM user_players up
              JOIN players p ON p.player_id = up.player_id
             WHERE up.user_id = (SELECT user_id FROM users WHERE lower(email) = lower(%s))
               AND p.tenant_id = %s
               AND up.player_id <> %s
               AND up.role IN ('owner','manager')
             ORDER BY p.pigeon_number
        """, (user.email, user.tenant_id, user.player_id))
        alt_rows = cur.fetchall()
        alt_pigeons = [AltPigeon(pigeon_number=r[1], pigeon_name=r[2]) for r in alt_rows]

        # All tenants this user belongs to
        uid_row = cur.execute(
            "SELECT user_id FROM users WHERE lower(email) = lower(%s)", (user.email,)
        ).fetchone()
        uid = uid_row[0] if uid_row else None
        available_tenants = get_available_tenants(cur, uid) if uid else []

    debug(f"User context for {user.email}: alt_pigeons={alt_pigeons}, tenants={[t.tenant_id for t in available_tenants]}")

    return MeOut(
        **user.model_dump(exclude={"alt_pigeons", "available_tenants"}),
        alt_pigeons=alt_pigeons,
        available_tenants=available_tenants,
    )


@router.post("/logout")
def logout():
    debug("In logout")
    return {"ok": True}


@router.post("/password-reset", status_code=status.HTTP_200_OK)
def request_password_reset(payload: PasswordResetRequestIn):
    email = payload.email.lower().strip()
    debug("password-reset: request received", email=email)

    try:
        with db() as conn, conn.cursor() as cur:
            cur.execute("SELECT user_id FROM users WHERE lower(email) = %s", (email,))
            row = cur.fetchone()
            if not row:
                info("password-reset: email not found", email=email)
                return {"ok": True}

            uid = int(row[0])
            token = make_reset_token(uid)
            sent_password_reset_email(email, token)
            info("password-reset: email sent", uid=uid, email=email)
            return {"ok": True}

    except psycopg.Error as db_exc:
        error("password-reset: DB error", exc=db_exc, email=email)
        raise HTTPException(status_code=500, detail="Failed to process request") from db_exc


@router.post("/password-reset/confirm", status_code=status.HTTP_200_OK)
def confirm_password_reset(payload: PasswordResetConfirmIn):
    debug("In confirm_password_reset")

    data = parse_reset_token(payload.token)
    try:
        uid = int(data["sub"])
    except (KeyError, ValueError, TypeError) as exc:
        warn("Malformed reset token payload", exc=exc)
        raise HTTPException(status_code=401, detail="Invalid reset token") from None
    jti = data["jti"]

    try:
        with db() as conn:
            ensure_reset_table(conn)
            with conn.cursor() as cur:
                if jti_already_used(cur, jti):
                    warn("password-reset: token jti already used", uid=uid, jti=jti)
                    raise HTTPException(status_code=401, detail="Reset link already used")

                cur.execute("SELECT email FROM users WHERE user_id = %s", (uid,))
                row = cur.fetchone()
                if not row:
                    raise HTTPException(status_code=401, detail="Invalid reset token")
                email = row[0]

                new_hash = bcrypt.hash(payload.new_password)
                cur.execute("UPDATE users SET password_hash = %s WHERE user_id = %s", (new_hash, uid))
                if cur.rowcount != 1:
                    warn("password-reset: couldn't update user", uid=uid, jti=jti)
                    raise HTTPException(status_code=401, detail="Invalid reset token")

                mark_jti_used(cur, jti, uid)

                ctx = select_tenant_context(cur, uid)
                if not ctx:
                    raise HTTPException(status_code=403, detail="No tenant/player assigned to this user")
                set_last_used_at(cur, uid, ctx[3])

            conn.commit()

    except psycopg.Error as db_exc:
        warn("password-reset: DB error", exc=db_exc, uid=uid, jti=jti)
        raise HTTPException(status_code=500, detail="Failed to reset password") from db_exc

    player_id, _pn, _name, tenant_id, _is_admin, _tenant_name = ctx
    token_str, exp_ts = make_session_token(player_id, tenant_id, email, uid=uid)
    return {
        "ok": True,
        "access_token": token_str,
        "token_type": "bearer",
        "expires_at": datetime.fromtimestamp(exp_ts, tz=timezone.utc).isoformat(),
    }

# --- Lightweight dependencies for other routers ---
class AuthUser(BaseModel):
    player_id: int
    pigeon_number: int
    tenant_id: int
    email: Optional[EmailStr] = None
    is_admin: bool = False

def require_user(user: MeOut = Depends(current_user)) -> AuthUser:
    return AuthUser(
        player_id=user.player_id,
        pigeon_number=user.pigeon_number,
        email=user.email,
        is_admin=user.is_admin,
        tenant_id=user.tenant_id,
    )

def require_admin(user: MeOut = Depends(current_user)) -> AuthUser:
    if not user.is_admin:
        raise HTTPException(status_code=403, detail="Commissioner access required")
    return AuthUser(
        player_id=user.player_id,
        pigeon_number=user.pigeon_number,
        email=user.email,
        is_admin=True,
        tenant_id=user.tenant_id,
    )
