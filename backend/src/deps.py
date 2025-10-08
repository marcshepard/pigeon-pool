"""
Database connection and session management using SQLAlchemy with async support
"""

# backend/src/deps.py
from __future__ import annotations
from typing import AsyncGenerator
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.orm import sessionmaker
from .settings import get_settings

engine = create_async_engine(
    get_settings().sqlalchemy_async_url(),
    future=True,
    echo=False,
    pool_pre_ping=True,
)
AsyncSessionLocal = sessionmaker(bind=engine, class_=AsyncSession, expire_on_commit=False)

async def get_db() -> AsyncGenerator[AsyncSession, None]:
    """Yield a database session, ensuring it's closed after use."""
    async with AsyncSessionLocal() as session:
        yield session
