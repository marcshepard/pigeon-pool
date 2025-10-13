"""
Authentication-related endpoints and helpers, using name/password and bearer tokens
"""

# pylint: disable=line-too-long

from datetime import datetime, timedelta, timezone
import os
import binascii
from typing import Optional, Tuple

import jwt
import psycopg
from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials

from passlib.hash import bcrypt
from pydantic import BaseModel, EmailStr

from backend.utils.settings import get_settings
from backend.utils.logger import debug, info, warn, error
from backend.utils.email import send_email

# --- Config ---
S = get_settings()
DB_CFG = S.psycopg_kwargs()
JWT_SECRET = S.jwt_secret
JWT_ALG = S.jwt_alg
FRONTEND_ORIGIN = S.frontend_origin
RESET_TTL_MINUTES = S.reset_ttl_minutes
SESSION_MINUTES = S.session_minutes
SLIDE_THRESHOLD_SECONDS = S.slide_threshold_seconds  # (kept for parity; used for token refresh timing)

bearer = HTTPBearer(
    auto_error=False,          # we'll raise our own 401 so messages are clearer
    scheme_name="BearerAuth",
    bearerFormat="JWT",
)

# --- DB helper ---
def db():
    """ Context manager for DB connection. """
    return psycopg.connect(**DB_CFG)

# --- Models ---
class LoginIn(BaseModel):
    """ Login input """
    email: EmailStr
    password: str

class MeOut(BaseModel):
    """ Current user output """
    pigeon_number: int
    pigeon_name: str
    email: EmailStr
    is_admin: bool
    session: dict

class LoginOut(BaseModel):
    """ Login output """
    ok: bool
    access_token: str
    token_type: str = "bearer"
    expires_at: str
    user: MeOut

class PasswordResetRequestIn(BaseModel):
    """ Password reset request input """
    email: EmailStr

class PasswordResetConfirmIn(BaseModel):
    """ Password reset confirmation input """
    token: str
    new_password: str

# --- JWT helpers ---
def make_session_token(pigeon_number: int, email: str) -> tuple[str, int]:
    """Create a session JWT and return (token, exp_epoch_seconds)."""
    now = datetime.now(timezone.utc)
    exp = now + timedelta(minutes=SESSION_MINUTES)
    exp_epoch = int(exp.timestamp())
    payload = {
        "sub": str(pigeon_number),
        "email": email,
        "typ": "session",
        "iat": int(now.timestamp()),
        "exp": exp_epoch,
    }
    token = jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALG)
    return token, exp_epoch

def parse_session_token(token: str) -> dict:
    """ Parse and validate a JWT session token, return the payload """
    try:
        data = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALG])
    except jwt.PyJWTError as exc:
        warn(f"Session token decode error: {exc}")
        raise HTTPException(status_code=401, detail="Invalid or expired session") from exc
    if data.get("typ") != "session":
        raise HTTPException(status_code=401, detail="Wrong token type")
    return data

# --- Queries ---
def find_player(cur, email: str) -> Optional[Tuple]:
    """ Find a player by email, return row or None """
    cur.execute(
        "SELECT pigeon_number, pigeon_name, email, password_hash, is_admin "
        "FROM players WHERE email = %s",
        (email.lower(),)
    )
    return cur.fetchone()

# --- Password reset helpers ---
def make_reset_token(pigeon_number: int) -> str:
    """
    Create a short-lived password reset JWT with a unique jti.
    """
    now = datetime.now(timezone.utc)
    exp = now + timedelta(minutes=RESET_TTL_MINUTES)
    jti = binascii.hexlify(os.urandom(16)).decode()   # 32-char random hex string

    payload = {
        "sub": str(pigeon_number),
        "typ": "reset",
        "jti": jti,
        "iat": int(now.timestamp()),
        "exp": int(exp.timestamp()),
    }
    token = jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALG)
    return token

def parse_reset_token(token: str) -> dict:
    """
    Decode and validate a password reset JWT.
    Raises HTTP 401 on invalid/expired or wrong type.
    """
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
    """
    Ensure the single-use ledger table exists.
    """
    with conn.cursor() as cur:
        cur.execute("""
            CREATE TABLE IF NOT EXISTS password_reset_uses (
              jti TEXT PRIMARY KEY,
              pigeon_number INT NOT NULL REFERENCES players(pigeon_number) ON DELETE CASCADE,
              used_at TIMESTAMPTZ NOT NULL DEFAULT now()
            );
        """)
        conn.commit()

