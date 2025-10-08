"""
Authentication-related endpoints and helpers.
"""

#pylint: disable=line-too-long

from datetime import datetime, timedelta, timezone
import os
import binascii
from typing import Optional, Tuple
from urllib.parse import urlparse

import jwt
import psycopg
from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from passlib.hash import bcrypt
from pydantic import BaseModel, EmailStr

from .env_loader import load_environment
from .logger import debug, info, warn, error

# Load env once (safe to call multiple times)
load_environment()

# --- Config ---
DB_CFG = {
    "host": os.getenv("POSTGRES_HOST"),
    "port": int(os.getenv("POSTGRES_PORT")),
    "dbname": os.getenv("POSTGRES_DB"),
    "user": os.getenv("POSTGRES_USER"),
    "password": os.getenv("POSTGRES_PASSWORD"),
}
JWT_SECRET = os.getenv("JWT_SECRET")
JWT_ALG = "HS256"
RESET_TTL_MINUTES = int(os.environ.get("RESET_TTL_MINUTES", "30")) # password reset token validity

SESSION_MINUTES = 60                 # idle/absolute expiry for simplicity
SLIDE_THRESHOLD_SECONDS = 15 * 60    # re-issue cookie if < 15 min left

# Origins from env
_API_ORIGIN = os.getenv("API_ORIGIN", "http://localhost:8000")
_FRONTEND_ORIGIN = os.getenv("FRONTEND_ORIGIN", "http://localhost:5173")

def _origin_tuple(url: str):
    p = urlparse(url)
    port = p.port or (443 if p.scheme == "https" else 80)
    return (p.scheme, p.hostname, port)

ENV = os.getenv("APP_ENV", "development").lower()
_FE = _origin_tuple(_FRONTEND_ORIGIN)
_API = _origin_tuple(_API_ORIGIN)
CROSS_SITE = _FE != _API
API_SCHEME = _origin_tuple(_API_ORIGIN)[0]

# Cookie flags that “just work” in both modes
COOKIE_NAME = os.getenv("COOKIE_NAME", "session")
COOKIE_DOMAIN = os.getenv("COOKIE_DOMAIN") or None   # keep None unless you really need it
COOKIE_PATH = "/"

if CROSS_SITE:
    if API_SCHEME == "https":
        # Cross-site over HTTPS → modern, allowed
        COOKIE_SAMESITE = "none"
        COOKIE_SECURE = True
    elif ENV == "development":
        # Dev mode: let the app start; you should use the Vite proxy so the browser sees same-origin.
        warn("Dev mode: CROSS_SITE over HTTP detected; using SameSite=Lax, Secure=False. Use the Vite proxy for the FE.")
        COOKIE_SAMESITE = "lax"
        COOKIE_SECURE = False
    else:
        # Prod or non-dev without HTTPS → fail fast
        raise RuntimeError(
            "CROSS_SITE requires HTTPS (Secure cookies). Run API over HTTPS or use a dev proxy."
        )
else:
    # Same-origin (e.g., via Vite proxy in dev)
    COOKIE_SAMESITE = "lax"
    COOKIE_SECURE = _origin_tuple(_API_ORIGIN)[0] == "https"


# --- DB helper ---
def db():
    """ Context manager for DB connection. """
    return psycopg.connect(**DB_CFG)

# --- Models ---
class LoginIn(BaseModel):
    """ Login input: either email or pigeon_number + password """
    email: EmailStr = None
    password: str

class MeOut(BaseModel):
    """ Current user output """
    pigeon_number: int
    pigeon_name: str
    email: EmailStr
    is_admin: bool
    session: dict

class PasswordResetRequestIn(BaseModel):
    """ Password reset request input """
    email: EmailStr

class PasswordResetConfirmIn(BaseModel):
    """ Password reset confirmation input """
    token: str
    new_password: str

# --- JWT helpers ---
def make_session_token(pigeon_number: int) -> tuple[str, int]:
    """Create a session JWT and return (token, exp_epoch_seconds)."""
    now = datetime.now(timezone.utc)
    exp = now + timedelta(minutes=SESSION_MINUTES)
    exp_epoch = int(exp.timestamp())
    payload = {
        "sub": str(pigeon_number),
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
        raise HTTPException(
            status_code=401,
            detail="Invalid or expired session"
        ) from exc

    if data.get("typ") != "session":
        raise HTTPException(status_code=401, detail="Wrong token type")
    return data

def set_session_cookie(response: Response, token: str, exp_epoch: int):
    """ Set the session cookie in the response """
    max_age = max(0, exp_epoch - int(datetime.now(timezone.utc).timestamp()))
    response.set_cookie(
        COOKIE_NAME, token,
        httponly=True, secure=COOKIE_SECURE, samesite=COOKIE_SAMESITE,
        domain=COOKIE_DOMAIN, path=COOKIE_PATH, max_age=max_age,
    )

def clear_session_cookie(response: Response):
    """ Clear the session cookie in the response """
    response.delete_cookie(COOKIE_NAME, domain=COOKIE_DOMAIN, path=COOKIE_PATH)

# --- Queries ---
def find_player(cur, email: str) -> Optional[Tuple]:
    """ Find a player by email or pigeon_number, return row or None """
    cur.execute(
        "SELECT pigeon_number, pigeon_name, email, password_hash, is_admin "
        "FROM players WHERE email = %s",
        (email.lower(),)
    )
    return cur.fetchone()

# --- Dependency for auth ---
def current_user(request: Request, response: Response) -> MeOut:
    """ Dependency to get the current user from the session cookie, slide session if needed """
    token = request.cookies.get(COOKIE_NAME)
    if not token:
        raise HTTPException(status_code=401, detail="Not signed in")

    data = parse_session_token(token)
    pn = int(data["sub"])
    exp_ts = int(data["exp"])

    # Slide session if close to expiry (stateless re-issue)
    now_ts = int(datetime.now(timezone.utc).timestamp())
    if exp_ts - now_ts < SLIDE_THRESHOLD_SECONDS:
        new_token, new_exp = make_session_token(pn)
        set_session_cookie(response, new_token, new_exp)
        exp_ts = new_exp

    with db() as conn, conn.cursor() as cur:
        cur.execute("SELECT pigeon_number, pigeon_name, email, is_admin FROM players WHERE pigeon_number = %s", (pn,))
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=401, detail="User not found")
        return MeOut(
            pigeon_number=row[0],
            pigeon_name=row[1],
            email=row[2],
            is_admin=row[3],
            session={"expires_at": datetime.fromtimestamp(exp_ts, tz=timezone.utc).isoformat()}
        )

