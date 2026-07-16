"""
Shared fixtures for the Pigeon Pool backend test suite.

Auth approach
─────────────
Most tests receive pre-minted JWT tokens via session-scoped fixtures (comm_headers,
member_headers, tenant_b_headers). These are built with make_session_token() using
the real IDs inserted by the test_data fixture — no HTTP login call or password needed.

The single exception is test_auth.py::test_login_success, which POSTs credentials to
/auth/login. For that test, the test_data fixture inserts a commissioner user with
email "testcomm@example.com" and a bcrypt hash of "testpass".

Game data (scored_games fixture)
─────────────────────────────────
Tests that assert leaderboard/scoring output need games with final scores. scored_games
checks the DB first — if real scored games exist (normal post-season state) it uses
those game_ids directly, causing no writes to the games table and no contamination of
other tenants' data. If no scored games exist (e.g. after reset-season before the new
schedule is synced), it inserts two synthetic games into week 1 and cleans them up at
teardown.

Pick submission tests use a dedicated synthetic game in week 17 (lock_at far future)
so the unlocked week is always separate from the locked scoring weeks.
"""

import psycopg
import pytest
from passlib.hash import bcrypt as _bcrypt
from starlette.testclient import TestClient

from backend.main import app
from backend.routes.auth import make_session_token
from backend.utils.settings import get_settings


# ── scoring formula (mirrors v_results) ──────────────────────────────────────

def _sign(x: int) -> int:
    if x > 0:
        return 1
    if x < 0:
        return -1
    return 0


def expected_score(
    picked_home: bool,
    predicted_margin: int,
    home_score: int,
    away_score: int,
    is_made: bool = True,
) -> int:
    """
    Python mirror of the v_results scoring formula. Use in tests to compute the
    expected score for a pick given actual game results.

      correct side:  ABS(predicted - actual)
      wrong side:    ABS(predicted - actual) + 7
      no pick:       ABS(0 - actual) + 100
      cap:           800
    """
    actual = home_score - away_score
    pred = predicted_margin if picked_home else -predicted_margin
    diff = abs(pred - actual)
    if not is_made:
        penalty = 100
    elif _sign(pred) == 0 and _sign(actual) == 0:
        penalty = 7
    elif _sign(pred) != _sign(actual):
        penalty = 7
    else:
        penalty = 0
    return min(diff + penalty, 800)


# ── CLI flag ──────────────────────────────────────────────────────────────────

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


# ── HTTP test client ──────────────────────────────────────────────────────────

@pytest.fixture(scope="session")
def client():
    with TestClient(app) as c:
        yield c


# ── snapshot auth (for test_snapshots.py only) ───────────────────────────────

@pytest.fixture(scope="session")
def auth_headers():
    """Bearer token for the first commissioner found in the DB (snapshot tests only)."""
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


# ── shared DB connection ──────────────────────────────────────────────────────

@pytest.fixture(scope="session")
def db_conn():
    s = get_settings()
    conn = psycopg.connect(**s.psycopg_kwargs())
    yield conn
    conn.close()


# ── test tenants, players, users ─────────────────────────────────────────────

