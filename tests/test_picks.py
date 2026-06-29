"""
Pick submission and retrieval tests.
"""


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

def test_commissioner_submits_for_another_player(client, comm_headers, scored_games, pick_cleaner, test_data):
    """Commissioner can submit picks on behalf of any player in their tenant."""
    week = scored_games["submission_week"]
    gid = scored_games["submission_gid"]
    member_pid = test_data["member_pid"]

    resp = client.post(
        f"/picks?player_id={member_pid}",
        json={"week_number": week, "picks": [{"game_id": gid, "picked_home": True, "predicted_margin": 10}]},
        headers=comm_headers,
    )
    assert resp.status_code == 201
    pick_cleaner.append((member_pid, gid))


def test_member_submits_for_managed_player(client, member_headers, scored_games, pick_cleaner, test_data):
    """Member with manager role can submit picks for the managed player."""
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