# --- Password reset helpers ---
def make_reset_token(pigeon_number: int) -> Tuple[str, int]:
    """
    Create a short-lived password reset JWT with a unique jti.
    Returns (token, exp_epoch_seconds).
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
    return token, int(exp.timestamp())

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
    Idempotent, lightweight, executed on first confirm.
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
    """
    Check if a reset token jti has already been marked used.
    """
    cur.execute("SELECT 1 FROM password_reset_uses WHERE jti = %s", (jti,))
    return cur.fetchone() is not None

def mark_jti_used(cur: psycopg.Cursor, jti: str, pigeon_number: int) -> None:
    """
    Mark a reset token jti as used (single-use enforcement).
    """
    cur.execute(
        "INSERT INTO password_reset_uses (jti, pigeon_number) VALUES (%s, %s) ON CONFLICT DO NOTHING",
        (jti, pigeon_number),
    )

# --- Router ---
router = APIRouter(prefix="/auth", tags=["auth"])

@router.post("/login", response_model=MeOut)
def login(payload: LoginIn, response: Response):
    """ Login with email or pigeon_number + password, set session cookie """
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
                ok = payload.password == stored_hash  # TEMP: allow plain until you migrate
        except (ValueError, TypeError):
            ok = False

        if not ok:
            raise HTTPException(status_code=401, detail="Invalid credentials")

        token, exp_ts = make_session_token(pn)
        set_session_cookie(response, token, exp_ts)
        return MeOut(
            pigeon_number=pn,
            pigeon_name=name,
            email=email,
            is_admin=is_admin,
            session={"expires_at": datetime.fromtimestamp(exp_ts , tz=timezone.utc).isoformat()},
        )

@router.get("/me", response_model=MeOut)
def me(user: MeOut = Depends(current_user)):
    """ Get current user info """
    debug("In me")
    return user

@router.post("/logout")
def logout(response: Response):
    """ Logout by clearing the session cookie """
    debug("In logout")

    clear_session_cookie(response)
    return {"ok": True}

@router.post("/password-reset", status_code=status.HTTP_200_OK)
def request_password_reset(payload: PasswordResetRequestIn):
    """
    Start the password reset flow.

    - Always returns 200 for well-formed requests to avoid email enumeration.
    - If the player exists, generate a reset token and (later) email it.
    - If the player doesn't exist, log internally but still return 200.
    - If there is a server/DB error, raise 500.
    """
    email = payload.email.lower().strip()
    debug("password-reset: request received", email=email)

    try:
        with db() as conn, conn.cursor() as cur:
            # extra debug to confirm DB connection works
            debug("password-reset: connected to DB")

            cur.execute(
                "SELECT pigeon_number, email FROM players WHERE email = %s",
                (email,),
            )
            row = cur.fetchone()

            if not row:
                # Internal log only; 200 to caller to prevent enumeration.
                info("password-reset: email not found", email=email)
                return {"ok": True}

            pn, _ = row
            token, exp_ts = make_reset_token(pn)
            reset_url = f"https://your-frontend/reset-password?token={token}"

            debug(
                "password-reset: token generated",
                pn=pn,
                exp=int(exp_ts),
            )
            # TODO: send the email here (use your mailer abstraction)  # pylint: disable=fixme
            debug("password-reset: dev link", url=reset_url)

            return {"ok": True}

    except psycopg.Error as db_exc:
        # This is a real server problem — let the client know it failed
        error("password-reset: DB error", exc=db_exc, email=email)
        raise HTTPException(status_code=500, detail="Failed to process request") from db_exc



@router.post("/password-reset/confirm", status_code=status.HTTP_200_OK)
def confirm_password_reset(payload: PasswordResetConfirmIn, response: Response):
    """
    Finalize the reset using the token and set a new password.

    Validates token (issuer/type/exp), enforces single-use via jti,
    sets a new bcrypt hash, and (optionally) signs the user in immediately
    by issuing a session cookie.
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
                new_hash = bcrypt.hash(payload.new_password)
                cur.execute("UPDATE players SET password_hash = %s WHERE pigeon_number = %s", (new_hash, pn))
                if cur.rowcount != 1:
                    # No such user (could be deleted)
                    warn("password-reset: couldn't update user", pn=pn, jti=jti)
                    raise HTTPException(status_code=401, detail="Invalid reset token")

                # mark jti as used
                mark_jti_used(cur, jti, pn)
            conn.commit()
    except psycopg.Error as db_exc:
        # Database-specific failure
        warn("password-reset: DB error", exc=db_exc, pn=pn, jti=jti)
        raise HTTPException(status_code=500, detail="Failed to reset password") from db_exc

    # 3) (Optional) sign them in immediately by issuing a fresh session cookie
    token, exp_ts = make_session_token(pn)
    set_session_cookie(response, token, exp_ts)

    return {"ok": True}
