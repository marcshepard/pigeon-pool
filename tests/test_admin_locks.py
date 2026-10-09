"""Bulk deadline validation and real database tenant-isolation regressions."""

from datetime import UTC, datetime
from unittest.mock import AsyncMock

import pytest
from sqlalchemy import text

from backend.routes import admin
from backend.routes.schedule import CurrentWeek


@pytest.fixture
def lock_schedule(monkeypatch, db_conn, test_data):
    """Use deterministic kickoff dates without editing any shared games."""
    tid = test_data["tenant_a_id"]
    with db_conn.cursor() as cur:
        cur.execute("SELECT week_number, lock_at FROM tenant_weeks WHERE tenant_id = %s", (tid,))
        original = cur.fetchall()
        for week in (5, 6, 7, 8):
            cur.execute("INSERT INTO tenant_weeks VALUES (%s, %s, '2099-01-01 00:00:00+00') ON CONFLICT (tenant_id, week_number) DO UPDATE SET lock_at = EXCLUDED.lock_at", (tid, week))
    db_conn.commit()
    monkeypatch.setattr(admin, "get_current_week", AsyncMock(return_value=CurrentWeek(week=6, status="scheduled", any_locked=True)))
    monkeypatch.setattr(admin, "FIRST_KICKOFF_SQL", text("SELECT '2099-10-29 20:00:00+00'::timestamptz, true"))
    # Oct 29 is Thursday; Nov 5 is after the Pacific DST transition.
    monkeypatch.setattr(admin, "FUTURE_WEEK_KICKOFFS_SQL", text("""
        SELECT * FROM (VALUES
            (7, '2099-11-05 20:00:00+00'::timestamptz, true),
            (8, '2099-11-12 20:00:00+00'::timestamptz, true)
        ) AS schedule(week, kickoff, scheduled)
    """))
    yield tid
    db_conn.rollback()
    with db_conn.cursor() as cur:
        cur.execute("DELETE FROM tenant_weeks WHERE tenant_id = %s", (tid,))
        for week, lock in original:
            cur.execute("INSERT INTO tenant_weeks VALUES (%s, %s, %s)", (tid, week, lock))
    db_conn.commit()


def _snapshot(db_conn):
    with db_conn.cursor() as cur:
        cur.execute("SELECT tenant_id, week_number, lock_at FROM tenant_weeks ORDER BY tenant_id, week_number")
        locks = cur.fetchall()
        cur.execute("SELECT week_number, default_lock_at FROM weeks ORDER BY week_number")
        defaults = cur.fetchall()
    return locks, defaults


@pytest.mark.parametrize("bulk", [False, True])
@pytest.mark.parametrize("day", [28, 29])
def test_lock_update_is_opt_in_and_isolated(client, comm_headers, db_conn, lock_schedule, bulk, day):
    tid = lock_schedule
    before, defaults = _snapshot(db_conn)
    payload: dict[str, object] = {"lock_at": f"2099-10-{day}T06:59:00Z"}  # Tuesday/Wednesday 11:59 PM PDT
    if bulk:
        payload["apply_to_future_weeks"] = True
    # A supplied tenant ID must never control the mutation scope.
    payload["tenant_id"] = 1
    resp = client.patch("/admin/weeks/6/lock", json=payload, headers=comm_headers)
    assert resp.status_code == (200 if bulk else 204), resp.text
    after, after_defaults = _snapshot(db_conn)
    assert after_defaults == defaults
    assert [r for r in after if r[0] != tid] == [r for r in before if r[0] != tid]
    own = {week: lock for tenant, week, lock in after if tenant == tid}
    assert [r for r in after if r[0] == tid and r[1] < 6] == [r for r in before if r[0] == tid and r[1] < 6]
    assert own[6] == datetime(2099, 10, day, 6, 59, tzinfo=UTC)
    if bulk:
        assert own[7] == datetime(2099, 11, day - 24, 7, 59, tzinfo=UTC)
        assert own[8] == datetime(2099, 11, day - 17, 7, 59, tzinfo=UTC)
    else:
        assert [(w, lock) for tenant, w, lock in after if tenant == tid and w != 6] == [
            (w, lock) for tenant, w, lock in before if tenant == tid and w != 6
        ]


@pytest.mark.parametrize("future_sql", ["SELECT 7, NULL::timestamptz, NULL::boolean"])
def test_bulk_invalid_later_week_changes_nothing(client, comm_headers, db_conn, lock_schedule, monkeypatch, future_sql):
    monkeypatch.setattr(admin, "FUTURE_WEEK_KICKOFFS_SQL", text(future_sql))
    before = _snapshot(db_conn)
    resp = client.patch("/admin/weeks/6/lock", json={
        "lock_at": "2099-10-29T06:59:00Z", "apply_to_future_weeks": True,
    }, headers=comm_headers)
    assert resp.status_code == 400, resp.text
    assert _snapshot(db_conn) == before


