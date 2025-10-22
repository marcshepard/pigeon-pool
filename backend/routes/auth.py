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
from backend.utils.emailer import send_email

#pylint: disable=line-too-long

# --- Config ---
S = get_settings()
DB_CFG = S.psycopg_kwargs()
JWT_SECRET = S.jwt_secret
JWT_ALG = S.jwt_alg
FRONTEND_ORIGIN = S.frontend_origins[0]
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
def make_session_token(pigeon_number: int, email: str, uid: int, is_admin: bool) -> tuple[str, int]:
    """Create a session JWT and return (token, exp_epoch_seconds)."""
    now = datetime.now(timezone.utc)
    exp = now + timedelta(minutes=SESSION_MINUTES)
    exp_epoch = int(exp.timestamp())
    payload = {
        "sub": str(pigeon_number),        # keep for minimal FE/BE change
        "uid": uid,                       # NEW: user_id for joins/verification
        "email": email,
        "adm": bool(is_admin),            # optional convenience
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
# --- Queries ---
def find_user(cur, email: str) -> Optional[Tuple]:
    """
    Find a user by email (case-insensitive).
    Returns (user_id, email, password_hash, is_admin) or None.
    """
    cur.execute(
        "SELECT user_id, email, password_hash, is_admin FROM users WHERE lower(email) = lower(%s)",
        (email.strip(),)
    )
    return cur.fetchone()

def select_primary_pigeon(cur, user_id: int) -> Optional[Tuple[int, str]]:
    """
    Pick the active pigeon for a user.
    Preference: is_primary = TRUE; otherwise lowest pigeon_number.
    Returns (pigeon_number, pigeon_name) or None if no mapping.
    """
    # Try explicit primary
    cur.execute("""
        SELECT p.pigeon_number, p.pigeon_name
          FROM user_players up
          JOIN players p ON p.pigeon_number = up.pigeon_number
         WHERE up.user_id = %s AND up.is_primary = TRUE
         ORDER BY p.pigeon_number
         LIMIT 1
    """, (user_id,))
    row = cur.fetchone()
    if row:
        return row

    # Fallback: any mapping (lowest pigeon_number)
    cur.execute("""
        SELECT p.pigeon_number, p.pigeon_name
          FROM user_players up
          JOIN players p ON p.pigeon_number = up.pigeon_number
         WHERE up.user_id = %s
         ORDER BY p.pigeon_number
         LIMIT 1
    """, (user_id,))
    return cur.fetchone()

# --- Password reset helpers ---
def make_reset_token(user_id: int) -> str:
    """Create a short-lived password reset JWT with a unique jti (sub = user_id)."""
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
    """ Parse and validate a JWT reset token, return the payload """
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
    """Ensure the single-use ledger table exists (now keyed by user_id)."""
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
    """Check if a reset token jti has already been used."""
    cur.execute("SELECT 1 FROM password_reset_uses WHERE jti = %s", (jti,))
    return cur.fetchone() is not None

def mark_jti_used(cur: psycopg.Cursor, jti: str, user_id: int) -> None:
    """Mark a reset token jti as used."""
    cur.execute(
        "INSERT INTO password_reset_uses (jti, user_id) VALUES (%s, %s) ON CONFLICT DO NOTHING",
        (jti, user_id),
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
    Token now encodes: uid (user_id) + sub (active pigeon_number).
    """
    if not creds:
        raise HTTPException(status_code=401, detail="Missing Authorization header")
    if (creds.scheme or "").lower() != "bearer":
        raise HTTPException(status_code=401, detail="Authorization must be Bearer <token>")

    data = parse_session_token(creds.credentials)
    try:
        pn = int(data["sub"])
        uid = int(data["uid"])
        exp_ts = int(data["exp"])
    except (KeyError, ValueError, TypeError) as exc:
        warn("Malformed session token payload", exc=exc)
        raise HTTPException(status_code=401, detail="Malformed session token") from None

    with db() as conn, conn.cursor() as cur:
        # Verify that this user is actually mapped to this pigeon (defense-in-depth)
        cur.execute("""
            SELECT p.pigeon_number, p.pigeon_name, u.email, u.is_admin
              FROM user_players up
              JOIN users u ON u.user_id = up.user_id
              JOIN players p ON p.pigeon_number = up.pigeon_number
             WHERE up.user_id = %s AND up.pigeon_number = %s
             LIMIT 1
        """, (uid, pn))
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=401, detail="User/pigeon mapping not found")

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
        user_row = find_user(cur, payload.email)
        if not user_row:
            raise HTTPException(status_code=401, detail="Invalid credentials")

        uid, email, stored_hash, is_admin = user_row

        # Verify password (bcrypt digest vs temporary plain)
        ok = False
        try:
            if stored_hash and stored_hash.startswith("$2"):
                ok = bcrypt.verify(payload.password, stored_hash)
            else:
                ok = payload.password == stored_hash  # TEMP: allow plain until fully migrated
        except (ValueError, TypeError):
            ok = False

        if not ok:
            raise HTTPException(status_code=401, detail="Invalid credentials")

        # Choose active pigeon for this user
        sel = select_primary_pigeon(cur, uid)
        if not sel:
            # You can soften this to 200 + a special flag if you want to support "no-pigeon yet".
            raise HTTPException(status_code=403, detail="No pigeon assigned to this user")

        pn, name = sel

        token, exp_ts = make_session_token(pn, email, uid=uid, is_admin=is_admin)
        me_out = MeOut(
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
            "expires_at": me_out.session["expires_at"],
            "user": me_out,
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
    Always 200 for well-formed requests to avoid email enumeration.
    """
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
    """
    Finalize the reset using the token and set a new password.
    Returns a fresh session bearer token (for the user's primary pigeon).
    """
    debug("In confirm_password_reset")

    data = parse_reset_token(payload.token)
    try:
        uid = int(data["sub"])
    except (KeyError, ValueError, TypeError) as exc:
        warn("Malformed reset token payload", exc=exc)
        raise HTTPException(status_code=401, detail="Invalid reset token") from None
    jti = data["jti"]

    # Update password atomically; enforce single-use
    try:
        with db() as conn:
            ensure_reset_table(conn)
            with conn.cursor() as cur:
                if jti_already_used(cur, jti):
                    warn("password-reset: token jti already used", uid=uid, jti=jti)
                    raise HTTPException(status_code=401, detail="Reset link already used")

                # fetch email (for token + email reply) and update password
                cur.execute("SELECT email, is_admin FROM users WHERE user_id = %s", (uid,))
                row = cur.fetchone()
                if not row:
                    raise HTTPException(status_code=401, detail="Invalid reset token")
                email, is_admin = row

                new_hash = bcrypt.hash(payload.new_password)
                cur.execute("UPDATE users SET password_hash = %s WHERE user_id = %s", (new_hash, uid))
                if cur.rowcount != 1:
                    warn("password-reset: couldn't update user", uid=uid, jti=jti)
                    raise HTTPException(status_code=401, detail="Invalid reset token")

                # mark jti as used
                mark_jti_used(cur, jti, uid)

                # choose active pigeon for fresh session
                sel = select_primary_pigeon(cur, uid)
                if not sel:
                    # If you prefer, return 200 without session token here.
                    raise HTTPException(status_code=403, detail="No pigeon assigned to this user")
                pn, _ = sel

            conn.commit()

    except psycopg.Error as db_exc:
        warn("password-reset: DB error", exc=db_exc, uid=uid, jti=jti)
        raise HTTPException(status_code=500, detail="Failed to reset password") from db_exc

    token, exp_ts = make_session_token(pn, email, uid=uid, is_admin=is_admin)
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
