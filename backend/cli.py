"""
Command-line tools for the Pigeon Pool backend.

Commands:
- sync-schedule  : Populate the current season's NFL schedule (weeks 1–18), called once
- sync-scores    : Update scores & status for a specific week, called while games are live
- sync-kickoffs  : Refresh kickoff times for a specific week, called infrequently
- reset-season   : Archive picks, wipe games/picks, reset season status, sync new schedule
- list-leagues   : Show all tenants with member/player counts
- create-league  : Create a new league/tenant and assign a commissioner
- delete-league  : Permanently delete a league and its data
- run-sql        : Execute a SQL migration file using the app's DB connection
- setup-fe-tests : Create Playwright FE test fixtures; write playwright/.test-state.json
- teardown-fe-tests : Remove FE test fixtures created by setup-fe-tests
- -help          : Show help/usage

Example usage:
- python -m backend.cli sync-schedule
- python -m backend.cli sync-scores 6
- python -m backend.cli sync-kickoffs 6
- python -m backend.cli import-picks-xlsx C:/path/to/picks.xlsx --week 6
- python -m backend.cli import-picks-xlsx C:/path/to/picks.xlsx --max-week 6
- python -m backend.cli reset-season --year 2024
- python -m backend.cli list-leagues
- python -m backend.cli create-league --name "My Pool" --commissioner-email admin@example.com
- python -m backend.cli delete-league 2 --yes
- python -m backend.cli run-sql database/migration_stage11.sql
"""
# pylint: disable=line-too-long

from __future__ import annotations

import argparse
import csv
import json
import os
from typing import Any, Dict, Callable, Awaitable, NoReturn
import asyncio

import psycopg
from passlib.hash import bcrypt as _bcrypt
from sqlalchemy import text

from backend.routes.auth import make_session_token
from backend.utils.db import AsyncSessionLocal
from backend.utils.score_sync import ScoreSync
from backend.utils.settings import get_settings
from backend.utils.scheduled_jobs import (
    run_kickoff_sync,
    run_poll_scores,
    run_email_sun,
    run_email_mon,
    run_email_tue_warn,
    get_all_player_emails,
)
from .utils.import_picks_xlsx import import_picks_pivot_xlsx

# Mapping of scheduled job names to their runner functions
_JOBS: dict[str, Callable[[Any], Awaitable[dict[str, Any]]]] = {
    "kickoff_sync": run_kickoff_sync,
    "score_sync": run_poll_scores,
    "email_sun": run_email_sun,
    "email_mon": run_email_mon,
    "email_tue_warn": run_email_tue_warn,
}

class _HelpOnErrorParser(argparse.ArgumentParser):
    """ArgumentParser that prints the full help text on errors for a friendlier UX."""
    def error(self, message: str) -> NoReturn:
        self.print_help()
        self.exit(2, f"\nerror: {message}\n")


def get_connection(cfg: Dict[str, Any]) -> psycopg.Connection:
    """Open a psycopg connection and set session TZ to UTC."""
    conn = psycopg.connect(**cfg)  # pylint: disable=no-member
    with conn.cursor() as cur:     # pylint: disable=no-member
        cur.execute("SET TIME ZONE 'UTC';")
    return conn


# -----------------------------------------------------------------------------
# Commands
# -----------------------------------------------------------------------------
async def cmd_load_schedule(_: argparse.Namespace) -> int:
    """
    Populate/refresh the current season's schedule (weeks 1–18).
    Uses async SQLAlchemy session.
    """
    print("[cli] sync-schedule (async SQLAlchemy)")
    async with AsyncSessionLocal() as session:
        sync = ScoreSync(session)
        changed = await sync.load_schedule()
        print(f"[cli] sync-schedule: upserted {changed} game rows.")
    return 0


async def cmd_sync_scores(args: argparse.Namespace) -> int:
    """
    Update scores & status for the given week using ScoreSync.sync_scores_and_status(week).
    """
    week = _validated_week(args.week)
    print(f"[cli] sync-scores {week} (async SQLAlchemy)")
    async with AsyncSessionLocal() as session:
        sync = ScoreSync(session)
        updated = await sync.sync_scores_and_status(week)
        print(f"[cli] sync-scores: updated {updated} game rows.")
    return 0


async def cmd_sync_kickoffs(args: argparse.Namespace) -> int:
    """
    Refresh kickoff times for the given week using ScoreSync.refresh_kickoffs(week).
    """
    week = _validated_week(args.week)
    print(f"[cli] sync-kickoffs {week} (async SQLAlchemy)")
    async with AsyncSessionLocal() as session:
        sync = ScoreSync(session)
        updates = await sync.refresh_kickoffs(week)
        print(f"[cli] sync-kickoffs: updated kickoff_at for {updates} game rows.")
    return 0

