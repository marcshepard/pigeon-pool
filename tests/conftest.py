"""
Shared fixtures for the Pigeon Pool test suite.
"""

import psycopg
import pytest
from starlette.testclient import TestClient

from backend.main import app
from backend.routes.auth import make_session_token
from backend.utils.settings import get_settings


def pytest_addoption(parser):
    parser.addoption(
        "--update-snapshots",
        action="store_true",
        default=False,
        help="Regenerate snapshot files instead of comparing against them",
    )


@pytest.fixture(scope="session")
def update_snapshots(pytestconfig):
    return pytestconfig.getoption("--update-snapshots")


@pytest.fixture(scope="session")
def client():
    with TestClient(app) as c:
        yield c


@pytest.fixture(scope="session")
def auth_headers():
    """Bearer token for the first commissioner found in the DB."""
    s = get_settings()
    with psycopg.connect(**s.psycopg_kwargs()) as conn:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT u.user_id, p.player_id, u.email, tm.tenant_id
                  FROM users u
                  JOIN tenant_members tm ON tm.user_id = u.user_id
                  JOIN players p ON p.player_id = tm.primary_player_id
                 WHERE tm.role = 'commissioner'
                 ORDER BY u.user_id, p.player_id
                 LIMIT 1
            """)
            row = cur.fetchone()
    assert row, "No commissioner user found in DB"
    uid, player_id, email, tenant_id = row
    token, _ = make_session_token(player_id, tenant_id, email, uid=uid)
    return {"Authorization": f"Bearer {token}"}
