"""Read-only validation for tenant roster integrity.

The validator is shared by the CLI and integration tests.  It deliberately
contains no repair behavior: several invalid states require a commissioner or
operator to choose the correct owner, assignment, or primary pigeon.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

from backend.utils.validation import validate_pigeon_name


Severity = Literal["error", "warning"]


_REQUIRED_COLUMNS: dict[str, set[str]] = {
    "tenants": {"tenant_id", "name", "pigeons_can_rename"},
    "users": {"user_id", "email", "password_hash"},
    "players": {
        "player_id",
        "tenant_id",
        "pigeon_number",
        "pigeon_name",
        "season_status",
    },
    "user_players": {"user_id", "player_id", "role"},
    "tenant_members": {
        "tenant_id",
        "user_id",
        "role",
        "primary_player_id",
        "last_used_at",
    },
    "tenant_payouts": {"tenant_id", "place", "points"},
}

_CORE_ROSTER_COLUMNS: dict[str, set[str]] = {
    "tenants": {"tenant_id", "name"},
    "users": {"user_id", "email"},
    "players": {"player_id", "tenant_id", "pigeon_number", "pigeon_name"},
    "user_players": {"user_id", "player_id", "role"},
    "tenant_members": {"tenant_id", "user_id", "role", "primary_player_id"},
}


@dataclass(frozen=True)
class RosterValidationIssue:
    """One actionable integrity error or informational warning."""

    severity: Severity
    code: str
    message: str
    tenant_id: int | None = None
    tenant_name: str | None = None
    details: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        result: dict[str, Any] = {
            "severity": self.severity,
            "code": self.code,
            "message": self.message,
        }
        if self.tenant_id is not None:
            result["tenant_id"] = self.tenant_id
        if self.tenant_name is not None:
            result["tenant_name"] = self.tenant_name
        if self.details:
            result["details"] = self.details
        return result


@dataclass(frozen=True)
class TenantRosterSummary:
    """Compact per-tenant counts for human and JSON output."""

    tenant_id: int
    tenant_name: str
    pigeon_count: int
    member_count: int
    commissioner_count: int
    error_count: int
    warning_count: int

    @property
    def result(self) -> str:
        if self.error_count:
            return "FAIL"
        if self.warning_count:
            return "PASS_WITH_WARNINGS"
        return "PASS"

    def to_dict(self) -> dict[str, Any]:
        return {
            "tenant_id": self.tenant_id,
            "tenant_name": self.tenant_name,
            "pigeon_count": self.pigeon_count,
            "member_count": self.member_count,
            "commissioner_count": self.commissioner_count,
            "error_count": self.error_count,
            "warning_count": self.warning_count,
            "result": self.result,
        }


@dataclass(frozen=True)
class RosterValidationReport:
    """Complete validation result."""

    tenant_filter: int | None
    tenants: list[TenantRosterSummary]
    issues: list[RosterValidationIssue]

    @property
    def errors(self) -> list[RosterValidationIssue]:
        return [issue for issue in self.issues if issue.severity == "error"]

    @property
    def warnings(self) -> list[RosterValidationIssue]:
        return [issue for issue in self.issues if issue.severity == "warning"]

    @property
    def is_valid(self) -> bool:
        return not self.errors

    @property
    def orphaned_users(self) -> list[RosterValidationIssue]:
        return [issue for issue in self.warnings if issue.code == "orphaned_global_user"]

    def to_dict(self) -> dict[str, Any]:
        return {
            "ok": self.is_valid,
            "tenant_filter": self.tenant_filter,
            "summary": {
                "tenant_count": len(self.tenants),
                "error_count": len(self.errors),
                "warning_count": len(self.warnings),
                "orphaned_global_user_count": len(self.orphaned_users),
            },
            "tenants": [tenant.to_dict() for tenant in self.tenants],
            "errors": [issue.to_dict() for issue in self.errors],
            "warnings": [issue.to_dict() for issue in self.warnings],
        }


@dataclass
class _TenantCounts:
    name: str
    pigeons: int
    members: int
    commissioners: int


def _schema_columns(conn: Any) -> dict[str, set[str]]:
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT table_name, column_name
              FROM information_schema.columns
             WHERE table_schema = current_schema()
               AND table_name = ANY(%s)
            """,
            (list(_REQUIRED_COLUMNS),),
        )
        rows = cur.fetchall()

    columns: dict[str, set[str]] = {}
    for table_name, column_name in rows:
        columns.setdefault(table_name, set()).add(column_name)
    return columns


