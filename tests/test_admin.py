"""
Commissioner (admin) endpoint tests.
"""

import pytest

from backend.main import app
from backend.routes.auth import require_admin, AuthUser


@pytest.fixture
def roster_cleanup(db_conn):
    """Track aggregate-test records and remove them even when an assertion fails."""
    tracked = {"emails": set(), "player_ids": set()}
    yield tracked

    db_conn.rollback()
    with db_conn.cursor() as cur:
        if tracked["emails"]:
            cur.execute(
                """
                DELETE FROM tenant_members
                WHERE user_id IN (
                    SELECT user_id FROM users WHERE LOWER(email) = ANY(%s)
                )
                """,
                (list(tracked["emails"]),),
            )
        if tracked["player_ids"]:
            cur.execute("DELETE FROM players WHERE player_id = ANY(%s)", (list(tracked["player_ids"]),))
        if tracked["emails"]:
            cur.execute("DELETE FROM users WHERE LOWER(email) = ANY(%s)", (list(tracked["emails"]),))
    db_conn.commit()


def _aggregate(name, owner, managers=None, status="pending"):
    return {
        "pigeon_name": name,
        "season_status": status,
        "owner_email": owner,
        "manager_emails": managers or [],
    }


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
    by_id = {row["player_id"]: row for row in body}
    pids = set(by_id)
    assert test_data["comm_pid"] in pids
    assert test_data["member_pid"] in pids
    assert test_data["alt_pid"] in pids
    assert test_data["b_pid"] not in pids

    commissioner = by_id[test_data["comm_pid"]]
    assert commissioner["owner"] == {
        "user_id": test_data["comm_uid"],
        "email": "testcomm@example.com",
        "is_primary": True,
    }
    assert commissioner["managers"] == []

    alt = by_id[test_data["alt_pid"]]
    assert alt["owner"] is None
    assert alt["managers"] == [{
        "user_id": test_data["member_uid"],
        "email": "testmember@example.com",
        "is_primary": False,
    }]


