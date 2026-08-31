"""Read-only verification of the pre-Alembic database baseline.

The expected inventory in this module is the semantic form of Alembic revision
``0001_current_schema_baseline`` at the cutover. It deliberately ignores
physical column order and generated constraint names, but verifies the schema
behavior that the application depends on.
"""

from __future__ import annotations

import re
from dataclasses import asdict, dataclass
from typing import Any


@dataclass(frozen=True)
class ColumnSpec:
    """Semantic column definition returned by PostgreSQL's catalogs."""

    data_type: str
    nullable: bool
    default: str | None = None
    identity: str = ""


@dataclass(frozen=True)
class FunctionSpec:
    """Application function signature and implementation."""

    result_type: str
    language: str
    body: str


@dataclass(frozen=True)
class SchemaBaselineIssue:
    """One difference between the expected and actual schema."""

    object_type: str
    object_name: str
    problem: str
    expected: Any = None
    actual: Any = None

    def to_dict(self) -> dict[str, Any]:
        values = {
            "object_type": self.object_type,
            "object_name": self.object_name,
            "problem": self.problem,
            "expected": self.expected,
            "actual": self.actual,
        }
        return {
            key: _json_safe(value)
            for key, value in values.items()
            if value is not None
        }


@dataclass(frozen=True)
class SchemaBaselineReport:
    """Complete result of a baseline schema verification."""

    schema_name: str
    issues: list[SchemaBaselineIssue]
    reset_table_present: bool
    alembic_table_present: bool

    @property
    def is_valid(self) -> bool:
        return not self.issues

    def to_dict(self) -> dict[str, Any]:
        return {
            "ok": self.is_valid,
            "schema": self.schema_name,
            "optional_objects": {
                "password_reset_uses": "present" if self.reset_table_present else "absent",
                "alembic_version": "present" if self.alembic_table_present else "absent",
            },
            "error_count": len(self.issues),
            "errors": [issue.to_dict() for issue in self.issues],
        }


def _column(
    data_type: str,
    *,
    nullable: bool = False,
    default: str | None = None,
    identity: str = "",
) -> ColumnSpec:
    return ColumnSpec(data_type, nullable, default, identity)


def _json_safe(value: Any) -> Any:
    """Convert nested schema diff values to deterministic JSON-compatible data."""

    if isinstance(value, (ColumnSpec, FunctionSpec)):
        return {key: _json_safe(item) for key, item in asdict(value).items()}
    if isinstance(value, dict):
        return {str(key): _json_safe(item) for key, item in value.items()}
    if isinstance(value, (set, frozenset)):
        return sorted((_json_safe(item) for item in value), key=str)
    if isinstance(value, (list, tuple)):
        return [_json_safe(item) for item in value]
    return value


