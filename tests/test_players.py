"""Self-service pigeon settings endpoint tests."""


def test_rename_own_pigeon(client, member_headers, test_data, db_conn):
    pid = test_data["member_pid"]
    resp = client.patch(f"/players/{pid}/name", json={"pigeon_name": "_TestMemberRenamed"}, headers=member_headers)
    assert resp.status_code == 200
    body = resp.json()
    assert body["pigeon_name"] == "_TestMemberRenamed"
    assert body["player_id"] == pid

    with db_conn.cursor() as cur:
        cur.execute("UPDATE players SET pigeon_name = '_TestMember' WHERE player_id = %s", (pid,))
    db_conn.commit()


def test_rename_managed_pigeon(client, member_headers, test_data, db_conn):
    """The test member has a 'manager' (not 'owner') role on alt_pid — should still be allowed."""
    pid = test_data["alt_pid"]
    resp = client.patch(f"/players/{pid}/name", json={"pigeon_name": "_TestAltRenamed"}, headers=member_headers)
    assert resp.status_code == 200

    with db_conn.cursor() as cur:
        cur.execute("UPDATE players SET pigeon_name = '_TestAlt' WHERE player_id = %s", (pid,))
    db_conn.commit()


def test_rename_unowned_pigeon_forbidden(client, member_headers, test_data):
    """The test member neither owns nor manages comm_pid."""
    resp = client.patch(
        f"/players/{test_data['comm_pid']}/name", json={"pigeon_name": "Hijacked"}, headers=member_headers
    )
    assert resp.status_code == 403


def test_rename_cross_tenant_not_found(client, tenant_b_headers, test_data):
    """Token scoped to Tenant B trying to rename a Tenant A player (even one the same login owns)."""
    resp = client.patch(
        f"/players/{test_data['comm_pid']}/name", json={"pigeon_name": "Hijacked"}, headers=tenant_b_headers
    )
    assert resp.status_code == 404


def test_rename_duplicate_name_conflict(client, member_headers, test_data):
    resp = client.patch(
        f"/players/{test_data['member_pid']}/name", json={"pigeon_name": "_TestComm"}, headers=member_headers
    )
    assert resp.status_code == 409


def test_rename_empty_name_rejected(client, member_headers, test_data):
    resp = client.patch(
        f"/players/{test_data['member_pid']}/name", json={"pigeon_name": "   "}, headers=member_headers
    )
    assert resp.status_code == 422


def test_rename_too_long_name_rejected(client, member_headers, test_data):
    resp = client.patch(
        f"/players/{test_data['member_pid']}/name", json={"pigeon_name": "x" * 31}, headers=member_headers
    )
    assert resp.status_code == 422


def test_rename_control_char_rejected(client, member_headers, test_data):
    resp = client.patch(
        f"/players/{test_data['member_pid']}/name", json={"pigeon_name": "Bad\nName"}, headers=member_headers
    )
    assert resp.status_code == 422


def test_rename_blocked_when_league_setting_off(client, member_headers, test_data, db_conn):
    with db_conn.cursor() as cur:
        cur.execute("UPDATE tenants SET pigeons_can_rename = false WHERE tenant_id = %s", (test_data["tenant_a_id"],))
    db_conn.commit()

    try:
        resp = client.patch(
            f"/players/{test_data['member_pid']}/name", json={"pigeon_name": "_ShouldNotWork"}, headers=member_headers
        )
        assert resp.status_code == 403
    finally:
        with db_conn.cursor() as cur:
            cur.execute("UPDATE tenants SET pigeons_can_rename = true WHERE tenant_id = %s", (test_data["tenant_a_id"],))
        db_conn.commit()


def test_rename_requires_auth(client, test_data):
    resp = client.patch(f"/players/{test_data['member_pid']}/name", json={"pigeon_name": "NoAuth"})
    assert resp.status_code == 401


def test_set_primary_pigeon_to_managed_pigeon(client, member_headers, test_data, db_conn):
    resp = client.put(
        "/me/primary-pigeon",
        json={"player_id": test_data["alt_pid"]},
        headers=member_headers,
    )
    assert resp.status_code == 204

    with db_conn.cursor() as cur:
        cur.execute(
            "SELECT primary_player_id FROM tenant_members WHERE tenant_id = %s AND user_id = %s",
            (test_data["tenant_a_id"], test_data["member_uid"]),
        )
        assert cur.fetchone()[0] == test_data["alt_pid"]
        cur.execute(
            "UPDATE tenant_members SET primary_player_id = %s WHERE tenant_id = %s AND user_id = %s",
            (test_data["member_pid"], test_data["tenant_a_id"], test_data["member_uid"]),
        )
    db_conn.commit()


def test_set_primary_pigeon_rejects_unmanaged_pigeon(client, member_headers, test_data):
    resp = client.put(
        "/me/primary-pigeon",
        json={"player_id": test_data["comm_pid"]},
        headers=member_headers,
    )
    assert resp.status_code == 400


def test_set_primary_pigeon_rejects_cross_tenant_player(client, member_headers, test_data):
    resp = client.put(
        "/me/primary-pigeon",
        json={"player_id": test_data["b_pid"]},
        headers=member_headers,
    )
    assert resp.status_code == 400
