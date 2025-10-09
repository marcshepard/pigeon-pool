# backend/cli.py
"""
Command-line tools for the Pigeon Pool backend.

Commands:
- load-schedule: Populate/refresh the current season's NFL schedule via ScoreSync.
"""
# pylint: disable=line-too-long

from __future__ import annotations

import argparse
from typing import Dict, Any

import psycopg
from psycopg import Connection

from backend.utils.settings import get_settings
from backend.utils.score_sync import ScoreSync

class _HelpOnErrorParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        self.print_help()
        self.exit(2, f"\nerror: {message}\n")


def get_connection(cfg: Dict[str, Any]) -> Connection:
    """Open a psycopg v3 connection and set session TZ to UTC."""
    conn: Connection = psycopg.connect(**cfg)
    # psycopg v3 supports executing directly on the connection
    conn.execute("SET TIME ZONE 'UTC';")  #pylint: disable=no-member
    return conn


def cmd_load_schedule(_: argparse.Namespace) -> int:
    """
    Populate/refresh the current season's schedule (weeks 1–18).
    Uses get_settings() for env+DB config.
    """
    settings = get_settings()  # <-- loads .env chain using APP_ENV/ENV
    cfg = settings.psycopg_kwargs()
    print(f"[cli] DB → {cfg['user']}@{cfg['host']}:{cfg['port']}/{cfg['dbname']} (env via utils.settings)")

    with get_connection(cfg) as conn:
        sync = ScoreSync(conn)
        changed = sync.load_schedule()
        print(f"[cli] load-schedule: upserted {changed} game rows.")
    return 0


def build_parser() -> argparse.ArgumentParser:
    """ Build the top-level argument parser and subparsers. """
    parser = _HelpOnErrorParser(
        prog="pigeon-backend-cli",
        description="Pigeon Pool backend command-line utilities",
    )
    sub = parser.add_subparsers(dest="command")

    p_load = sub.add_parser(
        "load-schedule",
        help="Populate/refresh the current season's NFL schedule into the database.",
        description="Populate/refresh the current season's NFL schedule (weeks 1–18) via ScoreSync.load_schedule().",
    )
    p_load.set_defaults(func=cmd_load_schedule)

    return parser


def main(argv: list[str] | None = None) -> int:
    """ Main entry point for the CLI. """
    parser = build_parser()
    # Let argparse read sys.argv[1:] when argv is None
    args = parser.parse_args(argv)
    if not getattr(args, "func", None):
        parser.print_help()
        return 2
    return args.func(args)

if __name__ == "__main__":
    raise SystemExit(main())