_BASELINE_COLUMNS: dict[str, dict[str, ColumnSpec]] = {
    "teams": {
        "abbr": _column("text"),
        "name": _column("text"),
    },
    "weeks": {
        "week_number": _column("integer"),
        "default_lock_at": _column("timestamp with time zone", nullable=True),
    },
    "games": {
        "game_id": _column("bigint", identity="a"),
        "espn_event_id": _column("bigint", nullable=True),
        "week_number": _column("integer"),
        "kickoff_at": _column("timestamp with time zone"),
        "home_abbr": _column("text"),
        "away_abbr": _column("text"),
        "status": _column("text"),
        "home_score": _column("integer", nullable=True),
        "away_score": _column("integer", nullable=True),
        "updated_at": _column("timestamp with time zone", default="now()"),
    },
    "tenants": {
        "tenant_id": _column("bigint", identity="a"),
        "name": _column("text"),
        "pigeons_can_rename": _column("boolean", default="true"),
        "picks_open": _column("boolean", default="true"),
    },
    "tenant_weeks": {
        "tenant_id": _column("bigint"),
        "week_number": _column("integer"),
        "lock_at": _column("timestamp with time zone"),
    },
    "users": {
        "user_id": _column("bigint", identity="a"),
        "email": _column("text"),
        "password_hash": _column("text"),
    },
    "players": {
        "player_id": _column("bigint", default="nextval('players_player_id_seq'::regclass)"),
        "tenant_id": _column("bigint"),
        "pigeon_number": _column("integer"),
        "pigeon_name": _column("text"),
        "season_status": _column("text", default="'pending'"),
        "commissioner_notes": _column("text", default="''"),
    },
    "user_players": {
        "user_id": _column("bigint"),
        "player_id": _column("bigint"),
        "role": _column("text", default="'owner'"),
    },
    "tenant_members": {
        "tenant_id": _column("bigint"),
        "user_id": _column("bigint"),
        "role": _column("text", default="'member'"),
        "primary_player_id": _column("bigint"),
        "last_used_at": _column("timestamp with time zone", nullable=True),
    },
    "tenant_payouts": {
        "tenant_id": _column("bigint"),
        "place": _column("integer"),
        "points": _column("integer"),
    },
    "picks": {
        "player_id": _column("bigint"),
        "game_id": _column("bigint"),
        "picked_home": _column("boolean"),
        "predicted_margin": _column("integer"),
        "created_at": _column("timestamp with time zone", default="now()"),
    },
    "scheduler_runs": {
        "job_name": _column("text"),
        "last_at": _column("timestamp with time zone"),
    },
}

_OPTIONAL_COLUMNS: dict[str, dict[str, ColumnSpec]] = {
    # This table is currently created lazily by auth.py.  It is allowed to be
    # present or absent at baseline, but must have this exact shape if present.
    "password_reset_uses": {
        "jti": _column("text"),
        "user_id": _column("bigint"),
        "used_at": _column("timestamp with time zone", default="now()"),
    },
    # Alembic creates this control table when an existing database is stamped.
    "alembic_version": {
        "version_num": _column("character varying(32)"),
    },
}

_BASELINE_CONSTRAINTS: dict[str, set[str]] = {
    "teams": {"PRIMARY KEY (abbr)"},
    "weeks": {
        "PRIMARY KEY (week_number)",
        "CHECK (week_number >= 1 AND week_number <= 18)",
    },
    "games": {
        "PRIMARY KEY (game_id)",
        "UNIQUE (espn_event_id)",
        "UNIQUE (week_number, home_abbr, away_abbr)",
        "FOREIGN KEY (week_number) REFERENCES weeks(week_number) ON DELETE CASCADE",
        "FOREIGN KEY (home_abbr) REFERENCES teams(abbr)",
        "FOREIGN KEY (away_abbr) REFERENCES teams(abbr)",
        "CHECK (home_abbr <> away_abbr)",
        "CHECK (status = ANY (ARRAY['scheduled'::text, 'in_progress'::text, 'final'::text]))",
    },
    "tenants": {"PRIMARY KEY (tenant_id)"},
    "tenant_weeks": {
        "PRIMARY KEY (tenant_id, week_number)",
        "FOREIGN KEY (tenant_id) REFERENCES tenants(tenant_id) ON DELETE CASCADE",
        "FOREIGN KEY (week_number) REFERENCES weeks(week_number) ON DELETE CASCADE",
    },
    "users": {
        "PRIMARY KEY (user_id)",
        r"CHECK (email ~* '^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$'::text)",
    },
    "players": {
        "PRIMARY KEY (player_id)",
        "UNIQUE (tenant_id, pigeon_number)",
        "UNIQUE (tenant_id, pigeon_name)",
        "FOREIGN KEY (tenant_id) REFERENCES tenants(tenant_id) ON DELETE CASCADE",
        "CHECK (pigeon_number >= 1)",
        "CHECK (season_status = ANY (ARRAY['pending'::text, 'active'::text, 'out'::text]))",
    },
    "user_players": {
        "PRIMARY KEY (user_id, player_id)",
        "FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE",
        "FOREIGN KEY (player_id) REFERENCES players(player_id) ON DELETE CASCADE",
        "CHECK (role = ANY (ARRAY['owner'::text, 'manager'::text, 'viewer'::text]))",
    },
    "tenant_members": {
        "PRIMARY KEY (tenant_id, user_id)",
        "FOREIGN KEY (tenant_id) REFERENCES tenants(tenant_id) ON DELETE CASCADE",
        "FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE",
        "FOREIGN KEY (primary_player_id) REFERENCES players(player_id)",
        "CHECK (role = ANY (ARRAY['commissioner'::text, 'member'::text]))",
    },
    "tenant_payouts": {
        "PRIMARY KEY (tenant_id, place)",
        "FOREIGN KEY (tenant_id) REFERENCES tenants(tenant_id) ON DELETE CASCADE",
        "CHECK (place >= 1)",
        "CHECK (points >= 0)",
    },
    "picks": {
        "PRIMARY KEY (player_id, game_id)",
        "FOREIGN KEY (player_id) REFERENCES players(player_id) ON DELETE CASCADE",
        "FOREIGN KEY (game_id) REFERENCES games(game_id) ON DELETE CASCADE",
        "CHECK (predicted_margin >= 0)",
    },
    "scheduler_runs": {"PRIMARY KEY (job_name)"},
}

