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
    """Bearer token for the first admin user found in the DB."""
    s = get_settings()
    with psycopg.connect(**s.psycopg_kwargs()) as conn:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT u.user_id, up.pigeon_number, u.email
                  FROM users u
                  JOIN user_players up ON up.user_id = u.user_id
                 WHERE u.is_admin = TRUE
                 ORDER BY u.user_id, up.pigeon_number
                 LIMIT 1
            """)
            row = cur.fetchone()
    assert row, "No admin user with a pigeon mapping found in DB"
    uid, pn, email = row
    token, _ = make_session_token(pn, email, uid=uid, is_admin=True)
    return {"Authorization": f"Bearer {token}"}
