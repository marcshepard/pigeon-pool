"""
ScoreSync: populate schedule, sync scores/status, refresh kickoffs
for the current NFL season using ESPN's public scoreboard endpoint.

This file intentionally keeps things simple:
- Single class with three methods (load_schedule, sync_scores_and_status, refresh_kickoffs)
- Current-season only (no season column in DB)
- Synchronous DB access via a psycopg-style connection
- No provider abstraction layer; if you switch providers later, just rewrite here
"""
# pylint: disable=line-too-long

from __future__ import annotations
from datetime import datetime, timezone, timedelta
from zoneinfo import ZoneInfo
from typing import Any, Optional
import requests

PT = ZoneInfo("America/Los_Angeles")

def _calc_lock_at_pacific(kickoffs_utc: list[datetime]) -> datetime:
    """
    Lock time policy: Wednesday 23:59:59 PT *before* the earliest game of that week.
    Returns a tz-aware UTC datetime suitable for storing in weeks.lock_at.
    """
    earliest_pt = min(kickoffs_utc).astimezone(PT)
    # weekday(): Mon=0 .. Sun=6 ; Wed=2
    days_since_wed = (earliest_pt.weekday() - 2) % 7
    if days_since_wed == 0:
        # If earliest is on Wednesday, lock is the previous Wednesday
        days_since_wed = 7
    lock_wed_pt = (earliest_pt - timedelta(days=days_since_wed)).replace(
        hour=23, minute=59, second=59, microsecond=0
    )
    return lock_wed_pt.astimezone(timezone.utc)