_OPTIONAL_CONSTRAINTS: dict[str, set[str]] = {
    "password_reset_uses": {
        "PRIMARY KEY (jti)",
        "FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE",
    },
    "alembic_version": {"PRIMARY KEY (version_num)"},
}

_BASELINE_SEQUENCES = {
    "games_game_id_seq",
    "players_player_id_seq",
    "tenants_tenant_id_seq",
    "users_user_id_seq",
}

_BASELINE_INDEXES = {
    "ix_games_kickoff": "CREATE INDEX ix_games_kickoff ON games USING btree (kickoff_at)",
    "ix_games_week_status": (
        "CREATE INDEX ix_games_week_status ON games USING btree (week_number, status)"
    ),
    "ix_picks_game": "CREATE INDEX ix_picks_game ON picks USING btree (game_id)",
    "ix_picks_player": "CREATE INDEX ix_picks_player ON picks USING btree (player_id)",
    "uniq_player_single_owner": (
        "CREATE UNIQUE INDEX uniq_player_single_owner ON user_players USING btree (player_id) "
        "WHERE role = 'owner'::text"
    ),
    "uniq_users_email_lower": (
        "CREATE UNIQUE INDEX uniq_users_email_lower ON users USING btree (lower(email))"
    ),
}

# pg_get_viewdef output from the intended baseline.  PostgreSQL has already
# parsed and canonicalized these definitions, so comparing their normalized
# forms detects behavioral view drift without depending on source formatting.
_BASELINE_VIEWS = {
    "v_picks_filled": """
        SELECT pl.player_id, pl.tenant_id, pl.pigeon_number, g.game_id, g.week_number,
               COALESCE(p.picked_home, true) AS picked_home,
               COALESCE(p.predicted_margin, 0) AS predicted_margin,
               p.created_at, p.game_id IS NOT NULL AS is_made
          FROM players pl
          CROSS JOIN games g
          LEFT JOIN picks p ON p.player_id = pl.player_id AND p.game_id = g.game_id;
    """,
    "v_results": """
        WITH base AS (
          SELECT pl.pigeon_name, pl.player_id, pl.tenant_id, pl.pigeon_number,
                 g.week_number, g.game_id,
                 format('%s @ %s'::text, g.away_abbr, g.home_abbr) AS game_name,
                 CASE WHEN f.picked_home THEN f.predicted_margin
                      ELSE - f.predicted_margin END AS predicted_margin,
                 g.home_score - g.away_score AS actual_margin, f.is_made
            FROM v_picks_filled f
            JOIN games g ON g.game_id = f.game_id
            JOIN players pl ON pl.player_id = f.player_id
           WHERE g.kickoff_at <= now() AND g.home_score IS NOT NULL
             AND g.away_score IS NOT NULL
        )
        SELECT pigeon_name, player_id, tenant_id, pigeon_number, week_number, game_id,
               game_name, predicted_margin, actual_margin,
               abs(predicted_margin - actual_margin) AS diff,
               CASE
                 WHEN is_made = false THEN 50
                 WHEN sign(predicted_margin::double precision) = 0::double precision
                  AND sign(actual_margin::double precision) = 0::double precision THEN 7
                 WHEN sign(predicted_margin::double precision) <>
                      sign(actual_margin::double precision) THEN 7
                 ELSE 0
               END AS penalty,
               abs(predicted_margin - actual_margin) +
               CASE
                 WHEN is_made = false THEN 100
                 WHEN sign(predicted_margin::double precision) = 0::double precision
                  AND sign(actual_margin::double precision) = 0::double precision THEN 7
                 WHEN sign(predicted_margin::double precision) <>
                      sign(actual_margin::double precision) THEN 7
                 ELSE 0
               END AS score
          FROM base b;
    """,
    "v_weekly_leaderboard": """
        WITH totals AS (
          SELECT r.player_id, r.tenant_id, min(r.pigeon_name) AS pigeon_name,
                 min(r.pigeon_number) AS pigeon_number, r.week_number,
                 sum(r.score)::integer AS score
            FROM v_results r
           GROUP BY r.player_id, r.tenant_id, r.week_number
        ), ranked AS (
          SELECT t.player_id, t.tenant_id, t.pigeon_name, t.pigeon_number,
                 t.week_number, t.score,
                 rank() OVER (PARTITION BY t.tenant_id, t.week_number ORDER BY t.score) AS rank,
                 count(*) OVER (PARTITION BY t.tenant_id, t.week_number, t.score) AS tie_count
            FROM totals t
        )
        SELECT player_id, tenant_id, pigeon_number, pigeon_name, week_number,
               LEAST(score, 800) AS score, rank,
               (rank::numeric + (tie_count - 1)::numeric / 2.0)::numeric(10,1) AS points
          FROM ranked;
    """,
    "v_week_picks_with_names": """
        SELECT pl.player_id, pl.tenant_id, pl.pigeon_number, pl.pigeon_name,
               g.game_id, g.week_number, f.picked_home, f.predicted_margin,
               g.home_abbr, g.away_abbr, g.kickoff_at, g.status,
               g.home_score, g.away_score
          FROM v_picks_filled f
          JOIN games g ON g.game_id = f.game_id
          JOIN players pl ON pl.player_id = f.player_id
          JOIN tenant_weeks tw ON tw.tenant_id = pl.tenant_id
                              AND tw.week_number = g.week_number
         WHERE tw.lock_at <= now();
    """,
    "v_admin_week_picks_with_names": """
        SELECT pl.player_id, pl.tenant_id, pl.pigeon_number, pl.pigeon_name,
               g.game_id, g.week_number, f.picked_home, f.predicted_margin,
               g.home_abbr, g.away_abbr, g.kickoff_at, g.status,
               g.home_score, g.away_score
          FROM v_picks_filled f
          JOIN games g ON g.game_id = f.game_id
          JOIN players pl ON pl.player_id = f.player_id;
    """,
}

