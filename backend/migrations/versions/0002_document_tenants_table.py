"""Document the tenants table and prove automated migration delivery.

Revision ID: 0002
Revises: 0001
Create Date: 2026-08-31

This harmless catalog-only change is the Alembic canary. It verifies that
desktop, laptop, and Azure startup can discover and apply a real revision
without changing application data or behavior.
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "0002"
down_revision: str | Sequence[str] | None = "0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    """Add durable catalog documentation to the tenants table."""

    op.execute("COMMENT ON TABLE tenants IS 'One row per Pigeon Pool league'")


def downgrade() -> None:
    """Remove the tenants table documentation."""

    op.execute("COMMENT ON TABLE tenants IS NULL")
