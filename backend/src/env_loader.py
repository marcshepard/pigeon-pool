"""
Environment variable loader.
Loads environment variables from .env files into os.environ.
"""

# backend/src/env_loader.py
import os
import sys
from pathlib import Path
from dotenv import load_dotenv

from .logger import info, error

def load_environment():
    """
    Load environment variables from:
      1. backend/.env (required)
      2. backend/.env.<environment> (optional)
      3. backend/.env.<environment>.local (optional)
    Environment variables already set in the system take precedence.
    """
    # One level up from this file => backend/
    root_dir = Path(__file__).resolve().parents[1]
    env_name = os.getenv("APP_ENV") or os.getenv("ENV") or "development"

    env_files = [
        root_dir / ".env",
        root_dir / f".env.{env_name}",
        root_dir / f".env.{env_name}.local",
    ]

    if not env_files[0].exists():
        error(f"❌ Error: required env file missing: {env_files[0]}", file=sys.stderr)
        sys.exit(1)

    for f in env_files:
        if f.exists():
            load_dotenv(f, override=True)
            info(f"Loaded env file: {f}")
        else:
            info(f"(Optional env not found: {f.name})")

    info(f"Environment: {env_name}")