_LOCK_FUNCTION_BODY = """
DECLARE
  is_locked BOOLEAN;
  bypass    TEXT;
BEGIN
  BEGIN
    bypass := current_setting('app.bypass_lock', true);
  EXCEPTION WHEN OTHERS THEN
    bypass := NULL;
  END;

  IF COALESCE(bypass, '') IN ('on','true','1') THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  SELECT (tw.lock_at <= now())
    INTO is_locked
  FROM players pl
  JOIN games g
    ON g.game_id = COALESCE(NEW.game_id, OLD.game_id)
  JOIN tenant_weeks tw
    ON tw.tenant_id = pl.tenant_id AND tw.week_number = g.week_number
  WHERE pl.player_id = COALESCE(NEW.player_id, OLD.player_id);

  IF COALESCE(is_locked, FALSE) THEN
    RAISE EXCEPTION 'Week is locked; picks are read-only';
  END IF;

  RETURN COALESCE(NEW, OLD);
END
"""

_BASELINE_FUNCTIONS = {
    "deny_picks_after_lock()": FunctionSpec("trigger", "plpgsql", _LOCK_FUNCTION_BODY),
}

_BASELINE_TRIGGERS = {
    ("picks", "trg_picks_insert_lock"): (
        "CREATE TRIGGER trg_picks_insert_lock BEFORE INSERT ON picks "
        "FOR EACH ROW EXECUTE FUNCTION deny_picks_after_lock()"
    ),
    ("picks", "trg_picks_update_lock"): (
        "CREATE TRIGGER trg_picks_update_lock BEFORE UPDATE ON picks "
        "FOR EACH ROW EXECUTE FUNCTION deny_picks_after_lock()"
    ),
    ("picks", "trg_picks_delete_lock"): (
        "CREATE TRIGGER trg_picks_delete_lock BEFORE DELETE ON picks "
        "FOR EACH ROW EXECUTE FUNCTION deny_picks_after_lock()"
    ),
}


