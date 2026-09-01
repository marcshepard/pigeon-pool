"""Safety tests for the orphan-user inventory and localhost cleanup SQL."""

from pathlib import Path

import psycopg

from backend.utils.settings import get_settings


def test_orphan_user_scripts_only_delete_unreferenced_users():
    repository_root = Path(__file__).resolve().parents[1]
    find_sql = (repository_root / "scripts" / "find_orphan_users.sql").read_text(
        encoding="utf-8"
    )
    delete_sql = (repository_root / "scripts" / "delete_orphan_users_local.sql").read_text(
        encoding="utf-8"
    )

    settings = get_settings()
    with psycopg.connect(**settings.psycopg_kwargs(), autocommit=True) as conn:
        conn.execute(
            "CREATE TEMP TABLE users (user_id BIGINT PRIMARY KEY, email TEXT NOT NULL)"
        )
        conn.execute("CREATE TEMP TABLE tenant_members (user_id BIGINT NOT NULL)")
        conn.execute("CREATE TEMP TABLE user_players (user_id BIGINT NOT NULL)")
        conn.execute(
            "INSERT INTO users VALUES (1, 'orphan@example.com'), (2, 'member@example.com'), "
            "(3, 'player@example.com')"
        )
        conn.execute("INSERT INTO tenant_members VALUES (2)")
        conn.execute("INSERT INTO user_players VALUES (3)")

        orphan_rows = conn.execute(
            find_sql  # pyright: ignore[reportArgumentType]
        ).fetchall()
        assert orphan_rows == [(1, "orphan@example.com")]

        conn.execute(delete_sql)  # pyright: ignore[reportArgumentType]

        remaining_rows = conn.execute("SELECT user_id FROM users ORDER BY user_id").fetchall()
        assert remaining_rows == [(2,), (3,)]