async def cmd_reset_season(args: argparse.Namespace) -> int:
    """
    Prepare for a new league year:
      1. Archive all picks to CSV per tenant -> archive/<tid>_<year>_picks.csv
      2. Delete all games (cascades picks) and tenant_weeks
      3. Reset players.season_status = 'pending'
      4. Sync the new season's schedule
      5. Re-seed tenant_weeks lock times from weeks.default_lock_at
    """
    settings = get_settings()
    cfg = settings.psycopg_kwargs()

    with get_connection(cfg) as conn:
        with conn.cursor() as cur:
            year = getattr(args, "year", None) or None
            if not year:
                cur.execute("SELECT EXTRACT(YEAR FROM MIN(kickoff_at))::int FROM games")
                row = cur.fetchone()
                year = row[0] if row and row[0] else 2024

            cur.execute("SELECT COUNT(*) FROM games")
            game_count = cur.fetchone()[0]  # type: ignore[index]
            cur.execute("SELECT COUNT(*) FROM picks p JOIN players pl ON pl.player_id = p.player_id")
            pick_count = cur.fetchone()[0]  # type: ignore[index]
            cur.execute("SELECT tenant_id, name FROM tenants ORDER BY tenant_id")
            tenants = cur.fetchall()

    print(f"[cli] reset-season: archiving season year {year}")
    print(f"[cli]   {game_count} games and {pick_count} picks will be deleted")
    print(f"[cli]   {len(tenants)} tenant(s) will have picks archived")

    if not args.yes:
        try:
            confirm = input("\nType 'yes' to proceed: ")
        except EOFError:
            print("\n[cli] Aborted (no TTY — use --yes to skip confirmation).")
            return 0
        if confirm.strip().lower() != "yes":
            print("[cli] Aborted.")
            return 0

    # Step 1: Archive picks per tenant
    os.makedirs("archive", exist_ok=True)
    with get_connection(cfg) as conn:
        for tenant_id, tenant_name in tenants:
            archive_path = os.path.join("archive", f"{tenant_id}_{year}_picks.csv")
            with conn.cursor() as cur:
                cur.execute("""
                    SELECT p.pigeon_number, p.pigeon_name,
                           g.week_number, g.home_abbr, g.away_abbr,
                           pk.picked_home, pk.predicted_margin, pk.created_at,
                           g.home_score, g.away_score, g.status
                      FROM picks pk
                      JOIN players p ON p.player_id = pk.player_id
                      JOIN games g ON g.game_id = pk.game_id
                     WHERE p.tenant_id = %s
                     ORDER BY p.pigeon_number, g.week_number, pk.game_id
                """, (tenant_id,))
                rows = cur.fetchall()

            with open(archive_path, "w", newline="", encoding="utf-8") as f:
                writer = csv.writer(f)
                writer.writerow([
                    "pigeon_number", "pigeon_name", "week_number",
                    "home_abbr", "away_abbr", "picked_home",
                    "predicted_margin", "created_at",
                    "home_score", "away_score", "status",
                ])
                writer.writerows(rows)
            print(f"[cli]   Archived {len(rows)} picks for '{tenant_name}' -> {archive_path}")

        # Step 2: Wipe games (cascades picks) and tenant_weeks
        with conn.cursor() as cur:
            cur.execute("DELETE FROM games")
            games_deleted = cur.rowcount
            cur.execute("DELETE FROM tenant_weeks")
            weeks_deleted = cur.rowcount
            # Step 3: Reset season_status for all players
            cur.execute("UPDATE players SET season_status = 'pending'")
            players_reset = cur.rowcount
        conn.commit()

    print(f"[cli] Deleted {games_deleted} games (picks cascade), {weeks_deleted} tenant_weeks")
    print(f"[cli] Reset season_status='pending' for {players_reset} players")

    # Step 4: Sync new schedule (weeks + games)
    print("[cli] Syncing new season schedule...")
    async with AsyncSessionLocal() as session:
        sync = ScoreSync(session)
        changed = await sync.load_schedule()
        print(f"[cli] sync-schedule: upserted {changed} game rows")

    # Step 5: Re-seed tenant_weeks lock times for all tenants
    with get_connection(cfg) as conn:
        with conn.cursor() as cur:
            for tenant_id, tenant_name in tenants:
                cur.execute("""
                    INSERT INTO tenant_weeks (tenant_id, week_number, lock_at)
                    SELECT %s, week_number, default_lock_at
                      FROM weeks
                     WHERE default_lock_at IS NOT NULL
                    ON CONFLICT DO NOTHING
                """, (tenant_id,))
                seeded = cur.rowcount
                print(f"[cli]   Seeded {seeded} lock times for '{tenant_name}'")
        conn.commit()

    print("[cli] Season reset complete. Review lock times in the admin UI before the season starts.")
    return 0


