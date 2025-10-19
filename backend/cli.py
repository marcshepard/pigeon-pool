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
from typing import Any, Dict

import asyncio
import psycopg
from backend.utils.db import AsyncSessionLocal

from backend.utils.score_sync import ScoreSync
from backend.utils.settings import get_settings
from .import_picks_xlsx import import_picks_pivot_xlsx


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
def cmd_load_schedule(_: argparse.Namespace) -> int:
    """
    Populate/refresh the current season's schedule (weeks 1–18).
    Uses get_settings() for env+DB config.
    """
    settings = get_settings()
    cfg = settings.psycopg_kwargs()
    print(f"[cli] DB → {cfg['user']}@{cfg['host']}:{cfg['port']}/{cfg['dbname']} (env via utils.settings)")
    with get_connection(cfg) as conn:
        sync = ScoreSync(conn)
        changed = sync.load_schedule()
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
