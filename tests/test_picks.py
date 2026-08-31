"""
Pick submission and retrieval tests.
"""

import asyncio
from typing import cast

from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.pool import NullPool

from backend.routes.auth import AuthUser
from backend.routes.picks import _resolve_acting_player
from backend.utils.settings import get_settings
from backend.utils.submit_picks_to_andy import build_submit_body_from_db

# ── GET picks ─────────────────────────────────────────────────────────────────

def test_get_picks_empty_before_submission(client, member_headers, scored_games):
    week = scored_games["submission_week"]
    resp = client.get(f"/picks/{week}", headers=member_headers)
    assert resp.status_code == 200
    # v_picks_filled synthesizes rows for every game; all should have is_made=False
    # The endpoint returns PickOut rows — one per game in the week
    body = resp.json()
    assert isinstance(body, list)


# ── POST picks — happy path ───────────────────────────────────────────────────

def test_submit_picks_before_lock(client, member_headers, scored_games, pick_cleaner, test_data):
    """Submitting picks to the unlocked week succeeds."""
    week = scored_games["submission_week"]
    gid = scored_games["submission_gid"]
    resp = client.post(
        "/picks",
        json={"week_number": week, "picks": [{"game_id": gid, "picked_home": True, "predicted_margin": 7}]},
        headers=member_headers,
    )
    assert resp.status_code == 201
    body = resp.json()
    assert len(body) == 1
    assert body[0]["picked_home"] is True
    assert body[0]["predicted_margin"] == 7
    pick_cleaner.append((test_data["member_pid"], gid))


def test_get_picks_after_submission(client, member_headers, scored_games, insert_pick, test_data):
    """After inserting a pick, GET /picks/{week} returns it."""
    week = scored_games["submission_week"]
    gid = scored_games["submission_gid"]
    insert_pick(test_data["member_pid"], gid, picked_home=False, predicted_margin=3)

    resp = client.get(f"/picks/{week}", headers=member_headers)
    assert resp.status_code == 200
    rows = {r["game_id"]: r for r in resp.json()}
    assert gid in rows
    assert rows[gid]["picked_home"] is False
    assert rows[gid]["predicted_margin"] == 3


# ── POST picks — lock enforcement ─────────────────────────────────────────────

def test_submit_picks_after_lock_rejected(client, member_headers, scored_games):
    """Submitting picks to a locked week returns 409."""
    locked_week = next(iter(scored_games["scored_weeks"]))
    gid = scored_games["rows"][0][0]
    resp = client.post(
        "/picks",
        json={"week_number": locked_week, "picks": [{"game_id": gid, "picked_home": True, "predicted_margin": 7}]},
        headers=member_headers,
    )
    assert resp.status_code == 409


# ── POST picks — alt-player ───────────────────────────────────────────────────

def test_member_submits_for_managed_player(client, member_headers, scored_games, pick_cleaner, test_data):
    """Member with manager role can submit picks for the managed player, in any tenant."""
    week = scored_games["submission_week"]
    gid = scored_games["submission_gid"]
    alt_pid = test_data["alt_pid"]

    resp = client.post(
        f"/picks?player_id={alt_pid}",
        json={"week_number": week, "picks": [{"game_id": gid, "picked_home": False, "predicted_margin": 5}]},
        headers=member_headers,
    )
    assert resp.status_code == 201
    pick_cleaner.append((alt_pid, gid))


def test_commissioner_cannot_submit_for_unmanaged_player_outside_tenant_one(client, comm_headers, scored_games, test_data):
    """
    Commissioner "god mode" (acting for any player, not just owned/managed ones)
    only applies in tenant 1 (Andy's league). The test tenant isn't tenant 1, and
    the commissioner has no owner/manager relationship to member_pid, so this must
    be rejected.
    """
    assert test_data["tenant_a_id"] != 1
    week = scored_games["submission_week"]
    gid = scored_games["submission_gid"]
    member_pid = test_data["member_pid"]

    resp = client.post(
        f"/picks?player_id={member_pid}",
        json={"week_number": week, "picks": [{"game_id": gid, "picked_home": True, "predicted_margin": 10}]},
        headers=comm_headers,
    )
    assert resp.status_code == 403


