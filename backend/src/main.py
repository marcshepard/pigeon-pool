"""
Main FastAPI application setup.
"""
import os
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

# Import before other modules so env vars are available early
from .env_loader import load_environment
from .auth import router as auth_router
from .logger import set_level

load_environment()

# Set log level
set_level(os.getenv("LOGGING_LEVEL", "info"))

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
