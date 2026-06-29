"""
Database connection and session management using SQLAlchemy with async support
"""

from __future__ import annotations
from typing import AsyncGenerator
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from .settings import get_settings

engine = create_async_engine(
    get_settings().sqlalchemy_async_url(),
    future=True,
    echo=False,
    pool_pre_ping=True,
)
AsyncSessionLocal = async_sessionmaker(bind=engine, class_=AsyncSession, expire_on_commit=False)  # pylint: disable=C0103

async def get_db() -> AsyncGenerator[AsyncSession, None]:
    """Yield a database session, ensuring it's closed after use."""
    async with AsyncSessionLocal() as session:
        yield session
