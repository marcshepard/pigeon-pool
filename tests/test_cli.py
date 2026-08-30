"""Tests for backend CLI commands that change tenant setup state."""

import argparse
import json

from backend.cli import cmd_create_league, cmd_import_tenant_picks


def test_create_league_creates_missing_commissioner_user(db_conn):
    """A fresh commissioner email can bootstrap a league without direct SQL."""
    email = "_cli_new_commissioner@example.com"
    league_name = "_CLI Bootstrap League"

    db_conn.rollback()
    with db_conn.cursor() as cur:
        cur.execute("DELETE FROM tenants WHERE name = %s", (league_name,))
        cur.execute("DELETE FROM users WHERE email = %s", (email,))
    db_conn.commit()

    try:
        result = cmd_create_league(argparse.Namespace(name=league_name, commissioner_email=email))

        assert result == 0
        with db_conn.cursor() as cur:
            cur.execute("""
                SELECT tm.role, p.pigeon_name, u.password_hash
                  FROM tenant_members tm
                  JOIN tenants t ON t.tenant_id = tm.tenant_id
                  JOIN users u ON u.user_id = tm.user_id
                  JOIN players p ON p.player_id = tm.primary_player_id
                 WHERE t.name = %s AND lower(u.email) = %s
            """, (league_name, email))
            row = cur.fetchone()

        assert row is not None
        assert row[0] == "commissioner"
        assert row[1] == "Commissioner"
        assert row[2].startswith("$2")
    finally:
        db_conn.rollback()
        with db_conn.cursor() as cur:
            cur.execute("DELETE FROM tenants WHERE name = %s", (league_name,))
            cur.execute("DELETE FROM users WHERE email = %s", (email,))
        db_conn.commit()


def test_import_snapshot_renumbers_pigeon_matched_by_name(db_conn, monkeypatch, tmp_path):
    """A production pigeon number replaces a different local display number by name match."""
    league_name = "_CLI Snapshot Import League"
    db_conn.rollback()
    with db_conn.cursor() as cur:
        cur.execute("DELETE FROM tenants WHERE name = %s", (league_name,))
        cur.execute("INSERT INTO tenants (name) VALUES (%s) RETURNING tenant_id", (league_name,))
        tenant_id = cur.fetchone()[0]
        cur.execute("""
            INSERT INTO players (tenant_id, pigeon_number, pigeon_name, season_status)
            VALUES (%s, 1, 'SeaWorthy', 'pending')
        """, (tenant_id,))
    db_conn.commit()

    snapshot_path = tmp_path / "tenant-snapshot.json"
    snapshot_path.write_text(json.dumps({
        "format_version": 1,
        "source_tenant": {"tenant_id": 1, "name": "Production Pigeon Pool"},
        "players": [
            {
                "pigeon_number": 1,
                "pigeon_name": "Production Number One",
                "season_status": "active",
                "commissioner_notes": "",
            },
            {
                "pigeon_number": 57,
                "pigeon_name": "SeaWorthy",
                "season_status": "active",
                "commissioner_notes": "",
            },
        ],
        "picks": [],
    }), encoding="utf-8")
    monkeypatch.setattr("builtins.input", lambda _: "yes")

    try:
        result = cmd_import_tenant_picks(argparse.Namespace(
            tenant_id=tenant_id, input=str(snapshot_path), week=None,
        ))

        assert result == 0
        with db_conn.cursor() as cur:
            cur.execute("""
                SELECT pigeon_number, pigeon_name, season_status
                  FROM players
                 WHERE tenant_id = %s
                 ORDER BY pigeon_number
            """, (tenant_id,))
            players = cur.fetchall()
        assert players == [
            (1, "Production Number One", "active"),
            (57, "SeaWorthy", "active"),
        ]
    finally:
        db_conn.rollback()
        with db_conn.cursor() as cur:
            cur.execute("DELETE FROM tenants WHERE name = %s", (league_name,))
        db_conn.commit()
