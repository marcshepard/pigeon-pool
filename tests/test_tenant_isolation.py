"""
Tenant isolation tests — verify Tenant A data never leaks into Tenant B responses.
"""

import pytest


def test_picks_isolated_to_tenant(client, tenant_b_headers, scored_games, test_data, insert_pick):
    """Picks inserted for Tenant A's player are not visible to Tenant B."""
    gid = scored_games["submission_gid"]
    week = scored_games["submission_week"]
    insert_pick(test_data["comm_pid"], gid, picked_home=True, predicted_margin=10)

    resp_b = client.get(f"/picks/{week}", headers=tenant_b_headers)
    assert resp_b.status_code == 200
    # Tenant B's pick response must not include this game as made
    made = {r["game_id"] for r in resp_b.json() if r.get("is_made")}
    assert gid not in made, "Tenant A pick must not appear in Tenant B's picks"


def test_leaderboard_isolated_to_tenant(client, comm_headers, tenant_b_headers, scored_games):
    """Weekly leaderboard is scoped per tenant — names don't cross."""
    if not scored_games["scored_weeks"]:
        pytest.skip("No scored weeks available")

    week = next(iter(scored_games["scored_weeks"]))
    resp_a = client.get(f"/results/weeks/{week}/leaderboard", headers=comm_headers)
    resp_b = client.get(f"/results/weeks/{week}/leaderboard", headers=tenant_b_headers)

    assert resp_a.status_code == 200
    assert resp_b.status_code == 200

    names_a = {r["pigeon_name"] for r in resp_a.json()}
    names_b = {r["pigeon_name"] for r in resp_b.json()}
    assert "_TestB" not in names_a, "Tenant B player must not appear in Tenant A's leaderboard"
    assert "_TestComm" not in names_b, "Tenant A player must not appear in Tenant B's leaderboard"


def test_admin_pigeons_isolated(client, comm_headers, tenant_b_headers, test_data):
    """Admin pigeon list is scoped per tenant."""
    resp_a = client.get("/admin/pigeons", headers=comm_headers)
    resp_b = client.get("/admin/pigeons", headers=tenant_b_headers)

    assert resp_a.status_code == 200
    assert resp_b.status_code == 200

    pids_a = {r["player_id"] for r in resp_a.json()}
    pids_b = {r["player_id"] for r in resp_b.json()}

    assert test_data["b_pid"] not in pids_a, "Tenant B player must not appear in Tenant A's admin list"
    assert test_data["comm_pid"] not in pids_b, \
        "Tenant A comm player must not appear in Tenant B's admin player list"


def test_week_picks_view_isolated(client, comm_headers, tenant_b_headers, scored_games):
    """/results/weeks/{week}/picks is scoped per tenant — names don't cross."""
    if not scored_games["scored_weeks"]:
        pytest.skip("No scored weeks available")

    week = next(iter(scored_games["scored_weeks"]))
    resp_a = client.get(f"/results/weeks/{week}/picks", headers=comm_headers)
    resp_b = client.get(f"/results/weeks/{week}/picks", headers=tenant_b_headers)

    assert resp_a.status_code == 200
    assert resp_b.status_code == 200

    names_a = {r["pigeon_name"] for r in resp_a.json()}
    names_b = {r["pigeon_name"] for r in resp_b.json()}
    assert "_TestB" not in names_a, "Tenant B player must not appear in Tenant A week picks"
    assert "_TestComm" not in names_b, "Tenant A player must not appear in Tenant B week picks"


def test_ytd_leaderboard_isolated(client, comm_headers, tenant_b_headers):
    """YTD leaderboard is tenant-scoped — names don't cross."""
    resp_a = client.get("/results/leaderboard", headers=comm_headers)
    resp_b = client.get("/results/leaderboard", headers=tenant_b_headers)

    assert resp_a.status_code == 200
    assert resp_b.status_code == 200

    names_a = {r["pigeon_name"] for r in resp_a.json()}
    names_b = {r["pigeon_name"] for r in resp_b.json()}
    assert "_TestB" not in names_a, "Tenant B player must not appear in Tenant A's YTD leaderboard"
    assert "_TestComm" not in names_b, "Tenant A player must not appear in Tenant B's YTD leaderboard"
