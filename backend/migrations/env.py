"""Alembic runtime environment for Pigeon Pool migrations."""

from __future__ import annotations

from logging.config import fileConfig

from alembic import context
from sqlalchemy import URL, create_engine, pool
from sqlalchemy.engine import Connection
from sqlalchemy.exc import SQLAlchemyError

from backend.utils.settings import Settings, get_settings

config = context.config

if config.config_file_name is not None:
    fileConfig(config.config_file_name)

# This project uses handwritten migrations rather than declarative ORM schema
# metadata, so Alembic autogeneration is intentionally unavailable.
target_metadata = None


def _database_url(settings: Settings) -> URL:
    """Build a sync psycopg URL without storing credentials in alembic.ini."""

    return URL.create(
        drivername="postgresql+psycopg",
        username=settings.pg_user,
        password=settings.pg_password,
        host=settings.pg_host,
        port=settings.pg_port,
        database=settings.pg_db,
    )


def run_migrations_offline() -> None:
    """Render migration SQL without opening a database connection."""

    context.configure(
        url=_database_url(get_settings()),
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        transactional_ddl=True,
        transaction_per_migration=True,
    )

    with context.begin_transaction():
        context.run_migrations()


def _run_with_connection(connection: Connection) -> None:
    """Configure Alembic and run revisions on an established connection."""

    context.configure(
        connection=connection,
        target_metadata=target_metadata,
        transactional_ddl=True,
        transaction_per_migration=True,
    )

    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    """Run migrations through a supplied or short-lived sync connection."""

    supplied_connection = config.attributes.get("connection")
    if supplied_connection is not None:
        _run_with_connection(supplied_connection)
        return

    settings = get_settings()
    connectable = create_engine(
        _database_url(settings), poolclass=pool.NullPool, future=True
    )
    try:
        connection = connectable.connect()
    except SQLAlchemyError as exc:
        target = f"{settings.pg_host}:{settings.pg_port}/{settings.pg_db}"
        raise RuntimeError(
            f"Alembic could not connect to PostgreSQL target {target} "
            f"({type(exc).__name__})."
        ) from None

    try:
        with connection:
            _run_with_connection(connection)
    finally:
        connectable.dispose()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
