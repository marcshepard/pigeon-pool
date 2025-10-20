"""
Main FastAPI application setup.
"""
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from backend.utils.settings import get_settings
from backend.utils.logger import configure_from_env
from backend.routes.auth import router as auth_router
from backend.routes.picks import router as picks_router
from backend.routes.schedule import router as schedule_router
from backend.routes.results import router as results_router
from backend.routes.admin import router as admin_router
from backend.utils.scheduler import start_scheduler, stop_scheduler

# Early initialization
s = get_settings()          # forces env load/validation early
configure_from_env()    # configure logging level after picking up LOGGING_LEVEL from env

@asynccontextmanager
async def lifespan(_: FastAPI):
    """Application startup and shutdown lifecycle."""
    # --- Startup ---
    start_scheduler()
    yield
    # --- Shutdown ---
    await stop_scheduler()

app = FastAPI(title="Pigeon Pool API", version="0.2.0", lifespan=lifespan)

# Allow frontend dev origin (adjust later for production)
app.add_middleware(
    CORSMiddleware,
    allow_origins=s.frontend_origins,
    allow_credentials=False,    # No cookies anymore
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
app.include_router(schedule_router)
app.include_router(results_router)
app.include_router(admin_router)
