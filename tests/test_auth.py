"""
Auth endpoint tests: login, /me, select-context, password reset.
"""

from unittest.mock import patch


# ── login ─────────────────────────────────────────────────────────────────────

def test_login_success(client, test_data):
    resp = client.post("/auth/login", json={
        "email": "testcomm@example.com",
        "password": "testpass",
    })
    assert resp.status_code == 200
    body = resp.json()
    assert body["ok"] is True
    assert "access_token" in body
    assert body["user"]["tenant_id"] == test_data["tenant_a_id"]
    assert body["user"]["is_admin"] is True


def test_login_wrong_password(client):
    resp = client.post("/auth/login", json={
        "email": "testcomm@example.com",
        "password": "wrongpass",
    })
    assert resp.status_code == 401


def test_login_unknown_email(client):
    resp = client.post("/auth/login", json={
        "email": "nobody@example.com",
        "password": "irrelevant",
    })
    assert resp.status_code == 401


# ── /auth/me ──────────────────────────────────────────────────────────────────

def test_me_commissioner(client, comm_headers, test_data):
    resp = client.get("/auth/me", headers=comm_headers)
    assert resp.status_code == 200
    body = resp.json()
    assert body["tenant_id"] == test_data["tenant_a_id"]
    assert body["player_id"] == test_data["comm_pid"]
    assert body["is_admin"] is True
    # Commissioner belongs to both tenant A and B
    tenant_ids = {t["tenant_id"] for t in body["available_tenants"]}
    assert test_data["tenant_a_id"] in tenant_ids
    assert test_data["tenant_b_id"] in tenant_ids


def test_me_member(client, member_headers, test_data):
    resp = client.get("/auth/me", headers=member_headers)
    assert resp.status_code == 200
    body = resp.json()
    assert body["is_admin"] is False
    assert body["player_id"] == test_data["member_pid"]


def test_me_no_token(client):
    resp = client.get("/auth/me")
    assert resp.status_code == 401


def test_me_bad_token(client):
    resp = client.get("/auth/me", headers={"Authorization": "Bearer not.a.real.token"})
    assert resp.status_code == 401


# ── select-context ────────────────────────────────────────────────────────────

def test_select_context_switches_tenant(client, comm_headers, test_data):
    resp = client.post(
        "/auth/select-context",
        json={"tenant_id": test_data["tenant_b_id"]},
        headers=comm_headers,
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["user"]["tenant_id"] == test_data["tenant_b_id"]
    assert body["user"]["player_id"] == test_data["b_pid"]


def test_select_context_rejects_non_member(client, member_headers, test_data):
    # member belongs only to Tenant A; requesting Tenant B should fail
    resp = client.post(
        "/auth/select-context",
        json={"tenant_id": test_data["tenant_b_id"]},
        headers=member_headers,
    )
    assert resp.status_code == 403


# ── password reset ────────────────────────────────────────────────────────────

def test_password_reset_request_returns_ok(client):
    # Always returns 200 regardless of whether the email exists (prevents enumeration)
    with patch("backend.routes.auth.send_email"):
        resp = client.post("/auth/password-reset", json={"email": "testcomm@example.com"})
    assert resp.status_code == 200
    assert resp.json()["ok"] is True


def test_password_reset_unknown_email_still_200(client):
    with patch("backend.routes.auth.send_email"):
        resp = client.post("/auth/password-reset", json={"email": "ghost@example.com"})
    assert resp.status_code == 200