def jti_already_used(cur: psycopg.Cursor, jti: str) -> bool:
    """ Check if a reset token jti has already been marked used. """
    cur.execute("SELECT 1 FROM password_reset_uses WHERE jti = %s", (jti,))
    return cur.fetchone() is not None

def mark_jti_used(cur: psycopg.Cursor, jti: str, pigeon_number: int) -> None:
    """ Mark a reset token jti as used (single-use enforcement). """
    cur.execute(
        "INSERT INTO password_reset_uses (jti, pigeon_number) VALUES (%s, %s) ON CONFLICT DO NOTHING",
        (jti, pigeon_number),
    )

def sent_password_reset_email(to_email: str, token: str) -> None:
    """ Send a password reset email to the given address """
    subject = "Pigeon Pool Password Reset"
    plain_text = (
        "You requested a password reset for your Pigeon Pool account.\n\n"
        "If you did not make this request, you can ignore this email.\n\n"
        "To reset your password, click the link below:\n\n"
        f"{FRONTEND_ORIGIN}/reset-password?token={token}\n\n"
        "This link will expire in 30 minutes."
    )
    html = (
        "<p>You requested a password reset for your Pigeon Pool account.</p>"
        "<p>If you did not make this request, you can ignore this email.</p>"
        "<p>To reset your password, click the link below:</p>"
        f'<p><a href="{FRONTEND_ORIGIN}/reset-password?token={token}">Reset Password</a></p>'
        "<p>This link will expire in 30 minutes.</p>"
    )
    send_email(to_email, subject, plain_text, html)

# --- Bearer auth dependency ---
def current_user(creds: HTTPAuthorizationCredentials = Depends(bearer)) -> MeOut:
    """
    Validate Authorization: Bearer <token> and return MeOut.

    Note: This implementation is header-only (no cookies). Frontend must send:
      Authorization: Bearer <JWT>
    """
    if not creds:
        raise HTTPException(status_code=401, detail="Missing Authorization header")

    if (creds.scheme or "").lower() != "bearer":
        raise HTTPException(status_code=401, detail="Authorization must be Bearer <token>")

    data = parse_session_token(creds.credentials)
    pn = int(data["sub"])
    exp_ts = int(data["exp"])

    with db() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT pigeon_number, pigeon_name, email, is_admin FROM players WHERE pigeon_number = %s",
            (pn,),
        )
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=401, detail="User not found")

        return MeOut(
            pigeon_number=row[0],
            pigeon_name=row[1],
            email=row[2],
            is_admin=row[3],
            session={"expires_at": datetime.fromtimestamp(exp_ts, tz=timezone.utc).isoformat()},
        )

# --- Router ---
router = APIRouter(prefix="/auth", tags=["auth"])

@router.post("/login", response_model=LoginOut)
def login(payload: LoginIn):
    """Login and return a Bearer token plus user info."""
    debug("In login")

    with db() as conn, conn.cursor() as cur:
        row = find_player(cur, payload.email)
        if not row:
            raise HTTPException(status_code=401, detail="Invalid credentials")

        pn, name, email, stored_hash, is_admin = row

        # Verify password: bcrypt (or temporary plain-text fallback)
        ok = False
        try:
            if stored_hash and stored_hash.startswith("$2"):  # bcrypt hash prefix
                ok = bcrypt.verify(payload.password, stored_hash)
            else:
                ok = payload.password == stored_hash  # TEMP: allow plain until migrated
        except (ValueError, TypeError):
            ok = False

        if not ok:
            raise HTTPException(status_code=401, detail="Invalid credentials")

        token, exp_ts = make_session_token(pn, email)
        pigeon = MeOut(
            pigeon_number=pn,
            pigeon_name=name,
            email=email,
            is_admin=is_admin,
            session={"expires_at": datetime.fromtimestamp(exp_ts, tz=timezone.utc).isoformat()},
        )
        return {
            "ok": True,
            "access_token": token,
            "token_type": "bearer",
            "expires_at": pigeon.session["expires_at"],
            "user": pigeon,
        }