@pytest.fixture(scope="session")
def test_data(db_conn):
    """
    Creates two isolated test tenants with players and users. Tears down at end
    of the test session.

    Tenant A — fully populated:
        comm    player_id=comm_pid   pigeon_number=1  role=commissioner
        member  player_id=member_pid pigeon_number=2  role=member
        alt     player_id=alt_pid    pigeon_number=3  (no primary user; member has manager role)

    Tenant B — minimal (isolation tests only):
        b_player  player_id=b_pid  pigeon_number=1  commissioner = same user as Tenant A comm

    Users:
        testcomm@example.com   — bcrypt hash of "testpass" (used by login test)
        testmember@example.com — placeholder hash "x" (token minted directly; never logs in)
    """
    # Guard against leftover data from a previously-aborted session.
    db_conn.rollback()
    with db_conn.cursor() as cur:
        cur.execute("DELETE FROM tenants WHERE name IN ('_Test League A', '_Test League B')")
        cur.execute("DELETE FROM users WHERE email IN ('testcomm@example.com', 'testmember@example.com')")
    db_conn.commit()

    with db_conn.cursor() as cur:
        # Tenants
        cur.execute("INSERT INTO tenants (name) VALUES ('_Test League A') RETURNING tenant_id")
        tenant_a_id = cur.fetchone()[0]
        cur.execute("INSERT INTO tenants (name) VALUES ('_Test League B') RETURNING tenant_id")
        tenant_b_id = cur.fetchone()[0]

        # Players — Tenant A
        cur.execute(
            "INSERT INTO players (tenant_id, pigeon_number, pigeon_name) VALUES (%s, 1, '_TestComm') RETURNING player_id",
            (tenant_a_id,),
        )
        comm_pid = cur.fetchone()[0]
        cur.execute(
            "INSERT INTO players (tenant_id, pigeon_number, pigeon_name) VALUES (%s, 2, '_TestMember') RETURNING player_id",
            (tenant_a_id,),
        )
        member_pid = cur.fetchone()[0]
        cur.execute(
            "INSERT INTO players (tenant_id, pigeon_number, pigeon_name) VALUES (%s, 3, '_TestAlt') RETURNING player_id",
            (tenant_a_id,),
        )
        alt_pid = cur.fetchone()[0]

        # Players — Tenant B
        cur.execute(
            "INSERT INTO players (tenant_id, pigeon_number, pigeon_name) VALUES (%s, 1, '_TestB') RETURNING player_id",
            (tenant_b_id,),
        )
        b_pid = cur.fetchone()[0]

        # Users
        pw = _bcrypt.hash("testpass")
        cur.execute(
            "INSERT INTO users (email, password_hash) VALUES ('testcomm@example.com', %s) RETURNING user_id",
            (pw,),
        )
        comm_uid = cur.fetchone()[0]
        cur.execute(
            "INSERT INTO users (email, password_hash) VALUES ('testmember@example.com', 'x') RETURNING user_id"
        )
        member_uid = cur.fetchone()[0]

        # user_players
        cur.execute("INSERT INTO user_players (user_id, player_id, role) VALUES (%s, %s, 'owner')", (comm_uid, comm_pid))
        cur.execute("INSERT INTO user_players (user_id, player_id, role) VALUES (%s, %s, 'owner')", (member_uid, member_pid))
        cur.execute("INSERT INTO user_players (user_id, player_id, role) VALUES (%s, %s, 'manager')", (member_uid, alt_pid))
        cur.execute("INSERT INTO user_players (user_id, player_id, role) VALUES (%s, %s, 'owner')", (comm_uid, b_pid))

        # tenant_members
        cur.execute(
            "INSERT INTO tenant_members (tenant_id, user_id, role, primary_player_id) VALUES (%s, %s, 'commissioner', %s)",
            (tenant_a_id, comm_uid, comm_pid),
        )
        cur.execute(
            "INSERT INTO tenant_members (tenant_id, user_id, role, primary_player_id) VALUES (%s, %s, 'member', %s)",
            (tenant_a_id, member_uid, member_pid),
        )
        cur.execute(
            "INSERT INTO tenant_members (tenant_id, user_id, role, primary_player_id) VALUES (%s, %s, 'commissioner', %s)",
            (tenant_b_id, comm_uid, b_pid),
        )

    db_conn.commit()

    data = {
        "tenant_a_id": tenant_a_id,
        "tenant_b_id": tenant_b_id,
        "comm_pid": comm_pid,
        "member_pid": member_pid,
        "alt_pid": alt_pid,
        "b_pid": b_pid,
        "comm_uid": comm_uid,
        "member_uid": member_uid,
    }
    yield data

    # Teardown — rollback any aborted transaction first, then clean up.
    # Deleting tenants cascades to players (migration_stage11), picks, user_players,
    # tenant_members, and tenant_weeks. Users are deleted separately (they span tenants).
    db_conn.rollback()
    with db_conn.cursor() as cur:
        cur.execute("DELETE FROM tenants WHERE tenant_id IN (%s, %s)", (tenant_a_id, tenant_b_id))
        cur.execute("DELETE FROM users WHERE user_id IN (%s, %s)", (comm_uid, member_uid))
    db_conn.commit()


# ── scored games + lock times ─────────────────────────────────────────────────

