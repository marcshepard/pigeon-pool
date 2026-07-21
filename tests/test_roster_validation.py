"""Focused tests for the shared read-only roster validator."""

import json

import pytest

from backend.cli import build_parser
from backend.utils.roster_validation import validate_rosters


_TENANT_NAME = "_Roster Validation Test"
_OTHER_TENANT_NAME = "_Roster Validation Other"
_EMAILS = (
    "roster-validator-commissioner@example.com",
    "roster-validator-member@example.com",
    "roster-validator-orphan@example.com",
)


@pytest.fixture
def valid_roster(db_conn):
    """Create one small, valid tenant and remove it after each test."""
    db_conn.rollback()
    with db_conn.cursor() as cur:
        cur.execute("DELETE FROM tenants WHERE name IN (%s, %s)", (_TENANT_NAME, _OTHER_TENANT_NAME))
        cur.execute("DELETE FROM users WHERE email = ANY(%s)", (list(_EMAILS),))
    db_conn.commit()

    with db_conn.cursor() as cur:
        cur.execute("INSERT INTO tenants (name) VALUES (%s) RETURNING tenant_id", (_TENANT_NAME,))
        tenant_id = cur.fetchone()[0]

        cur.execute(
            """
            INSERT INTO players (tenant_id, pigeon_number, pigeon_name)
            VALUES (%s, 1, '_Validator One')
            RETURNING player_id
            """,
            (tenant_id,),
        )
        first_player_id = cur.fetchone()[0]
        cur.execute(
            """
            INSERT INTO players (tenant_id, pigeon_number, pigeon_name)
            VALUES (%s, 2, '_Validator Two')
            RETURNING player_id
            """,
            (tenant_id,),
        )
        second_player_id = cur.fetchone()[0]

        cur.execute(
            """
            INSERT INTO users (email, password_hash)
            VALUES (%s, 'x')
            RETURNING user_id
            """,
            (_EMAILS[0],),
        )
        commissioner_user_id = cur.fetchone()[0]
        cur.execute(
            """
            INSERT INTO users (email, password_hash)
            VALUES (%s, 'x')
            RETURNING user_id
            """,
            (_EMAILS[1],),
        )
        member_user_id = cur.fetchone()[0]

        cur.execute(
            "INSERT INTO user_players (user_id, player_id, role) VALUES (%s, %s, 'owner')",
            (commissioner_user_id, first_player_id),
        )
        cur.execute(
            "INSERT INTO user_players (user_id, player_id, role) VALUES (%s, %s, 'owner')",
            (member_user_id, second_player_id),
        )
        cur.execute(
            """
            INSERT INTO tenant_members (tenant_id, user_id, role, primary_player_id)
            VALUES (%s, %s, 'commissioner', %s)
            """,
            (tenant_id, commissioner_user_id, first_player_id),
        )
        cur.execute(
            """
            INSERT INTO tenant_members (tenant_id, user_id, role, primary_player_id)
            VALUES (%s, %s, 'member', %s)
            """,
            (tenant_id, member_user_id, second_player_id),
        )
    db_conn.commit()

    data = {
        "tenant_id": tenant_id,
        "first_player_id": first_player_id,
        "second_player_id": second_player_id,
        "commissioner_user_id": commissioner_user_id,
        "member_user_id": member_user_id,
    }
    yield data

    db_conn.rollback()
    with db_conn.cursor() as cur:
        cur.execute("DELETE FROM tenants WHERE name IN (%s, %s)", (_TENANT_NAME, _OTHER_TENANT_NAME))
        cur.execute("DELETE FROM users WHERE email = ANY(%s)", (list(_EMAILS),))
    db_conn.commit()


def test_valid_roster_passes_and_serializes(db_conn, valid_roster):
    report = validate_rosters(db_conn, tenant_id=valid_roster["tenant_id"])

    assert report.is_valid
    assert report.errors == []
    assert len(report.tenants) == 1
    assert report.tenants[0].pigeon_count == 2
    assert report.tenants[0].member_count == 2
    assert report.tenants[0].commissioner_count == 1
    assert json.loads(json.dumps(report.to_dict()))["ok"] is True


def test_ownerless_primary_is_reported(db_conn, valid_roster):
    with db_conn.cursor() as cur:
        cur.execute(
            "DELETE FROM user_players WHERE user_id = %s AND player_id = %s",
            (valid_roster["member_user_id"], valid_roster["second_player_id"]),
        )
    db_conn.commit()

    report = validate_rosters(db_conn, tenant_id=valid_roster["tenant_id"])
    codes = {issue.code for issue in report.errors}

    assert not report.is_valid
    assert "invalid_owner_count" in codes
    assert "primary_not_managed" in codes
    assert "member_without_managed_pigeon" in codes


def test_cross_tenant_primary_is_reported(db_conn, valid_roster):
    with db_conn.cursor() as cur:
        cur.execute("INSERT INTO tenants (name) VALUES (%s) RETURNING tenant_id", (_OTHER_TENANT_NAME,))
        other_tenant_id = cur.fetchone()[0]
        cur.execute(
            """
            INSERT INTO players (tenant_id, pigeon_number, pigeon_name)
            VALUES (%s, 1, '_Validator Other')
            RETURNING player_id
            """,
            (other_tenant_id,),
        )
        other_player_id = cur.fetchone()[0]
        cur.execute(
            """
            UPDATE tenant_members
               SET primary_player_id = %s
             WHERE tenant_id = %s AND user_id = %s
            """,
            (
                other_player_id,
                valid_roster["tenant_id"],
                valid_roster["member_user_id"],
            ),
        )
    db_conn.commit()

    report = validate_rosters(db_conn, tenant_id=valid_roster["tenant_id"])

    assert "primary_wrong_tenant" in {issue.code for issue in report.errors}


def test_assignment_without_membership_is_reported(db_conn, valid_roster):
    with db_conn.cursor() as cur:
        cur.execute(
            "INSERT INTO users (email, password_hash) VALUES (%s, 'x') RETURNING user_id",
            (_EMAILS[2],),
        )
        user_id = cur.fetchone()[0]
        cur.execute(
            "INSERT INTO user_players (user_id, player_id, role) VALUES (%s, %s, 'manager')",
            (user_id, valid_roster["second_player_id"]),
        )
    db_conn.commit()

    report = validate_rosters(db_conn, tenant_id=valid_roster["tenant_id"])

    assert "assignment_without_membership" in {issue.code for issue in report.errors}


def test_orphaned_global_user_is_warning_only(db_conn, valid_roster):
    with db_conn.cursor() as cur:
        cur.execute(
            "INSERT INTO users (email, password_hash) VALUES (%s, 'x')",
            (_EMAILS[2],),
        )
    db_conn.commit()

    report = validate_rosters(db_conn, tenant_id=valid_roster["tenant_id"])

    assert report.is_valid
    assert any(issue.details.get("email") == _EMAILS[2] for issue in report.orphaned_users)


def test_validate_rosters_cli_arguments():
    args = build_parser().parse_args(["validate-rosters", "--tenant", "7", "--json"])

    assert args.tenant_id == 7
    assert args.as_json is True