def _normalize_sql(value: str | None) -> str | None:
    if value is None:
        return None
    normalized = value.replace('"', "").replace("public.", "")
    normalized = re.sub(r"\s+", " ", normalized.strip()).lower()
    normalized = normalized.replace("::text", "")
    normalized = re.sub(r"\s*([(),;])\s*", r"\1", normalized)
    return normalized.removesuffix(";")


def _collect_columns(cur: Any) -> dict[str, dict[str, ColumnSpec]]:
    cur.execute(
        """
        SELECT c.relname,
               a.attname,
               format_type(a.atttypid, a.atttypmod),
               NOT a.attnotnull AS nullable,
               pg_get_expr(d.adbin, d.adrelid) AS default_expression,
               a.attidentity
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          JOIN pg_attribute a
            ON a.attrelid = c.oid
           AND a.attnum > 0
           AND NOT a.attisdropped
          LEFT JOIN pg_attrdef d
            ON d.adrelid = c.oid
           AND d.adnum = a.attnum
         WHERE n.nspname = current_schema()
           AND c.relkind IN ('r', 'p')
         ORDER BY c.relname, a.attnum
        """
    )
    columns: dict[str, dict[str, ColumnSpec]] = {}
    for table, name, data_type, nullable, default, identity in cur.fetchall():
        columns.setdefault(str(table), {})[str(name)] = ColumnSpec(
            data_type=str(data_type),
            nullable=bool(nullable),
            default=_normalize_sql(default),
            identity=str(identity),
        )
    return columns


def _collect_constraints(cur: Any) -> dict[str, set[str]]:
    cur.execute(
        """
        SELECT c.conrelid::regclass::text,
               c.contype,
               pg_get_constraintdef(c.oid, true)
          FROM pg_constraint c
          JOIN pg_namespace n ON n.oid = c.connamespace
         WHERE n.nspname = current_schema()
         ORDER BY c.conrelid::regclass::text, c.contype, c.oid
        """
    )
    constraints: dict[str, set[str]] = {}
    for table, constraint_type, definition in cur.fetchall():
        # Newer PostgreSQL versions expose NOT NULL attributes in
        # pg_constraint (contype='n'); older versions expose them only through
        # pg_attribute.attnotnull.  Columns are already compared semantically
        # by _collect_columns(), so including these rows would make identical
        # schemas look different across PostgreSQL versions.
        if constraint_type == "n":
            continue
        constraints.setdefault(str(table).removeprefix("public."), set()).add(
            _normalize_sql(str(definition)) or ""
        )
    return constraints