@pytest.fixture(scope="session")
def scored_games(db_conn, test_data):
    """
    Provides scored games for leaderboard/scoring tests and a dedicated unlocked
    game for pick submission tests.

    Yields a dict:
        rows             — list of (game_id, week_number, home_score, away_score)
        home_win_games   — subset where home_score > away_score
        away_win_games   — subset where away_score > home_score
        scored_weeks     — set of week_numbers covered by rows
        submission_gid   — game_id to use for pick submission tests (always week 17)
        submission_week  — 17
        synthetic_ids    — game_ids inserted by this fixture (deleted at teardown)

    Tenant A gets tenant_weeks rows:
        scored weeks → lock_at in the past (locked, results visible)
        week 17      → lock_at in 2099 (unlocked, picks submittable)
    Tenant B gets the same locked weeks (so isolation tests can call results endpoints).

    If the DB has no scored games (e.g. after reset-season), two synthetic games are
    written into week 1 with known scores (KC 21 BUF 14, LAR 10 SF 3). If a real game
    already occupies that (week, home, away) slot — e.g. the actual schedule's real,
    not-yet-played Week 1 LAR@SF — it's temporarily overwritten and restored to its
    original values at teardown instead of being deleted; otherwise a fresh row is
    inserted and deleted at teardown.
    """
    tenant_a_id = test_data["tenant_a_id"]
    tenant_b_id = test_data["tenant_b_id"]
    synthetic_ids = []
    original_games = []

    with db_conn.cursor() as cur:
        cur.execute("""
            SELECT game_id, week_number, home_score, away_score
            FROM games
            WHERE kickoff_at <= now()
              AND home_score IS NOT NULL
              AND away_score IS NOT NULL
            ORDER BY week_number, game_id
            LIMIT 10
        """)
        scored_rows = cur.fetchall()

    if not scored_rows:
        # Synthetic (week, kickoff, home, away, home_score, away_score). Week 1's real
        # matchups can coincide with these (e.g. a real, not-yet-played LAR@SF game) once
        # the season's actual schedule is loaded, since (week_number, home_abbr, away_abbr)
        # is unique. Where that happens, temporarily overwrite the real row instead of
        # failing on the conflict, and restore its original values at teardown so a real
        # scheduled game isn't left with a fake final score.
        synthetic_games = [
            (1, "2020-01-05 18:00:00+00", "KC", "BUF", 21, 14),
            (1, "2020-01-05 21:30:00+00", "LAR", "SF", 10, 3),
        ]
        new_rows = []
        with db_conn.cursor() as cur:
            for week, kickoff, home, away, hs, as_ in synthetic_games:
                cur.execute(
                    "SELECT game_id, kickoff_at, status, home_score, away_score "
                    "FROM games WHERE week_number = %s AND home_abbr = %s AND away_abbr = %s",
                    (week, home, away),
                )
                existing = cur.fetchone()
                if existing:
                    gid = existing[0]
                    cur.execute("""
                        UPDATE games SET kickoff_at = %s, status = 'final', home_score = %s, away_score = %s
                        WHERE game_id = %s
                    """, (kickoff, hs, as_, gid))
                    original_games.append(existing)
                else:
                    cur.execute("""
                        INSERT INTO games (week_number, kickoff_at, home_abbr, away_abbr, status, home_score, away_score)
                        VALUES (%s, %s, %s, %s, 'final', %s, %s)
                        RETURNING game_id
                    """, (week, kickoff, home, away, hs, as_))
                    gid = cur.fetchone()[0]
                    synthetic_ids.append(gid)
                new_rows.append((gid, week, hs, as_))
        db_conn.commit()
        scored_rows = new_rows

    scored_weeks = {r[1] for r in scored_rows}

    # Submission game — week 17, always synthetic, always unlocked
    submission_week = 17
    with db_conn.cursor() as cur:
        cur.execute("""
            INSERT INTO games (week_number, kickoff_at, home_abbr, away_abbr, status)
            VALUES (%s, '2099-09-01 20:00:00+00', 'TB', 'NO', 'scheduled')
            ON CONFLICT (week_number, home_abbr, away_abbr) DO NOTHING
            RETURNING game_id
        """, (submission_week,))
        row = cur.fetchone()
        if row:
            submission_gid = row[0]
            synthetic_ids.append(submission_gid)
        else:
            cur.execute(
                "SELECT game_id FROM games WHERE week_number = %s AND home_abbr = 'TB' AND away_abbr = 'NO'",
                (submission_week,),
            )
            submission_gid = cur.fetchone()[0]

        # Tenant A lock times
        for wk in scored_weeks:
            cur.execute("""
                INSERT INTO tenant_weeks (tenant_id, week_number, lock_at)
                VALUES (%s, %s, '2020-01-01 00:00:00+00')
                ON CONFLICT (tenant_id, week_number) DO NOTHING
            """, (tenant_a_id, wk))
        cur.execute("""
            INSERT INTO tenant_weeks (tenant_id, week_number, lock_at)
            VALUES (%s, %s, '2099-01-01 00:00:00+00')
            ON CONFLICT (tenant_id, week_number) DO UPDATE SET lock_at = '2099-01-01 00:00:00+00'
        """, (tenant_a_id, submission_week))

        # Tenant B locked weeks (for isolation tests)
        for wk in scored_weeks:
            cur.execute("""
                INSERT INTO tenant_weeks (tenant_id, week_number, lock_at)
                VALUES (%s, %s, '2020-01-01 00:00:00+00')
                ON CONFLICT (tenant_id, week_number) DO NOTHING
            """, (tenant_b_id, wk))

    db_conn.commit()

    yield {
        "rows": scored_rows,
        "home_win_games": [(gid, wk, hs, as_) for gid, wk, hs, as_ in scored_rows if hs > as_],
        "away_win_games": [(gid, wk, hs, as_) for gid, wk, hs, as_ in scored_rows if as_ > hs],
        "scored_weeks": scored_weeks,
        "submission_gid": submission_gid,
        "submission_week": submission_week,
        "synthetic_ids": synthetic_ids,
    }

    if synthetic_ids:
        db_conn.rollback()
        with db_conn.cursor() as cur:
            cur.execute("DELETE FROM games WHERE game_id = ANY(%s)", (synthetic_ids,))
        db_conn.commit()

    if original_games:
        db_conn.rollback()
        with db_conn.cursor() as cur:
            for gid, kickoff_at, status, home_score, away_score in original_games:
                cur.execute("""
                    UPDATE games SET kickoff_at = %s, status = %s, home_score = %s, away_score = %s
                    WHERE game_id = %s
                """, (kickoff_at, status, home_score, away_score, gid))
        db_conn.commit()