class _FakeResult:
    def __init__(self, row):
        self._row = row

    def first(self):
        return self._row


class _FakeDB:
    """Stands in for the AsyncSession so this test doesn't need a real tenant-1
    player row — the test DB never mints real tenant 1 (that's Andy's actual
    league), so PLAYER_IN_TENANT_SQL can't be exercised against real data."""

    def __init__(self, row):
        self._row = row

    async def execute(self, *_args, **_kwargs):
        return _FakeResult(self._row)


def test_commissioner_god_mode_allowed_in_tenant_one():
    """Commissioner (is_admin) in tenant 1 may act for any player found in that tenant."""
    me = AuthUser(player_id=1, pigeon_number=1, tenant_id=1, email="testcomm@example.com", is_admin=True)
    db = cast(AsyncSession, _FakeDB(row=(1,)))  # test double for AsyncSession.execute
    result = asyncio.run(_resolve_acting_player(db, me, requested_player_id=999))
    assert result == 999


def test_andy_survey_payload_is_scoped_by_player_and_tenant(
    scored_games, insert_pick, test_data
):
    """Same-numbered pigeons in another tenant must not enter Andy's payload."""
    week = scored_games["submission_week"]
    game_id = scored_games["submission_gid"]
    insert_pick(test_data["comm_pid"], game_id, picked_home=True, predicted_margin=7)
    insert_pick(test_data["b_pid"], game_id, picked_home=False, predicted_margin=31)

    async def _build_payload():
        engine = create_async_engine(
            get_settings().sqlalchemy_async_url(),
            poolclass=NullPool,
        )
        try:
            async with AsyncSession(engine) as session:
                return await build_submit_body_from_db(
                    session,
                    week=week,
                    player_id=test_data["comm_pid"],
                    tenant_id=test_data["tenant_a_id"],
                    pin=9182,
                )
        finally:
            await engine.dispose()

    body = asyncio.run(_build_payload())

    assert body.pigeon_number == 1
    assert body.player_name == "_TestComm"
    assert len(body.picks) == 1
    assert body.picks[0].winner == "home"
    assert body.picks[0].spread == 7


def test_member_cannot_submit_for_unmanaged_player(client, member_headers, scored_games, test_data):
    """Member cannot submit picks for a player they don't own or manage."""
    week = scored_games["submission_week"]
    gid = scored_games["submission_gid"]
    comm_pid = test_data["comm_pid"]  # member has no relation to comm's player

    resp = client.post(
        f"/picks?player_id={comm_pid}",
        json={"week_number": week, "picks": [{"game_id": gid, "picked_home": True, "predicted_margin": 7}]},
        headers=member_headers,
    )
    assert resp.status_code == 403


# ── POST picks — validation ───────────────────────────────────────────────────

def test_submit_picks_wrong_game_for_week(client, member_headers, scored_games):
    """game_id that doesn't belong to the requested week returns 400."""
    week = scored_games["submission_week"]
    # Use a game_id from a different (scored) week
    other_gid = scored_games["rows"][0][0]
    resp = client.post(
        "/picks",
        json={"week_number": week, "picks": [{"game_id": other_gid, "picked_home": True, "predicted_margin": 7}]},
        headers=member_headers,
    )
    assert resp.status_code == 400


def test_submit_picks_no_auth(client, scored_games):
    week = scored_games["submission_week"]
    gid = scored_games["submission_gid"]
    resp = client.post(
        "/picks",
        json={"week_number": week, "picks": [{"game_id": gid, "picked_home": True, "predicted_margin": 7}]},
    )
    assert resp.status_code == 401
