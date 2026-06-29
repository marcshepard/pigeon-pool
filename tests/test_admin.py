"""
Commissioner (admin) endpoint tests.
"""


# ── access control ────────────────────────────────────────────────────────────

def test_non_commissioner_cannot_access_pigeons(client, member_headers):
    resp = client.get("/admin/pigeons", headers=member_headers)
    assert resp.status_code == 403


def test_no_auth_cannot_access_pigeons(client):
    resp = client.get("/admin/pigeons")
    assert resp.status_code == 401


# ── pigeon (player) management ───────────────────────────────────────────────

def test_get_pigeons_lists_test_players(client, comm_headers, test_data):
    resp = client.get("/admin/pigeons", headers=comm_headers)
    assert resp.status_code == 200
    body = resp.json()
    pids = {r["player_id"] for r in body}
    assert test_data["comm_pid"] in pids
    assert test_data["member_pid"] in pids
    assert test_data["alt_pid"] in pids
    # Tenant B's player must NOT appear
    assert test_data["b_pid"] not in pids


def test_create_pigeon(client, comm_headers, db_conn):
    resp = client.post(
        "/admin/pigeons",
        json={"pigeon_name": "_TmpPigeon"},
        headers=comm_headers,
    )
    assert resp.status_code == 201
    body = resp.json()
    assert body["pigeon_name"] == "_TmpPigeon"
    player_id = body["player_id"]

    # Cleanup
    with db_conn.cursor() as cur:
        cur.execute("DELETE FROM players WHERE player_id = %s", (player_id,))
    db_conn.commit()


def test_update_pigeon_name(client, comm_headers, test_data, db_conn):
    pid = test_data["alt_pid"]
    resp = client.patch(
        f"/admin/pigeons/{pid}",
        json={"pigeon_name": "_TestAltRenamed"},
        headers=comm_headers,
    )
    assert resp.status_code == 200

    # Restore original name
    with db_conn.cursor() as cur:
        cur.execute("UPDATE players SET pigeon_name = '_TestAlt' WHERE player_id = %s", (pid,))
    db_conn.commit()


def test_update_pigeon_season_status(client, comm_headers, test_data):
    pid = test_data["member_pid"]
    for status in ("active", "out", "pending"):
        resp = client.patch(
            f"/admin/pigeons/{pid}",
            json={"season_status": status},
            headers=comm_headers,
        )
        assert resp.status_code == 200

    pigeons = client.get("/admin/pigeons", headers=comm_headers).json()
    member_row = next(r for r in pigeons if r["player_id"] == pid)
    assert member_row["season_status"] == "pending"


def test_update_pigeon_invalid_season_status(client, comm_headers, test_data):
    resp = client.patch(
        f"/admin/pigeons/{test_data['member_pid']}",
        json={"season_status": "injured"},
        headers=comm_headers,
    )
    assert resp.status_code == 400


def test_update_pigeon_from_other_tenant_404(client, comm_headers, test_data):
    """Cannot patch a player that belongs to a different tenant."""
    resp = client.patch(
        f"/admin/pigeons/{test_data['b_pid']}",
        json={"pigeon_name": "HijackAttempt"},
        headers=comm_headers,
    )
    assert resp.status_code == 404


# ── league rename ─────────────────────────────────────────────────────────────

def test_rename_league(client, comm_headers, test_data, db_conn):
    resp = client.patch("/admin/league", json={"name": "_Renamed League A"}, headers=comm_headers)
    assert resp.status_code == 204

    me = client.get("/auth/me", headers=comm_headers).json()
    tenant = next(t for t in me["available_tenants"] if t["tenant_id"] == test_data["tenant_a_id"])
    assert tenant["name"] == "_Renamed League A"

    # Restore
    with db_conn.cursor() as cur:
        cur.execute("UPDATE tenants SET name = '_Test League A' WHERE tenant_id = %s", (test_data["tenant_a_id"],))
    db_conn.commit()


def test_rename_league_empty_name_rejected(client, comm_headers):
    resp = client.patch("/admin/league", json={"name": "   "}, headers=comm_headers)
    assert resp.status_code == 400


# ── payouts ───────────────────────────────────────────────────────────────────

def test_get_payouts_returns_list(client, comm_headers):
    resp = client.get("/admin/payouts", headers=comm_headers)
    assert resp.status_code == 200
    assert isinstance(resp.json(), list)


def test_put_payouts_replaces_table(client, comm_headers):
    new_payouts = [
        {"place": 1, "points": 100},
        {"place": 2, "points": 50},
        {"place": 3, "points": 25},
    ]
    resp = client.put("/admin/payouts", json=new_payouts, headers=comm_headers)
    assert resp.status_code == 204

    resp = client.get("/admin/payouts", headers=comm_headers)
    assert resp.status_code == 200
    body = resp.json()
    assert len(body) == 3
    assert body[0]["place"] == 1
    assert body[0]["points"] == 100


def test_put_payouts_empty_list_rejected(client, comm_headers):
    resp = client.put("/admin/payouts", json=[], headers=comm_headers)
    assert resp.status_code == 400


def test_member_can_get_payouts(client, member_headers):
    resp = client.get("/admin/payouts", headers=member_headers)
    assert resp.status_code == 200


def test_member_cannot_put_payouts(client, member_headers):
    resp = client.put("/admin/payouts", json=[{"place": 1, "points": 999}], headers=member_headers)
    assert resp.status_code == 403


# ── user management ───────────────────────────────────────────────────────────

def test_get_users_lists_tenant_members(client, comm_headers):
    resp = client.get("/admin/users", headers=comm_headers)
    assert resp.status_code == 200
    emails = {r["email"] for r in resp.json()}
    assert "testcomm@example.com" in emails
    assert "testmember@example.com" in emails