def _schema_issues(actual: dict[str, set[str]]) -> list[RosterValidationIssue]:
    issues: list[RosterValidationIssue] = []
    for table_name, required in _REQUIRED_COLUMNS.items():
        if table_name not in actual:
            issues.append(
                RosterValidationIssue(
                    severity="error",
                    code="missing_schema_table",
                    message=f"Required table '{table_name}' is missing.",
                    details={"table": table_name},
                )
            )
            continue
        for column_name in sorted(required - actual[table_name]):
            issues.append(
                RosterValidationIssue(
                    severity="error",
                    code="missing_schema_column",
                    message=f"Required column '{table_name}.{column_name}' is missing.",
                    details={"table": table_name, "column": column_name},
                )
            )
    return issues


def _has_core_roster_schema(actual: dict[str, set[str]]) -> bool:
    return all(required <= actual.get(table_name, set()) for table_name, required in _CORE_ROSTER_COLUMNS.items())


def validate_rosters(conn: Any, tenant_id: int | None = None) -> RosterValidationReport:
    """Validate roster invariants without modifying the database.

    ``tenant_id`` limits tenant-scoped checks, while orphaned global users are
    always reported because they are not owned by a particular tenant.  Missing
    runtime schema objects are reported as errors instead of raising an opaque
    SQL exception.
    """

    actual_schema = _schema_columns(conn)
    issues = _schema_issues(actual_schema)
    if not _has_core_roster_schema(actual_schema):
        return RosterValidationReport(tenant_filter=tenant_id, tenants=[], issues=issues)

    tenant_clause = "WHERE t.tenant_id = %s" if tenant_id is not None else ""
    params: tuple[Any, ...] = (tenant_id,) if tenant_id is not None else ()

    with conn.cursor() as cur:
        cur.execute(
            f"""
            SELECT t.tenant_id,
                   t.name,
                   COUNT(DISTINCT p.player_id) AS pigeon_count,
                   COUNT(DISTINCT tm.user_id) AS member_count,
                   COUNT(DISTINCT tm.user_id) FILTER (WHERE tm.role = 'commissioner') AS commissioner_count
              FROM tenants t
              LEFT JOIN players p ON p.tenant_id = t.tenant_id
              LEFT JOIN tenant_members tm ON tm.tenant_id = t.tenant_id
              {tenant_clause}
             GROUP BY t.tenant_id, t.name
             ORDER BY t.tenant_id
            """,
            params,
        )
        tenant_rows = cur.fetchall()

    tenant_counts = {
        int(row[0]): _TenantCounts(
            name=str(row[1]),
            pigeons=int(row[2]),
            members=int(row[3]),
            commissioners=int(row[4]),
        )
        for row in tenant_rows
    }

    if tenant_id is not None and tenant_id not in tenant_counts:
        issues.append(
            RosterValidationIssue(
                severity="error",
                code="tenant_not_found",
                message=f"Tenant {tenant_id} does not exist.",
                tenant_id=tenant_id,
            )
        )

    def add_error(
        code: str,
        message: str,
        issue_tenant_id: int | None,
        **details: Any,
    ) -> None:
        counts = tenant_counts.get(issue_tenant_id) if issue_tenant_id is not None else None
        issues.append(
            RosterValidationIssue(
                severity="error",
                code=code,
                message=message,
                tenant_id=issue_tenant_id,
                tenant_name=counts.name if counts else None,
                details=details,
            )
        )

    scoped_tenant_ids = list(tenant_counts)
    if scoped_tenant_ids:
        with conn.cursor() as cur:
            # Exactly one owner per pigeon.  The partial unique index normally
            # prevents multiple owners, but this also detects schema drift.
            cur.execute(
                """
                SELECT p.tenant_id, p.player_id, p.pigeon_number, p.pigeon_name,
                       COUNT(up.user_id) FILTER (WHERE up.role = 'owner') AS owner_count
                  FROM players p
                  LEFT JOIN user_players up ON up.player_id = p.player_id
                 WHERE p.tenant_id = ANY(%s)
                 GROUP BY p.tenant_id, p.player_id, p.pigeon_number, p.pigeon_name
                HAVING COUNT(up.user_id) FILTER (WHERE up.role = 'owner') <> 1
                 ORDER BY p.tenant_id, p.pigeon_number
                """,
                (scoped_tenant_ids,),
            )
            for tid, player_id_value, pigeon_number, pigeon_name, owner_count in cur.fetchall():
                add_error(
                    "invalid_owner_count",
                    f"Pigeon #{pigeon_number} '{pigeon_name}' has {owner_count} owners; exactly one is required.",
                    int(tid),
                    player_id=int(player_id_value),
                    pigeon_number=int(pigeon_number),
                    owner_count=int(owner_count),
                )

            # A primary must belong to the membership's tenant.
            cur.execute(
                """
                SELECT tm.tenant_id, tm.user_id, u.email, tm.primary_player_id,
                       p.tenant_id AS player_tenant_id
                  FROM tenant_members tm
                  JOIN users u ON u.user_id = tm.user_id
                  LEFT JOIN players p ON p.player_id = tm.primary_player_id
                 WHERE tm.tenant_id = ANY(%s)
                   AND (p.player_id IS NULL OR p.tenant_id <> tm.tenant_id)
                 ORDER BY tm.tenant_id, lower(u.email)
                """,
                (scoped_tenant_ids,),
            )
            for tid, user_id_value, email, primary_player_id, player_tenant_id in cur.fetchall():
                add_error(
                    "primary_wrong_tenant",
                    f"{email} has a primary pigeon outside this tenant.",
                    int(tid),
                    user_id=int(user_id_value),
                    email=str(email),
                    primary_player_id=int(primary_player_id),
                    primary_player_tenant_id=int(player_tenant_id) if player_tenant_id is not None else None,
                )

            # A primary must be an owner/manager assignment for that user.
            cur.execute(
                """
                SELECT tm.tenant_id, tm.user_id, u.email, tm.primary_player_id
                  FROM tenant_members tm
                  JOIN users u ON u.user_id = tm.user_id
                 WHERE tm.tenant_id = ANY(%s)
                   AND NOT EXISTS (
                       SELECT 1
                         FROM user_players up
                        WHERE up.user_id = tm.user_id
                          AND up.player_id = tm.primary_player_id
                          AND up.role IN ('owner', 'manager')
                   )
                 ORDER BY tm.tenant_id, lower(u.email)
                """,
                (scoped_tenant_ids,),
            )
            for tid, user_id_value, email, primary_player_id in cur.fetchall():
                add_error(
                    "primary_not_managed",
                    f"{email} does not own or manage their primary pigeon.",
                    int(tid),
                    user_id=int(user_id_value),
                    email=str(email),
                    primary_player_id=int(primary_player_id),
                )

            # Current membership requires at least one usable pigeon.
            cur.execute(
                """
                SELECT tm.tenant_id, tm.user_id, u.email, tm.role
                  FROM tenant_members tm
                  JOIN users u ON u.user_id = tm.user_id
                 WHERE tm.tenant_id = ANY(%s)
                   AND NOT EXISTS (
                       SELECT 1
                         FROM user_players up
                         JOIN players p ON p.player_id = up.player_id
                        WHERE up.user_id = tm.user_id
                          AND p.tenant_id = tm.tenant_id
                          AND up.role IN ('owner', 'manager')
                   )
                 ORDER BY tm.tenant_id, lower(u.email)
                """,
                (scoped_tenant_ids,),
            )
            for tid, user_id_value, email, membership_role in cur.fetchall():
                add_error(
                    "member_without_managed_pigeon",
                    f"{email} belongs to the tenant but owns or manages no pigeon there.",
                    int(tid),
                    user_id=int(user_id_value),
                    email=str(email),
                    membership_role=str(membership_role),
                )

            # Every assignment, including a viewer assignment, requires tenant membership.
            cur.execute(
                """
                SELECT p.tenant_id, up.user_id, u.email, up.player_id, up.role
                  FROM user_players up
                  JOIN users u ON u.user_id = up.user_id
                  JOIN players p ON p.player_id = up.player_id
                  LEFT JOIN tenant_members tm
                    ON tm.tenant_id = p.tenant_id
                   AND tm.user_id = up.user_id
                 WHERE p.tenant_id = ANY(%s)
                   AND tm.user_id IS NULL
                 ORDER BY p.tenant_id, lower(u.email), up.player_id
                """,
                (scoped_tenant_ids,),
            )
            for tid, user_id_value, email, player_id_value, assignment_role in cur.fetchall():
                add_error(
                    "assignment_without_membership",
                    f"{email} has a pigeon assignment without membership in the pigeon's tenant.",
                    int(tid),
                    user_id=int(user_id_value),
                    email=str(email),
                    player_id=int(player_id_value),
                    assignment_role=str(assignment_role),
                )

            # Role checks remain useful if a deployed database is missing the
            # canonical CHECK constraints.
            cur.execute(
                """
                SELECT tm.tenant_id, tm.user_id, u.email, tm.role
                  FROM tenant_members tm
                  JOIN users u ON u.user_id = tm.user_id
                 WHERE tm.tenant_id = ANY(%s)
                   AND tm.role NOT IN ('commissioner', 'member')
                 ORDER BY tm.tenant_id, lower(u.email)
                """,
                (scoped_tenant_ids,),
            )
            for tid, user_id_value, email, role in cur.fetchall():
                add_error(
                    "invalid_membership_role",
                    f"{email} has unexpected tenant membership role '{role}'.",
                    int(tid),
                    user_id=int(user_id_value),
                    email=str(email),
                    role=str(role),
                )

            cur.execute(
                """
                SELECT p.tenant_id, up.user_id, u.email, up.player_id, up.role
                  FROM user_players up
                  JOIN users u ON u.user_id = up.user_id
                  JOIN players p ON p.player_id = up.player_id
                 WHERE p.tenant_id = ANY(%s)
                   AND up.role NOT IN ('owner', 'manager', 'viewer')
                 ORDER BY p.tenant_id, lower(u.email), up.player_id
                """,
                (scoped_tenant_ids,),
            )
            for tid, user_id_value, email, player_id_value, role in cur.fetchall():
                add_error(
                    "invalid_assignment_role",
                    f"{email} has unexpected pigeon assignment role '{role}'.",
                    int(tid),
                    user_id=int(user_id_value),
                    email=str(email),
                    player_id=int(player_id_value),
                    role=str(role),
                )

            # Validate player fields even if a deployed database lacks its
            # canonical CHECK/UNIQUE constraints.
            has_season_status = "season_status" in actual_schema.get("players", set())
            status_column = ", season_status" if has_season_status else ""
            cur.execute(
                f"""
                SELECT tenant_id, player_id, pigeon_number, pigeon_name{status_column}
                  FROM players
                 WHERE tenant_id = ANY(%s)
                 ORDER BY tenant_id, pigeon_number, player_id
                """,
                (scoped_tenant_ids,),
            )
            for row in cur.fetchall():
                tid, player_id_value, pigeon_number, pigeon_name = row[:4]
                if int(pigeon_number) < 1:
                    add_error(
                        "invalid_pigeon_number",
                        f"Pigeon '{pigeon_name}' has non-positive number {pigeon_number}.",
                        int(tid),
                        player_id=int(player_id_value),
                        pigeon_number=int(pigeon_number),
                    )
                try:
                    validate_pigeon_name(str(pigeon_name))
                except ValueError as exc:
                    add_error(
                        "invalid_pigeon_name",
                        f"Pigeon #{pigeon_number} has an invalid name: {exc}.",
                        int(tid),
                        player_id=int(player_id_value),
                        pigeon_number=int(pigeon_number),
                        pigeon_name=str(pigeon_name),
                    )
                if has_season_status and row[4] not in ("pending", "active", "out"):
                    add_error(
                        "invalid_season_status",
                        f"Pigeon #{pigeon_number} has invalid season status '{row[4]}'.",
                        int(tid),
                        player_id=int(player_id_value),
                        pigeon_number=int(pigeon_number),
                        season_status=str(row[4]),
                    )

            for column_name, issue_code, label in (
                ("pigeon_number", "duplicate_pigeon_number", "number"),
                ("pigeon_name", "duplicate_pigeon_name", "name"),
            ):
                cur.execute(
                    f"""
                    SELECT tenant_id, {column_name}, COUNT(*), array_agg(player_id ORDER BY player_id)
                      FROM players
                     WHERE tenant_id = ANY(%s)
                     GROUP BY tenant_id, {column_name}
                    HAVING COUNT(*) > 1
                     ORDER BY tenant_id, {column_name}
                    """,
                    (scoped_tenant_ids,),
                )
                for tid, value, count, player_ids in cur.fetchall():
                    add_error(
                        issue_code,
                        f"Pigeon {label} '{value}' is used by {count} pigeons in this tenant.",
                        int(tid),
                        value=value,
                        player_ids=[int(player_id_value) for player_id_value in player_ids],
                    )

        for tid, counts in tenant_counts.items():
            if counts.commissioners == 0:
                add_error(
                    "tenant_without_commissioner",
                    "Tenant has no commissioner.",
                    tid,
                )

    # Orphaned accounts are intentionally informational and global.  They are
    # never deleted or treated as a failed roster validation.
    if {"users", "tenant_members", "user_players"} <= actual_schema.keys():
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT u.user_id, u.email
                  FROM users u
                 WHERE NOT EXISTS (
                           SELECT 1 FROM tenant_members tm WHERE tm.user_id = u.user_id
                       )
                   AND NOT EXISTS (
                           SELECT 1 FROM user_players up WHERE up.user_id = u.user_id
                       )
                 ORDER BY lower(u.email), u.user_id
                """
            )
            for user_id_value, email in cur.fetchall():
                issues.append(
                    RosterValidationIssue(
                        severity="warning",
                        code="orphaned_global_user",
                        message=f"Global user {email} has no tenant membership or pigeon assignment.",
                        details={"user_id": int(user_id_value), "email": str(email)},
                    )
                )

    issues.sort(
        key=lambda issue: (
            0 if issue.severity == "error" else 1,
            issue.tenant_id if issue.tenant_id is not None else -1,
            issue.code,
            issue.message.lower(),
        )
    )

    summaries: list[TenantRosterSummary] = []
    for tid, counts in tenant_counts.items():
        tenant_issues = [issue for issue in issues if issue.tenant_id == tid]
        summaries.append(
            TenantRosterSummary(
                tenant_id=tid,
                tenant_name=counts.name,
                pigeon_count=counts.pigeons,
                member_count=counts.members,
                commissioner_count=counts.commissioners,
                error_count=sum(issue.severity == "error" for issue in tenant_issues),
                warning_count=sum(issue.severity == "warning" for issue in tenant_issues),
            )
        )

    return RosterValidationReport(tenant_filter=tenant_id, tenants=summaries, issues=issues)


def format_roster_validation_report(report: RosterValidationReport) -> str:
    """Render a concise human-readable validation report."""

    lines: list[str] = []
    if report.tenants:
        for tenant in report.tenants:
            lines.extend(
                [
                    f"League: {tenant.tenant_name} (tenant_id={tenant.tenant_id})",
                    f"  Pigeons: {tenant.pigeon_count}",
                    f"  Members: {tenant.member_count}",
                    f"  Commissioners: {tenant.commissioner_count}",
                    f"  Integrity errors: {tenant.error_count}",
                    f"  Result: {tenant.result}",
                    "",
                ]
            )
    elif report.tenant_filter is None:
        lines.extend(["No tenants found.", ""])

    if report.errors:
        lines.append("Errors:")
        for issue in report.errors:
            scope = f"tenant_id={issue.tenant_id}: " if issue.tenant_id is not None else ""
            lines.append(f"  - [{issue.code}] {scope}{issue.message}")
        lines.append("")

    if report.orphaned_users:
        lines.append(f"Orphaned global users (informational): {len(report.orphaned_users)}")
        for issue in report.orphaned_users:
            lines.append(f"  - {issue.details['email']} (user_id={issue.details['user_id']})")
        lines.append("")

    if report.is_valid:
        suffix = f" with {len(report.warnings)} warning(s)" if report.warnings else ""
        lines.append(f"Overall: PASS{suffix}")
    else:
        lines.append(f"Overall: FAIL ({len(report.errors)} error(s), {len(report.warnings)} warning(s))")

    return "\n".join(lines)