def cmd_import_picks_xlsx(args: argparse.Namespace) -> int:
    """Import historical picks from a pivoted XLSX workbook ('picks wk N' sheets)."""
    # Friendly validation: require an existing file path
    if not getattr(args, "path", None):
        print("error: missing path to .xlsx workbook. See 'import-picks-xlsx -h' for usage.")
        return 2
    if not os.path.isfile(args.path):
        print(f"error: file not found: {args.path}")
        return 2

    settings = get_settings()
    cfg = settings.psycopg_kwargs()
    print(f"[cli] import-pivot-xlsx -> {cfg['user']}@{cfg['host']}:{cfg['port']}/{cfg['dbname']}")

    # Validate week constraints if provided
    only_week: int | None = None
    max_week: int | None = None
    if getattr(args, "week", None) is not None:
        only_week = _validated_week(args.week)
    if getattr(args, "max_week", None) is not None:
        max_week = _validated_week(args.max_week)

    # One connection for the whole import
    with get_connection(cfg) as conn:
        # Turn on the bypass for this session (works across multiple transactions)
        with conn.cursor() as cur:  # pylint: disable=no-member
            cur.execute("SET app.bypass_lock = 'on';")

        try:
            # Do the import work (any inserts/updates on this conn will bypass the trigger)
            extra_kwargs: Dict[str, Any] = {}
            if max_week is not None:
                extra_kwargs["max_week"] = max_week
            if only_week is not None:
                extra_kwargs["only_week"] = only_week

            processed = import_picks_pivot_xlsx(
                xlsx_path=args.path,
                conn=conn,
                **extra_kwargs,
            )
            print(f"[cli] Pivot import complete. Processed {processed} player-pick cells.")
        finally:
            # Always clear the flag so future uses of this connection (or pooled conns) are safe
            with conn.cursor() as cur:  # pylint: disable=no-member
                cur.execute("RESET app.bypass_lock;")

    return 0

async def cmd_run_job(args: argparse.Namespace) -> int:
    """
    Run a scheduler job immediately (bypasses time gates/predicates).
    Example:
      python -m backend.cli run-job email_sun
      python -m backend.cli run-job email_mon --dry-run
      python -m backend.cli run-job email_tue_warn --mark
    """
    job = args.job
    if job not in _JOBS:
        print(f"error: unknown job '{job}'. Choices: {', '.join(sorted(_JOBS.keys()))}")
        return 2

    # Optional email dry-run so you can exercise the whole path without sending
    if getattr(args, "dry_run", False):
        os.environ["EMAIL_DRY_RUN"] = "true"

    async with AsyncSessionLocal() as session:
        result = await _JOBS[job](session)
        print(f"[cli] run-job {job}: {result}")

        if getattr(args, "mark", False):
            await session.execute(text("""
                INSERT INTO scheduler_runs(job_name, last_at)
                VALUES (:j, now())
                ON CONFLICT (job_name) DO UPDATE SET last_at = EXCLUDED.last_at
            """), {"j": job})
            await session.commit()
            print(f"[cli] run-job {job}: marked last run in scheduler_runs.")

    return 0

# -----------------------------------------------------------------------------
# League (tenant) management commands
# -----------------------------------------------------------------------------