def test_bulk_skips_started_later_weeks(client, comm_headers, db_conn, lock_schedule, monkeypatch):
    monkeypatch.setattr(admin, "FUTURE_WEEK_KICKOFFS_SQL", text("SELECT 7, '2099-11-05 20:00:00+00'::timestamptz, false"))
    before, _ = _snapshot(db_conn)
    resp = client.patch("/admin/weeks/6/lock", json={
        "lock_at": "2099-10-29T06:59:00Z", "apply_to_future_weeks": True,
    }, headers=comm_headers)
    assert resp.status_code == 200, resp.text
    assert resp.json()["skipped_weeks"][0]["reason"] == "started"
    after, _ = _snapshot(db_conn)
    assert [r for r in after if r[0] == lock_schedule and r[1] != 6] == [
        r for r in before if r[0] == lock_schedule and r[1] != 6
    ]


def test_bulk_requires_commissioner(client, member_headers, lock_schedule):
    resp = client.patch("/admin/weeks/6/lock", json={
        "lock_at": "2099-10-29T06:59:00Z", "apply_to_future_weeks": True,
    }, headers=member_headers)
    assert resp.status_code == 403


@pytest.mark.parametrize("kickoff_sql, lock_at", [
    ("SELECT '2099-10-29 20:00:00+00'::timestamptz, false", "2099-10-29T06:59:00Z"),
    ("SELECT '2020-10-29 20:00:00+00'::timestamptz, true", "2020-10-29T06:59:00Z"),
    ("SELECT '2099-10-29 20:00:00+00'::timestamptz, true", "2099-10-26T06:59:00Z"),
])
def test_bulk_rejects_invalid_start_without_writes(client, comm_headers, db_conn, lock_schedule, monkeypatch, kickoff_sql, lock_at):
    monkeypatch.setattr(admin, "FIRST_KICKOFF_SQL", text(kickoff_sql))
    before = _snapshot(db_conn)
    resp = client.patch("/admin/weeks/6/lock", json={
        "lock_at": lock_at, "apply_to_future_weeks": True,
    }, headers=comm_headers)
    assert resp.status_code == 400, resp.text
    assert _snapshot(db_conn) == before


@pytest.mark.parametrize("selected_conflicts", [False, True])
def test_bulk_keeps_early_kickoff_deadlines_and_reports_exceptions(
    client, comm_headers, db_conn, lock_schedule, monkeypatch, selected_conflicts
):
    if selected_conflicts:
        # Wednesday at 5 PM before the requested Wednesday 11:59 PM deadline.
        monkeypatch.setattr(admin, "FIRST_KICKOFF_SQL", text("SELECT '2099-10-29 00:00:00+00'::timestamptz, true"))
    monkeypatch.setattr(admin, "FUTURE_WEEK_KICKOFFS_SQL", text("""
        SELECT * FROM (VALUES
            (7, '2099-11-05 01:00:00+00'::timestamptz, true),
            (8, '2099-11-12 20:00:00+00'::timestamptz, true)
        ) AS schedule(week, kickoff, scheduled)
    """))
    before, defaults = _snapshot(db_conn)
    resp = client.patch("/admin/weeks/6/lock", json={
        "lock_at": "2099-10-29T06:59:00Z", "apply_to_future_weeks": True,
    }, headers=comm_headers)
    assert resp.status_code == 200, resp.text
    result = resp.json()
    skipped_weeks = {6, 7} if selected_conflicts else {7}
    assert {row["week_number"] for row in result["skipped_weeks"]} == skipped_weeks
    assert result["updated_weeks"] == ([8] if selected_conflicts else [6, 8])
    after, after_defaults = _snapshot(db_conn)
    assert after_defaults == defaults
    assert [r for r in after if r[0] != lock_schedule] == [r for r in before if r[0] != lock_schedule]
    previous = {w: lock for tenant, w, lock in before if tenant == lock_schedule}
    current = {w: lock for tenant, w, lock in after if tenant == lock_schedule}
    for exception in result["skipped_weeks"]:
        week = exception["week_number"]
        assert current[week] == previous[week]
        assert datetime.fromisoformat(exception["lock_at"]) == previous[week]
        assert exception["reason"] == "after_kickoff"
        assert exception["first_kickoff"]
