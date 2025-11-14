"""
Centralized environment and settings management.
Loads environment variables from .env files into os.environ.
Makes common settings available (DB config, JWT settings, origins).
"""

from __future__ import annotations
import os
import sys
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from urllib.parse import quote_plus
from dotenv import load_dotenv

def _load_env_files() -> None:
    """Load .env, .env.<env>, .env.<env>.local (base is required)."""
    root = Path(__file__).resolve().parents[1]
    env  = os.getenv("APP_ENV") or os.getenv("ENV") or "development"
    print ("Loading env files for env:", env)
    files = [root / ".env", root / f".env.{env}", root / f".env.{env}.local"]
    if not files[0].exists():
        print(f"❌ Missing required env file: {files[0]}", file=sys.stderr)
        sys.exit(1)
    for f in files:
        if f.exists():
            print ("Loading env file:", f)
            load_dotenv(f, override=True)

def _req(name: str) -> str:
    v = os.getenv(name)
    if not v:
        raise RuntimeError(f"Missing required env var: {name}")
    return v

@dataclass(frozen=True)
class Settings:
    """ Application settings, loaded from environment variables """
    # DB
    pg_host: str
    pg_port: int
    pg_db: str
    pg_user: str
    pg_password: str  # may be blank in dev

    # JWT & origins
    jwt_secret: str
    jwt_alg: str
    api_origin: str
    frontend_origins: list[str]

    # Session / reset token
    reset_ttl_minutes: int      # password reset token validity
    session_minutes: int        # idle/absolute expiry for simplicity
    slide_threshold_seconds: int  # re-issue cookie if < this many seconds left

    # Email
    email_endpoint: str         # Azure email URL. e.g. https://<resource>.communication.azure.com/
    email_access_key: str       # Azure email access key

    # Scheduler configuration
    heartbeat_seconds: int
    live_poll_seconds: int
    kickoff_sync_hour: int
    tue_warning_hour: int
    email_delay_minutes: int    # Delay before sending emails (to allow FE to refresh)

    # Helpers
    def psycopg_kwargs(self) -> dict:
        """Return dict suitable for psycopg.connect(**kwargs) """
        return dict(
            host=self.pg_host, port=self.pg_port, dbname=self.pg_db,
            user=self.pg_user, password=self.pg_password
        )

    def sqlalchemy_async_url(self) -> str:
        """Return SQLAlchemy async connection URL (for create_async_engine)"""
        u = quote_plus(self.pg_user or "")
        p = quote_plus(self.pg_password or "")
        host = self.pg_host
        port = self.pg_port
        db   = self.pg_db
        return f"postgresql+asyncpg://{u}:{p}@{host}:{port}/{db}"

@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Lazy, cached settings object (no module-level globals)."""
    _load_env_files()
    return Settings(
        pg_host=_req("POSTGRES_HOST"),
        pg_port=int(_req("POSTGRES_PORT")),
        pg_db=_req("POSTGRES_DB"),
        pg_user=_req("POSTGRES_USER"),
        pg_password=os.getenv("POSTGRES_PASSWORD", ""),
        jwt_secret=_req("JWT_SECRET"),
        jwt_alg=os.getenv("JWT_ALG", "HS256"),
        api_origin=os.getenv("API_ORIGIN", "http://localhost:8000"),
        frontend_origins=os.getenv("FRONTEND_ORIGINS"),
        reset_ttl_minutes=int(os.getenv("RESET_TTL_MINUTES", "30")),
        session_minutes=int(os.getenv("SESSION_MINUTES", "60")),
        slide_threshold_seconds=int(os.getenv("SLIDE_THRESHOLD_SECONDS", str(15 * 60))),
        email_endpoint=_req("EMAIL_ENDPOINT"),
        email_access_key=_req("EMAIL_ACCESS_KEY"),
        heartbeat_seconds=int(_req("PP_HEARTBEAT_SECONDS")),
        live_poll_seconds=int(_req("PP_LIVE_POLL_SECONDS")),
        kickoff_sync_hour=int(_req("PP_KICKOFF_SYNC_HOUR")),
        tue_warning_hour=int(_req("PP_TUE_WARNING_HOUR")),
        email_delay_minutes=int(os.getenv("EMAIL_DELAY_MINUTES", "0")),
    )

def reset_settings_cache() -> None:
    """Call in tests after mutating env vars."""
    get_settings.cache_clear()
