"""
Command-line tools for the Pigeon Pool backend.

Commands:
- sync-schedule  : Populate the current season's NFL schedule (weeks 1–18), called once
- sync-scores    : Update scores & status for a specific week, called while games are live
- sync-kickoffs  : Refresh kickoff times for a specific week, called infrequently
- -help          : Show help/usage

Example usage:
- python -m backend.cli sync-schedule
- python -m backend.cli sync-scores 6
- python -m backend.cli sync-kickoffs 6
- python -m backend.cli import-picks-xlsx C:/path/to/picks.xlsx --week 6
- python -m backend.cli import-picks-xlsx C:/path/to/picks.xlsx --max-week 6
"""
# pylint: disable=line-too-long

from __future__ import annotations

import argparse
import os
from typing import Any, Dict, Callable, Awaitable
import asyncio

import psycopg
from sqlalchemy import text

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
    def error(self, message: str) -> None:
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
    print(f"[cli] import-pivot-xlsx → {cfg['user']}@{cfg['host']}:{cfg['port']}/{cfg['dbname']}")

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
            print(f"[cli] ✅ Pivot import complete. Processed {processed} player-pick cells.")
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

async def cmd_show_email_recipients(args: argparse.Namespace) -> int:
    """
    Show who would receive emails for a given email job path.
    For Tue warn we show the targeted subset; for Sun/Mon we show all mapped users.
    """
    which = args.which
    async with AsyncSessionLocal() as session:
        emails: list[str] = []
        if which in ("sun", "mon"):
            emails = await get_all_player_emails(session)
        elif which == "tue":
            # Reuse the same selection logic as the job itself
            q = text("""
            WITH next_week AS (SELECT MIN(week_number) AS w FROM weeks WHERE lock_at > now())
            SELECT DISTINCT pl.pigeon_number
            FROM v_picks_filled f
            JOIN players pl ON pl.pigeon_number = f.pigeon_number
            JOIN games g ON g.game_id = f.game_id
            WHERE f.is_made = FALSE
              AND g.week_number = (SELECT w FROM next_week)
            ORDER BY pl.pigeon_number
            """)
            rows = await session.execute(q)
            pigeon_numbers = [r[0] for r in rows]
            emails = await get_all_player_emails(session, pigeon_numbers)
        else:
            print("error: --which must be one of: sun | mon | tue")
            return 2

        print(f"[cli] {which} recipients: {len(emails)}")
        for e in emails:
            print(f"  - {e}")
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
