"""
Main FastAPI application setup.
"""
import os
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

# Import before other modules so env vars are available early
from .settings import get_settings
from .logger import configure_from_env
from .auth import router as auth_router
from .picks import router as picks_router

# Early initialization
get_settings()          # forces env load/validation once
configure_from_env()    # picks up LOGGING_LEVEL

app = FastAPI(title="Pigeon Pool API", version="0.1.0")

# Allow frontend dev origin (adjust later for production)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[os.getenv("FRONTEND_ORIGIN")],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/ping")
def ping():
    """ Health check endpoint """
    return {"ok": True, "message": "pong"}

# Register routes
app.include_router(auth_router)
app.include_router(picks_router)