def _collect_inventory(conn: Any) -> dict[str, Any]:
    with conn.cursor() as cur:
        cur.execute("SELECT current_schema()")
        schema_name = str(cur.fetchone()[0])

        cur.execute(
            """
            SELECT c.relkind, c.relname
              FROM pg_class c
              JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = current_schema()
               AND c.relkind IN ('r', 'p', 'S', 'v', 'm')
             ORDER BY c.relkind, c.relname
            """
        )
        relations = {str(name): str(kind) for kind, name in cur.fetchall()}

        columns = _collect_columns(cur)
        constraints = _collect_constraints(cur)

        cur.execute(
            """
            SELECT index_relation.relname,
                   pg_get_indexdef(index_data.indexrelid, 0, true)
              FROM pg_index index_data
              JOIN pg_class index_relation ON index_relation.oid = index_data.indexrelid
              JOIN pg_class table_relation ON table_relation.oid = index_data.indrelid
              JOIN pg_namespace n ON n.oid = table_relation.relnamespace
              LEFT JOIN pg_constraint constraint_data
                ON constraint_data.conindid = index_data.indexrelid
             WHERE n.nspname = current_schema()
               AND constraint_data.oid IS NULL
             ORDER BY index_relation.relname
            """
        )
        indexes = {
            str(name): _normalize_sql(str(definition)) or ""
            for name, definition in cur.fetchall()
        }

        cur.execute(
            """
            SELECT c.relname, pg_get_viewdef(c.oid, true)
              FROM pg_class c
              JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = current_schema()
               AND c.relkind = 'v'
             ORDER BY c.relname
            """
        )
        views = {
            str(name): _normalize_sql(str(definition)) or ""
            for name, definition in cur.fetchall()
        }

        cur.execute(
            """
            SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
                   pg_get_function_result(p.oid),
                   language_data.lanname,
                   p.prosrc
              FROM pg_proc p
              JOIN pg_namespace n ON n.oid = p.pronamespace
              JOIN pg_language language_data ON language_data.oid = p.prolang
             WHERE n.nspname = current_schema()
             ORDER BY p.proname, pg_get_function_identity_arguments(p.oid)
            """
        )
        functions = {
            str(signature): FunctionSpec(
                result_type=str(result_type),
                language=str(language),
                body=_normalize_sql(str(body)) or "",
            )
            for signature, result_type, language, body in cur.fetchall()
        }

        cur.execute(
            """
            SELECT table_relation.relname,
                   trigger_data.tgname,
                   trigger_data.tgenabled,
                   pg_get_triggerdef(trigger_data.oid, true)
              FROM pg_trigger trigger_data
              JOIN pg_class table_relation ON table_relation.oid = trigger_data.tgrelid
              JOIN pg_namespace n ON n.oid = table_relation.relnamespace
             WHERE n.nspname = current_schema()
               AND NOT trigger_data.tgisinternal
             ORDER BY table_relation.relname, trigger_data.tgname
            """
        )
        triggers = {
            (str(table), str(name)): (str(enabled), _normalize_sql(str(definition)) or "")
            for table, name, enabled, definition in cur.fetchall()
        }

    return {
        "schema_name": schema_name,
        "relations": relations,
        "columns": columns,
        "constraints": constraints,
        "indexes": indexes,
        "views": views,
        "functions": functions,
        "triggers": triggers,
    }


def _add_mapping_issues(
    issues: list[SchemaBaselineIssue],
    object_type: str,
    expected: dict[Any, Any],
    actual: dict[Any, Any],
) -> None:
    for name in sorted(expected.keys() - actual.keys(), key=str):
        issues.append(
            SchemaBaselineIssue(object_type, str(name), "missing", expected=expected[name])
        )
    for name in sorted(actual.keys() - expected.keys(), key=str):
        issues.append(
            SchemaBaselineIssue(object_type, str(name), "unexpected", actual=actual[name])
        )
    for name in sorted(expected.keys() & actual.keys(), key=str):
        if expected[name] != actual[name]:
            issues.append(
                SchemaBaselineIssue(
                    object_type,
                    str(name),
                    "definition differs",
                    expected=expected[name],
                    actual=actual[name],
                )
            )