# ── per-test pick helpers ─────────────────────────────────────────────────────

@pytest.fixture
def pick_cleaner(db_conn):
    """
    Collects (player_id, game_id) pairs and deletes them after the test (pass or
    fail). Use alongside insert_pick or after API-submitted picks.
    """
    keys = []
    yield keys
    if keys:
        with db_conn.cursor() as cur:
            cur.execute("SET LOCAL app.bypass_lock = 'on'")
            for player_id, game_id in keys:
                cur.execute(
                    "DELETE FROM picks WHERE player_id = %s AND game_id = %s",
                    (player_id, game_id),
                )
        db_conn.commit()


@pytest.fixture
def insert_pick(db_conn, pick_cleaner):
    """
    Returns a helper that inserts a pick directly into the DB, bypassing the lock
    trigger (needed when inserting into locked weeks for setup). Registers the pick
    with pick_cleaner for automatic deletion after the test.

    Usage:
        insert_pick(player_id, game_id, picked_home=True, predicted_margin=7)
    """
    def _insert(player_id: int, game_id: int, picked_home: bool = True, predicted_margin: int = 7):
        with db_conn.cursor() as cur:
            cur.execute("SET LOCAL app.bypass_lock = 'on'")
            cur.execute("""
                INSERT INTO picks (player_id, game_id, picked_home, predicted_margin)
                VALUES (%s, %s, %s, %s)
                ON CONFLICT (player_id, game_id) DO UPDATE
                    SET picked_home = EXCLUDED.picked_home,
                        predicted_margin = EXCLUDED.predicted_margin
            """, (player_id, game_id, picked_home, predicted_margin))
        db_conn.commit()
        pick_cleaner.append((player_id, game_id))

    return _insert


# ── auth header fixtures ──────────────────────────────────────────────────────

@pytest.fixture(scope="session")
def comm_headers(test_data):
    """JWT token for the test commissioner, scoped to Tenant A."""
    token, _ = make_session_token(
        test_data["comm_pid"],
        test_data["tenant_a_id"],
        "testcomm@example.com",
        uid=test_data["comm_uid"],
    )
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture(scope="session")
def member_headers(test_data):
    """JWT token for the test member, scoped to Tenant A."""
    token, _ = make_session_token(
        test_data["member_pid"],
        test_data["tenant_a_id"],
        "testmember@example.com",
        uid=test_data["member_uid"],
    )
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture(scope="session")
def tenant_b_headers(test_data):
    """JWT token for the commissioner user, scoped to Tenant B."""
    token, _ = make_session_token(
        test_data["b_pid"],
        test_data["tenant_b_id"],
        "testcomm@example.com",
        uid=test_data["comm_uid"],
    )
    return {"Authorization": f"Bearer {token}"}