def cmd_list_leagues(_: argparse.Namespace) -> int:
    """List all tenants with member and player counts."""
    settings = get_settings()
    cfg = settings.psycopg_kwargs()
    with get_connection(cfg) as conn:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT t.tenant_id, t.name,
                       COUNT(DISTINCT tm.user_id) AS members,
                       COUNT(DISTINCT p.player_id) AS players
                  FROM tenants t
                  LEFT JOIN tenant_members tm ON tm.tenant_id = t.tenant_id
                  LEFT JOIN players p ON p.tenant_id = t.tenant_id
                 GROUP BY t.tenant_id, t.name
                 ORDER BY t.tenant_id
            """)
            rows = cur.fetchall()
    if not rows:
        print("[cli] No leagues found.")
        return 0
    print(f"{'ID':>4}  {'Name':<30}  {'Members':>7}  {'Players':>7}")
    print(f"{'----':>4}  {'------------------------------':<30}  {'-------':>7}  {'-------':>7}")
    for r in rows:
        print(f"{r[0]:>4}  {r[1]:<30}  {r[2]:>7}  {r[3]:>7}")
    return 0


def cmd_create_league(args: argparse.Namespace) -> int:
    """
    Create a new league/tenant.
    The commissioner must already have a user account. A placeholder player named
    'Commissioner' (pigeon_number=1) is created; rename it via League Settings after login.
    Default lock times (weeks.default_lock_at) are copied into tenant_weeks if available.
    """
    settings = get_settings()
    cfg = settings.psycopg_kwargs()
    name = args.name.strip()
    email = args.commissioner_email.strip().lower()
    if not name:
        print("error: --name cannot be empty")
        return 2

    with get_connection(cfg) as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT user_id FROM users WHERE lower(email) = %s", (email,))
            row = cur.fetchone()
            if not row:
                print(f"error: user '{email}' not found. Create the user account first.")
                return 1
            user_id = row[0]

            cur.execute("INSERT INTO tenants (name) VALUES (%s) RETURNING tenant_id", (name,))
            tenant_id = cur.fetchone()[0]  # type: ignore[index]

            cur.execute("""
                INSERT INTO tenant_weeks (tenant_id, week_number, lock_at)
                SELECT %s, week_number, default_lock_at
                  FROM weeks
                 WHERE default_lock_at IS NOT NULL
                ON CONFLICT DO NOTHING
            """, (tenant_id,))
            lock_count = cur.rowcount

            cur.execute("""
                INSERT INTO players (tenant_id, pigeon_number, pigeon_name)
                VALUES (%s, 1, 'Commissioner')
                RETURNING player_id
            """, (tenant_id,))
            player_id = cur.fetchone()[0]  # type: ignore[index]

            cur.execute(
                "INSERT INTO user_players (user_id, player_id, role) VALUES (%s, %s, 'owner')",
                (user_id, player_id),
            )
            cur.execute("""
                INSERT INTO tenant_members (tenant_id, user_id, role, primary_player_id)
                VALUES (%s, %s, 'commissioner', %s)
            """, (tenant_id, user_id, player_id))

            for place, points in enumerate([5, 4, 3, 2, 1], start=1):
                cur.execute(
                    "INSERT INTO tenant_payouts (tenant_id, place, points) VALUES (%s, %s, %s)",
                    (tenant_id, place, points),
                )

        conn.commit()

    print(f"[cli] League created: tenant_id={tenant_id}, name='{name}'")
    print(f"[cli]   Commissioner: {email}")
    print(f"[cli]   Lock times copied: {lock_count} weeks")
    print(f"[cli]   Placeholder player 'Commissioner' (player_id={player_id}) created")
    print("[cli]   -> Rename via League Settings after first login")
    return 0


def cmd_run_sql(args: argparse.Namespace) -> int:
    """
    Execute a SQL file against the configured database.
    Used for applying migration scripts without requiring a separate psql install.
    """
    path = args.path
    try:
        with open(path, encoding="utf-8") as f:
            sql = f.read()
    except FileNotFoundError:
        print(f"error: file not found: {path}")
        return 1

    settings = get_settings()
    cfg = settings.psycopg_kwargs()
    with get_connection(cfg) as conn:
        with conn.cursor() as cur:
            cur.execute(sql)  # type: ignore[arg-type]
        conn.commit()
    print(f"[cli] Applied: {path}")
    return 0


def cmd_delete_league(args: argparse.Namespace) -> int:
    """
    Permanently delete a league and all its data.
    Users who belong only to this league are also deleted.
    Requires --yes or interactive confirmation.
    """
    settings = get_settings()
    cfg = settings.psycopg_kwargs()
    tenant_id = args.tenant_id

    with get_connection(cfg) as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT name FROM tenants WHERE tenant_id = %s", (tenant_id,))
            row = cur.fetchone()
            if not row:
                print(f"error: no league with tenant_id={tenant_id}")
                return 1
            tenant_name = row[0]

            cur.execute("SELECT COUNT(*) FROM tenant_members WHERE tenant_id = %s", (tenant_id,))
            member_count = cur.fetchone()[0]  # type: ignore[index]

            cur.execute("SELECT COUNT(*) FROM players WHERE tenant_id = %s", (tenant_id,))
            player_count = cur.fetchone()[0]  # type: ignore[index]

            cur.execute("""
                SELECT COUNT(*) FROM picks p
                  JOIN players pl ON pl.player_id = p.player_id
                 WHERE pl.tenant_id = %s
            """, (tenant_id,))
            pick_count = cur.fetchone()[0]  # type: ignore[index]

            # Users whose only tenant is this one
            cur.execute("""
                SELECT u.email
                  FROM tenant_members tm
                  JOIN users u ON u.user_id = tm.user_id
                 WHERE tm.tenant_id = %s
                   AND NOT EXISTS (
                       SELECT 1 FROM tenant_members tm2
                        WHERE tm2.user_id = tm.user_id
                          AND tm2.tenant_id != %s
                   )
            """, (tenant_id, tenant_id))
            orphaned_emails = [r[0] for r in cur.fetchall()]

        print(f"League '{tenant_name}' (tenant_id={tenant_id})")
        print(f"  {member_count} members, {player_count} players, {pick_count} picks will be deleted")
        if orphaned_emails:
            print(f"  {len(orphaned_emails)} user(s) with no other league will also be deleted:")
            for e in orphaned_emails:
                print(f"    - {e}")
        else:
            print("  No users will be deleted (all members belong to other leagues too)")

        if not args.yes:
            try:
                confirm = input("\nType 'yes' to permanently delete: ")
            except EOFError:
                print("\n[cli] Aborted (no TTY — use --yes to skip confirmation).")
                return 0
            if confirm.strip().lower() != "yes":
                print("[cli] Aborted.")
                return 0

        with conn.cursor() as cur:
            # 1. Remove all tenant_members (clears primary_player_id FK blocking player deletion)
            cur.execute("DELETE FROM tenant_members WHERE tenant_id = %s", (tenant_id,))

            # 2. Delete orphaned users (cascades their user_players rows)
            if orphaned_emails:
                cur.execute(
                    "DELETE FROM users WHERE lower(email) = ANY(%s)",
                    ([e.lower() for e in orphaned_emails],),
                )

            # 3. Delete players (cascades picks and remaining user_players)
            cur.execute("DELETE FROM players WHERE tenant_id = %s", (tenant_id,))

            # 4. Delete the tenant (cascades tenant_weeks)
            cur.execute("DELETE FROM tenants WHERE tenant_id = %s", (tenant_id,))

        conn.commit()

    print(f"[cli] League '{tenant_name}' (tenant_id={tenant_id}) permanently deleted.")
    return 0


def cmd_setup_fe_tests(_: argparse.Namespace) -> int:
    """
    Create isolated test fixtures for Playwright FE tests. Mirrors the logic of the
    scored_games + test_data fixtures in tests/conftest.py so game detection and
    synthetic insertion stay in one place (Python).

    Writes playwright/.test-state.json with:
      has_real_games  — bool; snapshot tests skip when False
      test            — tenant/player/user/token for stateful E2E tests
      snapshot        — commissioner token for the real tenant (snapshot tests only)
    """
    settings = get_settings()
    cfg = settings.psycopg_kwargs()

    with get_connection(cfg) as conn:
        with conn.cursor() as cur:
            # Guard against leftover data from an aborted previous run.
            cur.execute("DELETE FROM tenants WHERE name = '_Test FE League'")
            cur.execute("DELETE FROM users WHERE email = '_testfe@example.com'")
        conn.commit()

        with conn.cursor() as cur:
            # ── Step 1: detect or inject scored games (mirrors conftest scored_games) ──
            cur.execute("""
                SELECT game_id, week_number, home_score, away_score
                  FROM games
                 WHERE kickoff_at <= now()
                   AND home_score IS NOT NULL
                   AND away_score IS NOT NULL
                 ORDER BY week_number, game_id
                 LIMIT 10
            """)
            scored_rows = cur.fetchall()

            has_real_games = bool(scored_rows)
            synthetic_ids: list[int] = []

            if not scored_rows:
                cur.execute("""
                    INSERT INTO games (week_number, kickoff_at, home_abbr, away_abbr, status, home_score, away_score)
                    VALUES (1, '2020-01-05 18:00:00+00', 'KC', 'BUF', 'final', 21, 14)
                    RETURNING game_id
                """)
                g1 = cur.fetchone()[0]  # type: ignore[index]
                cur.execute("""
                    INSERT INTO games (week_number, kickoff_at, home_abbr, away_abbr, status, home_score, away_score)
                    VALUES (1, '2020-01-05 21:30:00+00', 'LAR', 'SF', 'final', 10, 3)
                    RETURNING game_id
                """)
                g2 = cur.fetchone()[0]  # type: ignore[index]
                synthetic_ids.extend([g1, g2])
                scored_rows = [(g1, 1, 21, 14), (g2, 1, 10, 3)]

            scored_weeks = {r[1] for r in scored_rows}
            scored_week = min(scored_weeks)

            # Submission game — week 18, always unlocked for the test tenant (lock_at = 2099).
            # We insert TB @ NO; if that exact matchup already exists in week 18 we reuse it.
            submission_week = 18
            cur.execute("""
                INSERT INTO games (week_number, kickoff_at, home_abbr, away_abbr, status)
                VALUES (%s, '2099-09-01 20:00:00+00', 'TB', 'NO', 'scheduled')
                ON CONFLICT (week_number, home_abbr, away_abbr) DO NOTHING
                RETURNING game_id
            """, (submission_week,))
            row = cur.fetchone()
            if row:
                submission_gid = row[0]
                synthetic_ids.append(submission_gid)
            else:
                cur.execute(
                    "SELECT game_id FROM games WHERE week_number = %s AND home_abbr = 'TB' AND away_abbr = 'NO'",
                    (submission_week,),
                )
                submission_gid = cur.fetchone()[0]  # type: ignore[index]

            # ── Step 2: create _Test FE League tenant, player, and user ──
            cur.execute("INSERT INTO tenants (name) VALUES ('_Test FE League') RETURNING tenant_id")
            tenant_id = cur.fetchone()[0]  # type: ignore[index]

            cur.execute("""
                INSERT INTO players (tenant_id, pigeon_number, pigeon_name)
                VALUES (%s, 1, '_TestFE')
                RETURNING player_id
            """, (tenant_id,))
            player_id = cur.fetchone()[0]  # type: ignore[index]

            pw_hash = _bcrypt.hash("testpass")
            cur.execute(
                "INSERT INTO users (email, password_hash) VALUES ('_testfe@example.com', %s) RETURNING user_id",
                (pw_hash,),
            )
            user_id = cur.fetchone()[0]  # type: ignore[index]

            cur.execute(
                "INSERT INTO user_players (user_id, player_id, role) VALUES (%s, %s, 'owner')",
                (user_id, player_id),
            )
            cur.execute("""
                INSERT INTO tenant_members (tenant_id, user_id, role, primary_player_id)
                VALUES (%s, %s, 'commissioner', %s)
            """, (tenant_id, user_id, player_id))

            # ── Step 3: lock times for test tenant ──
            # Insert all 18 weeks so pick submission works for any week the form shows.
            # Scored weeks (except submission_week) get progressive past lock_at so that
            # get_current_week ORDER BY lock_at DESC returns a deterministic max week.
            # submission_week and all other weeks get a far-future lock_at (unlocked).
            for wk in range(1, 19):
                if wk in scored_weeks and wk != submission_week:
                    cur.execute("""
                        INSERT INTO tenant_weeks (tenant_id, week_number, lock_at)
                        VALUES (%s, %s, '2020-01-01 00:00:00+00'::timestamptz + (%s || ' days')::interval)
                    """, (tenant_id, wk, wk))
                else:
                    cur.execute("""
                        INSERT INTO tenant_weeks (tenant_id, week_number, lock_at)
                        VALUES (%s, %s, '2099-01-01 00:00:00+00')
                    """, (tenant_id, wk))

            # ── Step 4: snapshot token — commissioner of the real pool (tenant 1) ──
            cur.execute("""
                SELECT u.user_id, p.player_id, u.email, tm.tenant_id
                  FROM users u
                  JOIN tenant_members tm ON tm.user_id = u.user_id
                  JOIN players p ON p.player_id = tm.primary_player_id
                 WHERE tm.role = 'commissioner'
                   AND tm.tenant_id NOT IN (
                       SELECT tenant_id FROM tenants WHERE name LIKE '\\_Test%'
                   )
                 ORDER BY tm.tenant_id, u.user_id
                 LIMIT 1
            """)
            snap_row = cur.fetchone()

        conn.commit()

    # Mint tokens
    test_token, _exp = make_session_token(player_id, tenant_id, "_testfe@example.com", uid=user_id)

    snap_token = None
    snap_tenant_id = None
    if snap_row:
        s_uid, s_pid, s_email, s_tid = snap_row
        snap_token, _exp = make_session_token(s_pid, s_tid, s_email, uid=s_uid)
        snap_tenant_id = s_tid

    state = {
        "has_real_games": has_real_games,
        "test": {
            "tenant_id": tenant_id,
            "player_id": player_id,
            "user_id": user_id,
            "user_email": "_testfe@example.com",
            "user_password": "testpass",
            "auth_token": test_token,
            "scored_game_ids": [r[0] for r in scored_rows],
            "scored_week": scored_week,
            "submission_game_id": submission_gid,
            "submission_week": submission_week,
            "synthetic_game_ids": synthetic_ids,
        },
        "snapshot": {
            "tenant_id": snap_tenant_id,
            "auth_token": snap_token,
            "scored_week": scored_week,
        },
    }

    os.makedirs("playwright", exist_ok=True)
    state_path = os.path.join("playwright", ".test-state.json")
    with open(state_path, "w", encoding="utf-8") as f:
        json.dump(state, f, indent=2)

    print(f"[cli] FE test fixtures ready: tenant_id={tenant_id}, has_real_games={has_real_games}")
    print(f"[cli]   Test state -> {state_path}")
    return 0


def cmd_teardown_fe_tests(_: argparse.Namespace) -> int:
    """
    Remove all fixtures created by setup-fe-tests. Reads playwright/.test-state.json
    to identify synthetic games and the test tenant to delete.
    """
    state_path = os.path.join("playwright", ".test-state.json")
    if not os.path.exists(state_path):
        print(f"[cli] No test state file at {state_path} — nothing to clean up.")
        return 0

    with open(state_path, encoding="utf-8") as f:
        state = json.load(f)

    settings = get_settings()
    cfg = settings.psycopg_kwargs()
    synthetic = state.get("test", {}).get("synthetic_game_ids", [])

    with get_connection(cfg) as conn:
        with conn.cursor() as cur:
            if synthetic:
                cur.execute("DELETE FROM games WHERE game_id = ANY(%s)", (synthetic,))
            # Cascade deletes players, picks, user_players, tenant_members, tenant_weeks.
            cur.execute("DELETE FROM tenants WHERE name = '_Test FE League'")
            cur.execute("DELETE FROM users WHERE email = '_testfe@example.com'")
        conn.commit()

    os.remove(state_path)
    print("[cli] FE test fixtures cleaned up.")
    return 0


async def cmd_show_email_recipients(args: argparse.Namespace) -> int:
    """
    Show who would receive emails for a given email job, broken down per tenant.
    Sun/Mon: all tenant members. Tue: only members with missing picks for the next week.
    """
    which = args.which
    if which not in ("sun", "mon", "tue"):
        print("error: --which must be one of: sun | mon | tue")
        return 2

    async with AsyncSessionLocal() as session:
        tenants_res = await session.execute(
            text("SELECT tenant_id, name FROM tenants ORDER BY tenant_id")
        )
        tenants = [(r[0], r[1]) for r in tenants_res.fetchall()]
        grand_total = 0

        for tenant_id, tenant_name in tenants:
            print(f"\n[{tenant_name}] (tenant_id={tenant_id})")
            emails: list[str] = []

            if which in ("sun", "mon"):
                rows = await session.execute(text("""
                    SELECT DISTINCT lower(u.email)
                      FROM tenant_members tm
                      JOIN users u ON u.user_id = tm.user_id
                     WHERE tm.tenant_id = :tid
                       AND u.email IS NOT NULL AND u.email != ''
                     ORDER BY 1
                """), {"tid": tenant_id})
                emails = [r[0] for r in rows.fetchall() if r[0]]
            else:  # tue
                rows = await session.execute(text("""
                    WITH next_week AS (
                        SELECT MIN(week_number) AS w
                          FROM tenant_weeks
                         WHERE tenant_id = :tid AND lock_at > now()
                    )
                    SELECT DISTINCT f.player_id
                      FROM v_picks_filled f
                      JOIN games g ON g.game_id = f.game_id
                     WHERE f.is_made = FALSE
                       AND f.tenant_id = :tid
                       AND g.week_number = (SELECT w FROM next_week)
                """), {"tid": tenant_id})
                player_ids = [r[0] for r in rows.fetchall()]
                emails = await get_all_player_emails(session, player_ids)

            for e in emails:
                print(f"  - {e}")
            print(f"  Subtotal: {len(emails)}")
            grand_total += len(emails)

        print(f"\n[cli] {which} total recipients across all tenants: {grand_total}")
    return 0

# -----------------------------------------------------------------------------
# Parser / Main
# -----------------------------------------------------------------------------
def _validated_week(week: int) -> int:
    """Ensure week is within 1..18."""
    if not 1 <= week <= 18:
        raise SystemExit(f"error: week must be between 1 and 18, got {week}")
    return week


def build_parser() -> argparse.ArgumentParser:
    """
    Construct the top-level argument parser and subcommands.
    """
    parser = _HelpOnErrorParser(
        prog="pigeon-backend-cli",
        description="Pigeon Pool backend command-line utilities",
    )
    sub = parser.add_subparsers(dest="command")

    # sync-schedule
    p_schedule = sub.add_parser(
        "sync-schedule",
        help="Populate/refresh the current season's NFL schedule into the database.",
        description="Populate/refresh the current season's NFL schedule (weeks 1–18) via ScoreSync.load_schedule().",
    )
    p_schedule.set_defaults(func=cmd_load_schedule)

    # sync-scores
    p_sync = sub.add_parser(
        "sync-scores",
        help="Update scores & status for the given week.",
        description="Calls ScoreSync.sync_scores_and_status(week) to update scores/status.",
    )
    p_sync.add_argument("week", type=int, help="Week number (1–18)")
    p_sync.set_defaults(func=cmd_sync_scores)

    # sync-kickoffs
    p_kickoffs = sub.add_parser(
        "sync-kickoffs",
        help="Refresh kickoff times for the given week.",
        description="Calls ScoreSync.refresh_kickoffs(week) to update kickoff_at fields.",
    )
    p_kickoffs.add_argument("week", type=int, help="Week number (1–18)")
    p_kickoffs.set_defaults(func=cmd_sync_kickoffs)

    # reset-season
    p_reset = sub.add_parser(
        "reset-season",
        help="Archive picks, wipe games/picks, reset season status, sync new schedule.",
        description=(
            "Archives all picks to CSV (archive/<tid>_<year>_picks.csv), deletes all games "
            "(cascading picks) and tenant_weeks, resets players.season_status to 'pending', "
            "then syncs the new season's schedule and re-seeds lock times."
        ),
    )
    p_reset.add_argument("--year", type=int, default=None,
                         help="Season year to embed in archive filenames (auto-detected if omitted)")
    p_reset.add_argument("--yes", action="store_true", help="Skip interactive confirmation")
    p_reset.set_defaults(func=cmd_reset_season)

    # import-picks-xlsx
    p_imp_pivot = sub.add_parser(
        "import-picks-xlsx",
        help="Import legacy picks from an Excel workbook (players + picks).",
        description="Reads sheets titled like 'picks wk N' (row1 names, row2 numbers; team rows in pairs) and upserts players/picks.",
    )
    p_imp_pivot.add_argument("path", help="Path to .xlsx workbook")
    group = p_imp_pivot.add_mutually_exclusive_group()
    group.add_argument("--week", type=int, help="Import only a single week (1–18)")
    group.add_argument("--max-week", type=int, help="Highest week to import")
    p_imp_pivot.set_defaults(func=cmd_import_picks_xlsx)

    # run-job
    p_run_job = sub.add_parser(
        "run-job",
        help="Run a scheduler job immediately (bypasses time gates/predicates).",
        description="Execute one of: kickoff_sync | score_sync | email_sun | email_mon | email_tue_warn.",
    )
    p_run_job.add_argument(
        "job",
        choices=["kickoff_sync","score_sync","email_sun","email_mon","email_tue_warn"],
        help="Job name to run now",
    )
    p_run_job.add_argument("--mark", action="store_true", help="Update scheduler_runs.last_at after success")
    p_run_job.add_argument("--dry-run", action="store_true",
                           help="Set EMAIL_DRY_RUN=true for this invocation (logs recipients, no send)")
    p_run_job.set_defaults(func=cmd_run_job)

    # list-leagues
    p_list = sub.add_parser(
        "list-leagues",
        help="Show all leagues (tenants) with member and player counts.",
    )
    p_list.set_defaults(func=cmd_list_leagues)

    # create-league
    p_create = sub.add_parser(
        "create-league",
        help="Create a new league and assign a commissioner.",
        description=(
            "Creates a tenant, a placeholder player, and adds the commissioner. "
            "The commissioner must already have a user account. "
            "Default lock times are copied from weeks.default_lock_at if available."
        ),
    )
    p_create.add_argument("--name", required=True, help="League name")
    p_create.add_argument("--commissioner-email", required=True, metavar="EMAIL",
                          help="Email of an existing user to make commissioner")
    p_create.set_defaults(func=cmd_create_league)

    # delete-league
    p_delete = sub.add_parser(
        "delete-league",
        help="Permanently delete a league and all its data.",
        description=(
            "Deletes the tenant, all players, all picks, and all lock times for that league. "
            "Users who belong only to this league are also deleted. Irreversible."
        ),
    )
    p_delete.add_argument("tenant_id", type=int, help="tenant_id to delete (see list-leagues)")
    p_delete.add_argument("--yes", action="store_true", help="Skip interactive confirmation")
    p_delete.set_defaults(func=cmd_delete_league)

    # run-sql
    p_run_sql = sub.add_parser(
        "run-sql",
        help="Execute a SQL file against the configured database (for migrations).",
        description="Reads a .sql file and executes it in a single transaction using the app DB connection.",
    )
    p_run_sql.add_argument("path", help="Path to .sql file")
    p_run_sql.set_defaults(func=cmd_run_sql)

    # setup-fe-tests
    p_setup_fe = sub.add_parser(
        "setup-fe-tests",
        help="Create Playwright FE test fixtures and write playwright/.test-state.json.",
    )
    p_setup_fe.set_defaults(func=cmd_setup_fe_tests)

    # teardown-fe-tests
    p_teardown_fe = sub.add_parser(
        "teardown-fe-tests",
        help="Remove FE test fixtures created by setup-fe-tests.",
    )
    p_teardown_fe.set_defaults(func=cmd_teardown_fe_tests)

    # show-email-recipients
    p_recip = sub.add_parser(
        "show-email-recipients",
        help="List who would receive an email for Sun/Mon/Tue flows.",
        description="Inspect recipient selection without sending mail.",
    )
    p_recip.add_argument("--which", required=True, choices=["sun","mon","tue"],
                         help="Email flow: Sunday interim (sun), Monday wrap (mon), Tuesday warn (tue)")
    p_recip.set_defaults(func=cmd_show_email_recipients)

    return parser


def main(argv: list[str] | None = None) -> int:
    """
    CLI entry point.
    """
    parser = build_parser()
    args = parser.parse_args(argv)
    if not getattr(args, "func", None):
        parser.print_help()
        return 2
    func = args.func
    if asyncio.iscoroutinefunction(func):
        return asyncio.run(func(args))
    else:
        return func(args)


if __name__ == "__main__":
    raise SystemExit(main())