def verify_schema_baseline(conn: Any) -> SchemaBaselineReport:
    """Compare the connected database's current schema with the cutover baseline."""

    inventory = _collect_inventory(conn)
    issues: list[SchemaBaselineIssue] = []
    relations: dict[str, str] = inventory["relations"]

    reset_present = "password_reset_uses" in relations
    alembic_present = "alembic_version" in relations
    allowed_optional = set(_OPTIONAL_COLUMNS)

    expected_relations = {
        **{name: "r" for name in _BASELINE_COLUMNS},
        **{name: "S" for name in _BASELINE_SEQUENCES},
        **{name: "v" for name in _BASELINE_VIEWS},
    }
    actual_baseline_relations = {
        name: kind for name, kind in relations.items() if name not in allowed_optional
    }
    _add_mapping_issues(
        issues, "relation", expected_relations, actual_baseline_relations
    )

    expected_columns = dict(_BASELINE_COLUMNS)
    expected_constraints = dict(_BASELINE_CONSTRAINTS)
    for optional_name in allowed_optional & relations.keys():
        if relations[optional_name] != "r":
            issues.append(
                SchemaBaselineIssue(
                    "relation",
                    optional_name,
                    "optional object has wrong relation kind",
                    expected="r",
                    actual=relations[optional_name],
                )
            )
        expected_columns[optional_name] = _OPTIONAL_COLUMNS[optional_name]
        expected_constraints[optional_name] = _OPTIONAL_CONSTRAINTS[optional_name]

    actual_columns = {
        name: value
        for name, value in inventory["columns"].items()
        if name in expected_columns
    }
    _add_mapping_issues(issues, "table columns", expected_columns, actual_columns)

    normalized_constraints = {
        table: {_normalize_sql(value) or "" for value in values}
        for table, values in expected_constraints.items()
    }
    actual_constraints = {
        name: value
        for name, value in inventory["constraints"].items()
        if name in expected_constraints
    }
    _add_mapping_issues(
        issues, "table constraints", normalized_constraints, actual_constraints
    )

    expected_indexes = {
        name: _normalize_sql(definition) or ""
        for name, definition in _BASELINE_INDEXES.items()
    }
    _add_mapping_issues(issues, "index", expected_indexes, inventory["indexes"])

    expected_views = {
        name: _normalize_sql(definition) or ""
        for name, definition in _BASELINE_VIEWS.items()
    }
    _add_mapping_issues(issues, "view", expected_views, inventory["views"])

    expected_functions = {
        name: FunctionSpec(spec.result_type, spec.language, _normalize_sql(spec.body) or "")
        for name, spec in _BASELINE_FUNCTIONS.items()
    }
    _add_mapping_issues(
        issues, "function", expected_functions, inventory["functions"]
    )

    expected_triggers = {
        key: ("O", _normalize_sql(definition) or "")
        for key, definition in _BASELINE_TRIGGERS.items()
    }
    _add_mapping_issues(issues, "trigger", expected_triggers, inventory["triggers"])

    issues.sort(key=lambda issue: (issue.object_type, issue.object_name, issue.problem))
    return SchemaBaselineReport(
        schema_name=inventory["schema_name"],
        issues=issues,
        reset_table_present=reset_present,
        alembic_table_present=alembic_present,
    )


def format_schema_baseline_report(report: SchemaBaselineReport) -> str:
    """Render a concise human-readable schema diff."""

    lines = [
        f"Schema: {report.schema_name}",
        "Optional password_reset_uses: "
        + ("present and valid" if report.reset_table_present else "absent (allowed at baseline)"),
        "Alembic version table: "
        + ("present and valid" if report.alembic_table_present else "absent (not stamped yet)"),
        "",
    ]
    if report.issues:
        lines.append("Schema differences:")
        for issue in report.issues:
            lines.append(
                f"  - [{issue.object_type}] {issue.object_name}: {issue.problem}"
            )
        lines.extend(["", f"Overall: FAIL ({len(report.issues)} difference(s))"])
    else:
        lines.append("Overall: PASS (schema matches the pre-Alembic baseline)")
    return "\n".join(lines)