def test_create_pigeon_builds_complete_aggregate_and_fills_lowest_gap(
    client, comm_headers, test_data, db_conn, roster_cleanup
):
    owner_email = "aggregate-owner@example.com"
    manager_email = "aggregate-manager@example.com"
    roster_cleanup["emails"].update({owner_email, manager_email})

    # A row at #5 distinguishes the smallest-gap rule from MAX(number) + 1.
    with db_conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO players (tenant_id, pigeon_number, pigeon_name, season_status)
            VALUES (%s, 5, '_AggregateGapSentinel', 'pending')
            RETURNING player_id
            """,
            (test_data["tenant_a_id"],),
        )
        roster_cleanup["player_ids"].add(cur.fetchone()[0])
    db_conn.commit()

    resp = client.post(
        "/admin/pigeons",
        json=_aggregate("_AggregateCreated", owner_email, [manager_email], "active"),
        headers=comm_headers,
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    roster_cleanup["player_ids"].add(body["player_id"])

    assert body["pigeon_number"] == 4
    assert body["pigeon_name"] == "_AggregateCreated"
    assert body["season_status"] == "active"
    assert body["owner"]["email"] == owner_email
    assert body["owner"]["is_primary"] is True
    assert [manager["email"] for manager in body["managers"]] == [manager_email]
    assert body["managers"][0]["is_primary"] is True

    with db_conn.cursor() as cur:
        cur.execute(
            """
            SELECT u.email, up.role, tm.role, tm.primary_player_id
            FROM users u
            JOIN user_players up ON up.user_id = u.user_id
            JOIN tenant_members tm
              ON tm.user_id = u.user_id
             AND tm.tenant_id = %s
            WHERE up.player_id = %s
            ORDER BY u.email
            """,
            (test_data["tenant_a_id"], body["player_id"]),
        )
        rows = cur.fetchall()
    assert rows == [
        (manager_email, "manager", "member", body["player_id"]),
        (owner_email, "owner", "member", body["player_id"]),
    ]


def test_create_pigeon_links_existing_global_user_without_touching_other_tenant(
    client, comm_headers, test_data, db_conn, roster_cleanup
):
    email = "aggregate-existing@example.com"
    roster_cleanup["emails"].add(email)
    with db_conn.cursor() as cur:
        cur.execute(
            "INSERT INTO users (email, password_hash) VALUES (%s, 'x') RETURNING user_id",
            (email,),
        )
        user_id = cur.fetchone()[0]
        cur.execute(
            "INSERT INTO user_players (user_id, player_id, role) VALUES (%s, %s, 'manager')",
            (user_id, test_data["b_pid"]),
        )
        cur.execute(
            """
            INSERT INTO tenant_members (tenant_id, user_id, role, primary_player_id)
            VALUES (%s, %s, 'member', %s)
            """,
            (test_data["tenant_b_id"], user_id, test_data["b_pid"]),
        )
    db_conn.commit()

    resp = client.post(
        "/admin/pigeons",
        json=_aggregate("_AggregateExisting", email),
        headers=comm_headers,
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    roster_cleanup["player_ids"].add(body["player_id"])
    assert body["owner"]["user_id"] == user_id

    with db_conn.cursor() as cur:
        cur.execute("SELECT COUNT(*) FROM users WHERE LOWER(email) = LOWER(%s)", (email,))
        assert cur.fetchone()[0] == 1
        cur.execute(
            "SELECT role, primary_player_id FROM tenant_members WHERE tenant_id = %s AND user_id = %s",
            (test_data["tenant_b_id"], user_id),
        )
        assert cur.fetchone() == ("member", test_data["b_pid"])
        cur.execute(
            "SELECT role FROM user_players WHERE user_id = %s AND player_id = %s",
            (user_id, test_data["b_pid"]),
        )
        assert cur.fetchone()[0] == "manager"


def test_update_pigeon_replaces_roles_and_repairs_primary(
    client, comm_headers, test_data, db_conn, roster_cleanup
):
    first_owner = "aggregate-first@example.com"
    second_owner = "aggregate-second@example.com"
    replacement_owner = "aggregate-replacement@example.com"
    roster_cleanup["emails"].update({first_owner, second_owner, replacement_owner})

    first = client.post(
        "/admin/pigeons",
        json=_aggregate("_AggregateFirst", first_owner),
        headers=comm_headers,
    ).json()
    second = client.post(
        "/admin/pigeons",
        json=_aggregate("_AggregateSecond", second_owner, [first_owner]),
        headers=comm_headers,
    ).json()
    roster_cleanup["player_ids"].update({first["player_id"], second["player_id"]})

    resp = client.put(
        f"/admin/pigeons/{first['player_id']}",
        json=_aggregate("_AggregateFirstRenamed", replacement_owner, [], "out"),
        headers=comm_headers,
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["pigeon_name"] == "_AggregateFirstRenamed"
    assert body["season_status"] == "out"
    assert body["owner"]["email"] == replacement_owner
    assert body["managers"] == []

    with db_conn.cursor() as cur:
        cur.execute(
            """
            SELECT tm.primary_player_id
            FROM tenant_members tm
            JOIN users u ON u.user_id = tm.user_id
            WHERE tm.tenant_id = %s AND LOWER(u.email) = LOWER(%s)
            """,
            (test_data["tenant_a_id"], first_owner),
        )
        assert cur.fetchone()[0] == second["player_id"]

    # Removing the person's final remaining assignment removes only membership.
    resp = client.put(
        f"/admin/pigeons/{second['player_id']}",
        json=_aggregate("_AggregateSecond", second_owner),
        headers=comm_headers,
    )
    assert resp.status_code == 200, resp.text
    with db_conn.cursor() as cur:
        cur.execute(
            """
            SELECT COUNT(*)
            FROM tenant_members tm
            JOIN users u ON u.user_id = tm.user_id
            WHERE tm.tenant_id = %s AND LOWER(u.email) = LOWER(%s)
            """,
            (test_data["tenant_a_id"], first_owner),
        )
        assert cur.fetchone()[0] == 0
        cur.execute("SELECT COUNT(*) FROM users WHERE LOWER(email) = LOWER(%s)", (first_owner,))
        assert cur.fetchone()[0] == 1


def test_update_pigeon_rolls_back_accounts_and_assignments_on_conflict(
    client, comm_headers, test_data, db_conn, roster_cleanup
):
    email = "aggregate-rollback@example.com"
    roster_cleanup["emails"].add(email)

    resp = client.put(
        f"/admin/pigeons/{test_data['alt_pid']}",
        json=_aggregate("_TestMember", email),
        headers=comm_headers,
    )
    assert resp.status_code == 409

    roster = client.get("/admin/pigeons", headers=comm_headers).json()
    alt = next(row for row in roster if row["player_id"] == test_data["alt_pid"])
    assert alt["pigeon_name"] == "_TestAlt"
    assert alt["owner"] is None
    assert [manager["email"] for manager in alt["managers"]] == ["testmember@example.com"]
    with db_conn.cursor() as cur:
        cur.execute("SELECT COUNT(*) FROM users WHERE LOWER(email) = LOWER(%s)", (email,))
        assert cur.fetchone()[0] == 0


def test_update_rejects_removing_a_commissioners_final_assignment(
    client, comm_headers, test_data, db_conn, roster_cleanup
):
    email = "aggregate-would-replace-commissioner@example.com"
    roster_cleanup["emails"].add(email)
    resp = client.put(
        f"/admin/pigeons/{test_data['comm_pid']}",
        json=_aggregate("_TestComm", email),
        headers=comm_headers,
    )
    assert resp.status_code == 409
    assert "Commissioner" in resp.json()["detail"]

    row = next(
        item
        for item in client.get("/admin/pigeons", headers=comm_headers).json()
        if item["player_id"] == test_data["comm_pid"]
    )
    assert row["owner"]["email"] == "testcomm@example.com"
    with db_conn.cursor() as cur:
        cur.execute("SELECT COUNT(*) FROM users WHERE LOWER(email) = LOWER(%s)", (email,))
        assert cur.fetchone()[0] == 0


def test_delete_pigeon_repairs_primary_then_removes_final_tenant_membership(
    client, comm_headers, test_data, db_conn, roster_cleanup
):
    first_owner = "aggregate-delete-first@example.com"
    second_owner = "aggregate-delete-second@example.com"
    roster_cleanup["emails"].update({first_owner, second_owner})
    first = client.post(
        "/admin/pigeons",
        json=_aggregate("_AggregateDeleteFirst", first_owner),
        headers=comm_headers,
    ).json()
    second = client.post(
        "/admin/pigeons",
        json=_aggregate("_AggregateDeleteSecond", second_owner, [first_owner]),
        headers=comm_headers,
    ).json()
    roster_cleanup["player_ids"].update({first["player_id"], second["player_id"]})

    resp = client.delete(f"/admin/pigeons/{first['player_id']}", headers=comm_headers)
    assert resp.status_code == 204, resp.text
    with db_conn.cursor() as cur:
        cur.execute(
            """
            SELECT tm.primary_player_id
            FROM tenant_members tm
            JOIN users u ON u.user_id = tm.user_id
            WHERE tm.tenant_id = %s AND LOWER(u.email) = LOWER(%s)
            """,
            (test_data["tenant_a_id"], first_owner),
        )
        assert cur.fetchone()[0] == second["player_id"]

    resp = client.delete(f"/admin/pigeons/{second['player_id']}", headers=comm_headers)
    assert resp.status_code == 204, resp.text
    with db_conn.cursor() as cur:
        cur.execute(
            """
            SELECT COUNT(*)
            FROM tenant_members tm
            JOIN users u ON u.user_id = tm.user_id
            WHERE tm.tenant_id = %s AND LOWER(u.email) IN (LOWER(%s), LOWER(%s))
            """,
            (test_data["tenant_a_id"], first_owner, second_owner),
        )
        assert cur.fetchone()[0] == 0
        cur.execute(
            "SELECT COUNT(*) FROM users WHERE LOWER(email) IN (LOWER(%s), LOWER(%s))",
            (first_owner, second_owner),
        )
        assert cur.fetchone()[0] == 2


def test_update_other_tenant_pigeon_is_not_found(client, comm_headers, test_data):
    resp = client.put(
        f"/admin/pigeons/{test_data['b_pid']}",
        json=_aggregate("HijackAttempt", "testcomm@example.com"),
        headers=comm_headers,
    )
    assert resp.status_code == 404


def test_obsolete_admin_pigeon_patch_and_user_routes_are_removed(client, comm_headers, test_data):
    patch = client.patch(
        f"/admin/pigeons/{test_data['alt_pid']}",
        json={"pigeon_name": "NoLongerSupported"},
        headers=comm_headers,
    )
    assert patch.status_code == 405
    assert client.get("/admin/users", headers=comm_headers).status_code == 404


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


def test_update_pigeons_can_rename_setting(client, comm_headers, test_data, db_conn):
    resp = client.patch("/admin/league", json={"pigeons_can_rename": False}, headers=comm_headers)
    assert resp.status_code == 204

    me = client.get("/auth/me", headers=comm_headers).json()
    tenant = next(t for t in me["available_tenants"] if t["tenant_id"] == test_data["tenant_a_id"])
    assert tenant["pigeons_can_rename"] is False

    # Restore
    with db_conn.cursor() as cur:
        cur.execute("UPDATE tenants SET pigeons_can_rename = true WHERE tenant_id = %s", (test_data["tenant_a_id"],))
    db_conn.commit()


# ── pigeon name validation ───────────────────────────────────────────────────

def test_create_pigeon_name_too_long_rejected(client, comm_headers):
    resp = client.post(
        "/admin/pigeons",
        json=_aggregate("x" * 31, "valid-owner@example.com"),
        headers=comm_headers,
    )
    assert resp.status_code == 422


def test_create_pigeon_name_empty_rejected(client, comm_headers):
    resp = client.post(
        "/admin/pigeons",
        json=_aggregate("   ", "valid-owner@example.com"),
        headers=comm_headers,
    )
    assert resp.status_code == 422


def test_create_pigeon_name_control_char_rejected(client, comm_headers):
    resp = client.post(
        "/admin/pigeons",
        json=_aggregate("Bad\nName", "valid-owner@example.com"),
        headers=comm_headers,
    )
    assert resp.status_code == 422


def test_update_pigeon_name_too_long_rejected(client, comm_headers, test_data):
    resp = client.put(
        f"/admin/pigeons/{test_data['alt_pid']}",
        json=_aggregate("x" * 31, "testmember@example.com"),
        headers=comm_headers,
    )
    assert resp.status_code == 422


def test_duplicate_and_overlapping_manager_emails_are_rejected(client, comm_headers):
    duplicate = client.post(
        "/admin/pigeons",
        json=_aggregate(
            "_DuplicateManagers",
            "owner@example.com",
            ["manager@example.com", "MANAGER@example.com"],
        ),
        headers=comm_headers,
    )
    assert duplicate.status_code == 422

    overlap = client.post(
        "/admin/pigeons",
        json=_aggregate("_OverlappingOwner", "owner@example.com", ["OWNER@example.com"]),
        headers=comm_headers,
    )
    assert overlap.status_code == 422


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


# ── xlsx picks import ─────────────────────────────────────────────────────────

def test_import_picks_xlsx_rejected_for_non_original_tenant(client, comm_headers, test_data):
    """
    Only tenant 1 (the original league) may use this legacy import. Also guards
    against regressing the endpoint's use of `me` before reaching this check.
    """
    assert test_data["tenant_a_id"] != 1
    resp = client.post(
        "/admin/import-picks-xlsx",
        headers=comm_headers,
        data={"week": "1"},
        files={"file": ("picks.xlsx", b"fake-xlsx-bytes", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
    )
    assert resp.status_code == 403


def test_import_picks_xlsx_success_for_original_tenant(client, comm_headers, monkeypatch):
    """Simulates tenant 1 via a dependency override; the real xlsx engine is stubbed out."""
    def fake_require_admin():
        return AuthUser(player_id=1, pigeon_number=1, tenant_id=1, email="testcomm@example.com", is_admin=True)

    captured = {}

    def fake_import(tmp_path, week):
        captured["week"] = week
        return 7

    monkeypatch.setattr("backend.routes.admin.import_picks_pivot_xlsx_with_engine", fake_import)
    app.dependency_overrides[require_admin] = fake_require_admin
    try:
        resp = client.post(
            "/admin/import-picks-xlsx",
            headers=comm_headers,
            data={"week": "3"},
            files={"file": ("picks.xlsx", b"fake-xlsx-bytes", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")},
        )
    finally:
        del app.dependency_overrides[require_admin]

    assert resp.status_code == 200
    assert resp.json() == {"processed": 7}
    assert captured["week"] == 3