class ScoreSync:
    """Tiny sync class; one instance per DB connection is fine."""

    def __init__(self, connection: Any) -> None:
        """
        Args:
            connection: psycopg2/psycopg3-style connection object (has .cursor(), .commit()).
        """
        self.conn = connection

    # -------------------------------------------------------------------------
    # Public API
    # -------------------------------------------------------------------------

    def load_schedule(self) -> int:
        """
        Populate/refresh the current season’s schedule for weeks 1–18.

        Behavior:
        - Upserts `weeks` first (computes lock_at from earliest kickoff each week).
        - Upserts `teams` (home/away) to satisfy FK.
        - Upserts `games` by (week_number, home_abbr, away_abbr), sets espn_event_id,
        updates kickoff_at on change. Scores remain NULL and status 'scheduled'.
        Returns:
            Total number of game rows inserted or updated across all weeks.
        """
        season = _current_nfl_season_year()
        total_changed = 0

        for week in range(1, 19):
            sb = _fetch_scoreboard(season=season, week=week)
            events = sb.get("events", []) or []
            if not events:
                continue

            # --- upsert the week first (compute lock_at from earliest kickoff) ---
            kickoffs = [_parse_event_kickoff(ev) for ev in events]
            lock_at_utc = _calc_lock_at_pacific(kickoffs)
            with self.conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO weeks (week_number, lock_at)
                    VALUES (%s, %s)
                    ON CONFLICT (week_number)
                    DO UPDATE SET lock_at = EXCLUDED.lock_at
                    """,
                    (week, lock_at_utc),
                )

            # --- then teams + games ---
            for ev in events:
                event_id = int(ev["id"])
                kickoff_at = _parse_event_kickoff(ev)
                home_abbr, home_name, away_abbr, away_name = _parse_team_abbrs_and_names(ev)

                # Teams
                self._upsert_team(abbr=home_abbr, name=home_name)
                self._upsert_team(abbr=away_abbr, name=away_name)

                # Game row
                changed = self._upsert_game_schedule_row(
                    week_number=week,
                    kickoff_at=kickoff_at,
                    home_abbr=home_abbr,
                    away_abbr=away_abbr,
                    espn_event_id=event_id,
                )
                if changed:
                    total_changed += 1

        self.conn.commit()
        return total_changed

    def sync_scores_and_status(self, week: int) -> int:
        """
        For the given week, pull scores/status from ESPN and update matching games.

        Behavior:
        - Fetch ESPN scoreboard for (current season, given week)
        - Prefer match by espn_event_id; if missing, fall back to (week, home, away)
        - Update: home_score, away_score, status ('scheduled'|'in_progress'|'final')
        - Only writes when something actually changed (uses IS DISTINCT FROM)
        Returns:
            Number of games updated (includes those that became 'final').
        Raises:
            httpx.HTTPError or database exceptions on failure.
        """
        season = _current_nfl_season_year()
        sb = _fetch_scoreboard(season=season, week=week)
        updated_count = 0

        for ev in sb.get("events", []):
            event_id = int(ev["id"])
            status, home_score, away_score = _map_scores_and_status(ev)
            home_abbr, _, away_abbr, _ = _parse_team_abbrs_and_names(ev)

            # First try by espn_event_id
            rows = self._update_scores_by_event_id(
                espn_event_id=event_id,
                home_score=home_score,
                away_score=away_score,
                status=status,
            )
            if rows == 0:
                # Fallback to (week, home, away) if event id not set yet
                rows = self._update_scores_by_triplet(
                    week_number=week,
                    home_abbr=home_abbr,
                    away_abbr=away_abbr,
                    home_score=home_score,
                    away_score=away_score,
                    status=status,
                    espn_event_id=event_id,  # also set it if row matched
                )
            updated_count += rows

        self.conn.commit()
        return updated_count

    def refresh_kickoffs(self, week: int) -> int:
        """
        For the given week, fetch schedule and update kickoff_at for any game that differs.

        Behavior:
        - Fetch ESPN scoreboard for (current season, given week)
        - Prefer match by espn_event_id; otherwise fall back to (week, home, away)
        - If kickoff_at differs (exact inequality), update it
        Returns:
            Number of games whose kickoff_at was updated.
        Raises:
            httpx.HTTPError or database exceptions on failure.
        """
        season = _current_nfl_season_year()
        sb = _fetch_scoreboard(season=season, week=week)
        updates = 0

        for ev in sb.get("events", []):
            event_id = int(ev["id"])
            new_kick = _parse_event_kickoff(ev)
            home_abbr, _, away_abbr, _ = _parse_team_abbrs_and_names(ev)

            # Try by event id first
            rows = self._update_kickoff_by_event_id(espn_event_id=event_id, new_kickoff=new_kick)
            if rows == 0:
                # Fallback to (week, home, away)
                rows = self._update_kickoff_by_triplet(
                    week_number=week, home_abbr=home_abbr, away_abbr=away_abbr, new_kickoff=new_kick, espn_event_id=event_id
                )
            updates += rows

        self.conn.commit()
        return updates

    # -------------------------------------------------------------------------
    # Private DB helpers (raw SQL; psycopg-style)
    # -------------------------------------------------------------------------

    def _upsert_team(self, *, abbr: str, name: str) -> None:
        with self.conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO teams (abbr, name)
                VALUES (%s, %s)
                ON CONFLICT (abbr)
                DO UPDATE SET name = EXCLUDED.name
                """,
                (abbr, name),
            )

    def _upsert_game_schedule_row(
        self,
        *,
        week_number: int,
        kickoff_at: datetime,
        home_abbr: str,
        away_abbr: str,
        espn_event_id: int,
    ) -> int:
        # Upsert by (week_number, home_abbr, away_abbr); set event id if missing
        with self.conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO games (
                    week_number, kickoff_at, home_abbr, away_abbr, status, home_score, away_score, espn_event_id
                )
                VALUES (%s, %s, %s, %s, 'scheduled', NULL, NULL, %s)
                ON CONFLICT (week_number, home_abbr, away_abbr)
                DO UPDATE SET
                    kickoff_at    = EXCLUDED.kickoff_at,
                    espn_event_id = COALESCE(games.espn_event_id, EXCLUDED.espn_event_id),
                    updated_at    = now()
                """,
                (week_number, kickoff_at, home_abbr, away_abbr, espn_event_id),
            )
            # rowcount is 1 for both insert and update here
            return cur.rowcount

    def _update_scores_by_event_id(
        self,
        *,
        espn_event_id: int,
        home_score: Optional[int],
        away_score: Optional[int],
        status: str,
    ) -> int:
        with self.conn.cursor() as cur:
            cur.execute(
                """
                UPDATE games
                SET
                    home_score = %s,
                    away_score = %s,
                    status     = %s,
                    updated_at = now()
                WHERE espn_event_id = %s
                  AND (
                    home_score IS DISTINCT FROM %s OR
                    away_score IS DISTINCT FROM %s OR
                    status     IS DISTINCT FROM %s
                  )
                """,
                (home_score, away_score, status, espn_event_id, home_score, away_score, status),
            )
            return cur.rowcount

    def _update_scores_by_triplet(
        self,
        *,
        week_number: int,
        home_abbr: str,
        away_abbr: str,
        home_score: Optional[int],
        away_score: Optional[int],
        status: str,
        espn_event_id: int,
    ) -> int:
        with self.conn.cursor() as cur:
            cur.execute(
                """
                UPDATE games
                SET
                    home_score    = %s,
                    away_score    = %s,
                    status        = %s,
                    espn_event_id = COALESCE(espn_event_id, %s),
                    updated_at    = now()
                WHERE week_number = %s
                  AND home_abbr = %s
                  AND away_abbr = %s
                  AND (
                    home_score IS DISTINCT FROM %s OR
                    away_score IS DISTINCT FROM %s OR
                    status     IS DISTINCT FROM %s OR
                    espn_event_id IS NULL
                  )
                """,
                (
                    home_score,
                    away_score,
                    status,
                    espn_event_id,
                    week_number,
                    home_abbr,
                    away_abbr,
                    home_score,
                    away_score,
                    status,
                ),
            )
            return cur.rowcount

    def _update_kickoff_by_event_id(self, *, espn_event_id: int, new_kickoff: datetime) -> int:
        with self.conn.cursor() as cur:
            cur.execute(
                """
                UPDATE games
                SET kickoff_at = %s,
                    updated_at = now()
                WHERE espn_event_id = %s
                  AND kickoff_at IS DISTINCT FROM %s
                """,
                (new_kickoff, espn_event_id, new_kickoff),
            )
            return cur.rowcount

    def _update_kickoff_by_triplet(
        self,
        *,
        week_number: int,
        home_abbr: str,
        away_abbr: str,
        new_kickoff: datetime,
        espn_event_id: Optional[int] = None,
    ) -> int:
        with self.conn.cursor() as cur:
            cur.execute(
                """
                UPDATE games
                SET kickoff_at = %s,
                    espn_event_id = COALESCE(espn_event_id, %s),
                    updated_at = now()
                WHERE week_number = %s
                  AND home_abbr = %s
                  AND away_abbr = %s
                  AND kickoff_at IS DISTINCT FROM %s
                """,
                (new_kickoff, espn_event_id, week_number, home_abbr, away_abbr, new_kickoff),
            )
            return cur.rowcount


# -----------------------------------------------------------------------------
# Small HTTP/parse helpers (kept local and simple)
# -----------------------------------------------------------------------------

def _current_nfl_season_year() -> int:
    """
    Returns the calendar year to use for ESPN's `year` param.
    For a "current-year only" app, this simple rule is sufficient.
    """
    return datetime.now(timezone.utc).year


def _fetch_scoreboard(*, season: int, week: int) -> dict[str, Any]:
    """
    GET ESPN NFL scoreboard for given season+week (regular season `seasontype=2`).
    Adjust `seasontype` if you want preseason(1) or postseason(3) later.
    """
    url = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard"
    params = {"year": season, "week": week, "seasontype": 2}
    with requests.Session() as session:
        resp = session.get(url, params=params, timeout=15)
        resp.raise_for_status()
        return resp.json()


def _parse_event_kickoff(ev: dict[str, Any]) -> datetime:
    """
    ESPN event['date'] is ISO8601, often ending with 'Z' for UTC.
    Convert to tz-aware datetime in UTC.
    """
    iso = ev["date"]
    # Ensure tz-aware (replace trailing 'Z' with '+00:00' for fromisoformat)
    if iso.endswith("Z"):
        iso = iso.replace("Z", "+00:00")
    dt = datetime.fromisoformat(iso)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _parse_team_abbrs_and_names(ev: dict[str, Any]) -> tuple[str, str, str, str]:
    """
    Returns (home_abbr, home_name, away_abbr, away_name)
    """
    comp = ev["competitions"][0]
    home = next(c for c in comp["competitors"] if c["homeAway"] == "home")
    away = next(c for c in comp["competitors"] if c["homeAway"] == "away")
    home_abbr = home["team"]["abbreviation"]
    home_name = home["team"]["displayName"]
    away_abbr = away["team"]["abbreviation"]
    away_name = away["team"]["displayName"]
    return home_abbr, home_name, away_abbr, away_name


def _map_scores_and_status(ev: dict[str, Any]) -> tuple[str, Optional[int], Optional[int]]:
    """
    Map ESPN statuses to your 3-state model and extract integer scores (if present).
    ESPN status types: ev['status']['type']['state'] in {'pre','in','post'}.
    """
    comp = ev["competitions"][0]
    state = ev["status"]["type"]["state"]

    if state == "pre":
        status = "scheduled"
    elif state == "post":
        status = "final"
    else:
        status = "in_progress"

    home = next(c for c in comp["competitors"] if c["homeAway"] == "home")
    away = next(c for c in comp["competitors"] if c["homeAway"] == "away")

    def _to_int_or_none(v: Any) -> Optional[int]:
        return int(v) if v is not None else None

    home_score = _to_int_or_none(home.get("score"))
    away_score = _to_int_or_none(away.get("score"))
    return status, home_score, away_score