@router.get("/me", response_model=MeOut)
def me(user: MeOut = Depends(current_user)):
    """ Get current user info """
    debug("In me")
    return user

@router.post("/logout")
def logout():
    """ Logout is client-side (delete token). """
    debug("In logout")
    return {"ok": True}

@router.post("/password-reset", status_code=status.HTTP_200_OK)
def request_password_reset(payload: PasswordResetRequestIn):
    """
    Start the password reset flow.

    - Always returns 200 for well-formed requests to avoid email enumeration.
    """
    email = payload.email.lower().strip()
    debug("password-reset: request received", email=email)

    try:
        with db() as conn, conn.cursor() as cur:
            debug("password-reset: connected to DB")

            cur.execute(
                "SELECT pigeon_number, email FROM players WHERE email = %s",
                (email,),
            )
            row = cur.fetchone()

            if not row:
                info("password-reset: email not found", email=email)
                return {"ok": True}

            pn, _ = row
            token = make_reset_token(pn)

            sent_password_reset_email(email, token)
            info("password-reset: email sent", pn=pn, email=email)

            return {"ok": True}

    except psycopg.Error as db_exc:
        error("password-reset: DB error", exc=db_exc, email=email)
        raise HTTPException(status_code=500, detail="Failed to process request") from db_exc

@router.post("/password-reset/confirm", status_code=status.HTTP_200_OK)
def confirm_password_reset(payload: PasswordResetConfirmIn):
    """
    Finalize the reset using the token and set a new password.
    Returns a fresh session bearer token so the client can sign in immediately.
    """
    debug("In confirm_password_reset")

    # 1) Parse & validate token
    data = parse_reset_token(payload.token)
    pn = int(data["sub"])
    jti = data["jti"]

    # 2) Update password atomically; enforce single-use
    try:
        with db() as conn:
            ensure_reset_table(conn)
            with conn.cursor() as cur:
                # single-use check
                if jti_already_used(cur, jti):
                    warn("password-reset: token jti already used", pn=pn, jti=jti)
                    raise HTTPException(status_code=401, detail="Reset link already used")

                # set new bcrypt hash
                # First, fetch email for token creation afterwards
                cur.execute("SELECT email FROM players WHERE pigeon_number = %s", (pn,))
                row = cur.fetchone()
                if not row:
                    raise HTTPException(status_code=401, detail="Invalid reset token")
                email = row[0]

                new_hash = bcrypt.hash(payload.new_password)
                cur.execute(
                    "UPDATE players SET password_hash = %s WHERE pigeon_number = %s",
                    (new_hash, pn)
                )
                if cur.rowcount != 1:
                    warn("password-reset: couldn't update user", pn=pn, jti=jti)
                    raise HTTPException(status_code=401, detail="Invalid reset token")

                # mark jti as used
                mark_jti_used(cur, jti, pn)
            conn.commit()
    except psycopg.Error as db_exc:
        warn("password-reset: DB error", exc=db_exc, pn=pn, jti=jti)
        raise HTTPException(status_code=500, detail="Failed to reset password") from db_exc

    # 3) Return a fresh token so the client can sign in immediately
    token, exp_ts = make_session_token(pn, email)
    return {
        "ok": True,
        "access_token": token,
        "token_type": "bearer",
        "expires_at": datetime.fromtimestamp(exp_ts, tz=timezone.utc).isoformat(),
    }

# --- Lightweight dependencies for other routers ---
class AuthUser(BaseModel):
    """ Minimal user info for auth dependencies """
    pigeon_number: int
    email: Optional[EmailStr] = None
    is_admin: bool = False

def require_user(user: MeOut = Depends(current_user)) -> AuthUser:
    """
    Minimal auth dependency for feature routers.
    """
    return AuthUser(
        pigeon_number=user.pigeon_number,
        email=user.email,
        is_admin=user.is_admin,
    )

def require_admin(user: MeOut = Depends(current_user)) -> AuthUser:
    """ Restrict endpoints to admins. """
    if not user.is_admin:
        raise HTTPException(status_code=403, detail="Admin only")
    return AuthUser(
        pigeon_number=user.pigeon_number,
        email=user.email,
        is_admin=True,
    )
