"""Tests for the read-only pre-Alembic schema verifier."""

import json

from backend.cli import build_parser
from backend.utils.schema_baseline import (
    ColumnSpec,
    SchemaBaselineIssue,
    SchemaBaselineReport,
    _collect_constraints,
    verify_schema_baseline,
)


class _ConstraintCursor:
    def execute(self, _query):
        return None

    def fetchall(self):
        return [
            ("teams", "n", "NOT NULL abbr"),
            ("teams", "p", "PRIMARY KEY (abbr)"),
        ]


def test_current_database_matches_schema_baseline(db_conn):
    db_conn.rollback()

    report = verify_schema_baseline(db_conn)

    assert report.is_valid, report.to_dict()


def test_schema_baseline_detects_extra_column(db_conn):
    """Transactional DDL proves drift is reported without leaving schema changes."""

    db_conn.rollback()
    try:
        with db_conn.cursor() as cur:
            cur.execute("ALTER TABLE teams ADD COLUMN _baseline_drift_probe TEXT")

        report = verify_schema_baseline(db_conn)

        assert not report.is_valid
        assert any(
            issue.object_type == "table columns"
            and issue.object_name == "teams"
            and issue.problem == "definition differs"
            for issue in report.issues
        )
    finally:
        db_conn.rollback()


def test_verify_schema_baseline_parser_supports_json():
    args = build_parser().parse_args(["verify-schema-baseline", "--json"])

    assert args.command == "verify-schema-baseline"
    assert args.as_json is True


def test_failing_schema_report_is_json_serializable():
    report = SchemaBaselineReport(
        schema_name="public",
        issues=[
            SchemaBaselineIssue(
                object_type="table columns",
                object_name="users",
                problem="definition differs",
                expected={"email": ColumnSpec("text", False)},
                actual={"email", "password_hash"},
            )
        ],
        reset_table_present=False,
        alembic_table_present=False,
    )

    encoded = json.dumps(report.to_dict())

    assert '"email"' in encoded
    assert '"password_hash"' in encoded


def test_postgresql_not_null_constraints_are_not_double_counted():
    constraints = _collect_constraints(_ConstraintCursor())

    assert constraints == {"teams": {"primary key(abbr)"}}

