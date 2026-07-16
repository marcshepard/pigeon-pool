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
from datetime import date, datetime, timezone, timedelta
from zoneinfo import ZoneInfo
from typing import Any, Optional
import httpx
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import text

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
    """Tiny async sync class; one instance per DB session is fine."""

    def __init__(self, session: AsyncSession) -> None:
        """
        Args:
            session: SQLAlchemy AsyncSession object.
        """
        self.session = session

    # -------------------------------------------------------------------------
    # Public API
    # -------------------------------------------------------------------------

    async def load_schedule(self) -> int:
        """
        Populate/refresh the current season’s schedule for weeks 1–18.

        Behavior:
        - Fetches the regular-season week-by-week date ranges from ESPN's calendar
          (see module docstring note on `_fetch_scoreboard`'s `dates=` param) and
          fetches each week's games by date range rather than by `week=` number.
        - Upserts `weeks` first (computes lock_at from earliest kickoff each week).
        - Upserts `teams` (home/away) to satisfy FK.
        - Upserts `games` by (week_number, home_abbr, away_abbr), sets espn_event_id,
        updates kickoff_at on change. Scores remain NULL and status 'scheduled'.
        Returns:
            Total number of game rows inserted or updated across all weeks.
        """
        calendar = await _fetch_current_calendar()
        week_ranges = _calendar_week_ranges(calendar, REGULAR_SEASON_TYPE)
        total_changed = 0

        for week in sorted(week_ranges):
            start_dt, end_dt = week_ranges[week]
            sb = await _fetch_scoreboard(dates=_dates_param(start_dt.date(), end_dt.date()))
            # ESPN's `dates=` filter isn't exact — it can include a game from just
            # outside the requested range (observed around week boundaries), which
            # would otherwise get inserted under two different weeks and collide on
            # the games.espn_event_id unique constraint. Re-filter to the calendar's
            # precise window.
            events = [
                ev for ev in (sb.get("events", []) or [])
                if start_dt <= _parse_event_kickoff(ev) <= end_dt
            ]
            if not events:
                continue

            # --- upsert the week first (compute lock_at from earliest kickoff) ---
            kickoffs = [_parse_event_kickoff(ev) for ev in events]
            lock_at_utc = _calc_lock_at_pacific(kickoffs)
            # Write to default_lock_at (global template). Each tenant activates
            # their own season via POST /admin/activate-season, which copies
            # default_lock_at into tenant_weeks. Do NOT write tenant_weeks here.
            await self.session.execute(
                text("""
                    INSERT INTO weeks (week_number, default_lock_at)
                    VALUES (:week, :lock_at)
                    ON CONFLICT (week_number)
                    DO UPDATE SET default_lock_at = EXCLUDED.default_lock_at
                """),
                {"week": week, "lock_at": lock_at_utc},
            )

            # --- then teams + games ---
            for ev in events:
                event_id = int(ev["id"])
                kickoff_at = _parse_event_kickoff(ev)
                home_abbr, home_name, away_abbr, away_name = _parse_team_abbrs_and_names(ev)

                # Teams
                await self._upsert_team(abbr=home_abbr, name=home_name)
                await self._upsert_team(abbr=away_abbr, name=away_name)

                # Game row
                changed = await self._upsert_game_schedule_row(
                    week_number=week,
                    kickoff_at=kickoff_at,
                    home_abbr=home_abbr,
                    away_abbr=away_abbr,
                    espn_event_id=event_id,
                )
                if changed:
                    total_changed += 1

        await self.session.commit()
        return total_changed

    async def sync_scores_and_status(self, week: int) -> int:
        """
        For the given week, pull scores/status from ESPN and update matching games.

        Behavior:
        - Fetch ESPN scoreboard by date range, derived from this week's existing
          kickoff_at values in the DB (padded a day either side).
        - Prefer match by espn_event_id; if missing, fall back to (week, home, away)
        - Update: home_score, away_score, status ('scheduled'|'in_progress'|'final')
        - Only writes when something actually changed (uses IS DISTINCT FROM)
        Returns:
            Number of games updated (includes those that became 'final'). 0 if the
            week has no games loaded yet.
        Raises:
            httpx.HTTPError or database exceptions on failure.
        """
        bounds = await self._week_kickoff_bounds(week)
        if bounds is None:
            return 0
        start_date, end_date = _pad_date_range(*bounds)
        sb = await _fetch_scoreboard(dates=_dates_param(start_date, end_date))
        updated_count = 0

        for ev in sb.get("events", []):
            event_id = int(ev["id"])
            status, home_score, away_score = _map_scores_and_status(ev)
            home_abbr, _, away_abbr, _ = _parse_team_abbrs_and_names(ev)

            # First try by espn_event_id
            rows = await self._update_scores_by_event_id(
                espn_event_id=event_id,
                home_score=home_score,
                away_score=away_score,
                status=status,
            )
            if rows == 0:
                # Fallback to (week, home, away) if event id not set yet
                rows = await self._update_scores_by_triplet(
                    week_number=week,
                    home_abbr=home_abbr,
                    away_abbr=away_abbr,
                    home_score=home_score,
                    away_score=away_score,
                    status=status,
                    espn_event_id=event_id,  # also set it if row matched
                )
            updated_count += rows

        await self.session.commit()
        return updated_count

    async def refresh_kickoffs(self, week: int) -> int:
        """
        For the given week, fetch schedule and update kickoff_at for any game that differs.

        Behavior:
        - Fetch ESPN scoreboard by date range, derived from this week's existing
          kickoff_at values in the DB (padded a day either side).
        - Prefer match by espn_event_id; otherwise fall back to (week, home, away)
        - If kickoff_at differs (exact inequality), update it
        Returns:
            Number of games whose kickoff_at was updated. 0 if the week has no
            games loaded yet.
        Raises:
            httpx.HTTPError or database exceptions on failure.
        """
        bounds = await self._week_kickoff_bounds(week)
        if bounds is None:
            return 0
        start_date, end_date = _pad_date_range(*bounds)
        sb = await _fetch_scoreboard(dates=_dates_param(start_date, end_date))
        updates = 0

        for ev in sb.get("events", []):
            event_id = int(ev["id"])
            new_kick = _parse_event_kickoff(ev)
            home_abbr, _, away_abbr, _ = _parse_team_abbrs_and_names(ev)

            # Try by event id first
            rows = await self._update_kickoff_by_event_id(espn_event_id=event_id, new_kickoff=new_kick)
            if rows == 0:
                # Fallback to (week, home, away)
                rows = await self._update_kickoff_by_triplet(
                    week_number=week, home_abbr=home_abbr, away_abbr=away_abbr, new_kickoff=new_kick, espn_event_id=event_id
                )
            updates += rows

        await self.session.commit()
        return updates

    # -------------------------------------------------------------------------
    # Private DB helpers (raw SQL; psycopg-style)
    # -------------------------------------------------------------------------

    async def _week_kickoff_bounds(self, week_number: int) -> Optional[tuple[datetime, datetime]]:
        """Return (min_kickoff, max_kickoff) for a week's existing games, or None if none loaded yet."""
        result = await self.session.execute(
            text("SELECT MIN(kickoff_at), MAX(kickoff_at) FROM games WHERE week_number = :week"),
            {"week": week_number},
        )
        row = result.first()
        if not row or row[0] is None:
            return None
        return row[0], row[1]

    async def _upsert_team(self, *, abbr: str, name: str) -> None:
        await self.session.execute(
            text("""
                INSERT INTO teams (abbr, name)
                VALUES (:abbr, :name)
                ON CONFLICT (abbr)
                DO UPDATE SET name = EXCLUDED.name
            """),
            {"abbr": abbr, "name": name},
        )

    async def _upsert_game_schedule_row(
        self,
        *,
        week_number: int,
        kickoff_at: datetime,
        home_abbr: str,
        away_abbr: str,
        espn_event_id: int,
    ) -> int:
        result = await self.session.execute(
            text("""
                INSERT INTO games (
                    week_number, kickoff_at, home_abbr, away_abbr, status, home_score, away_score, espn_event_id
                )
                VALUES (:week_number, :kickoff_at, :home_abbr, :away_abbr, 'scheduled', NULL, NULL, :espn_event_id)
                ON CONFLICT (week_number, home_abbr, away_abbr)
                DO UPDATE SET
                    kickoff_at    = EXCLUDED.kickoff_at,
                    espn_event_id = COALESCE(games.espn_event_id, EXCLUDED.espn_event_id),
                    updated_at    = now()
            """),
            {
                "week_number": week_number,
                "kickoff_at": kickoff_at,
                "home_abbr": home_abbr,
                "away_abbr": away_abbr,
                "espn_event_id": espn_event_id,
            },
        )
        return result.rowcount if hasattr(result, "rowcount") else 1

    async def _update_scores_by_event_id(
        self,
        *,
        espn_event_id: int,
        home_score: Optional[int],
        away_score: Optional[int],
        status: str,
    ) -> int:
        result = await self.session.execute(
            text("""
                UPDATE games
                SET
                    home_score = :home_score,
                    away_score = :away_score,
                    status     = :status,
                    updated_at = now()
                WHERE espn_event_id = :espn_event_id
                  AND (
                    home_score IS DISTINCT FROM :home_score OR
                    away_score IS DISTINCT FROM :away_score OR
                    status     IS DISTINCT FROM :status
                  )
            """),
            {
                "home_score": home_score,
                "away_score": away_score,
                "status": status,
                "espn_event_id": espn_event_id,
            },
        )
        return result.rowcount if hasattr(result, "rowcount") else 1

    async def _update_scores_by_triplet(
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
        result = await self.session.execute(
            text("""
                UPDATE games
                SET
                    home_score    = :home_score,
                    away_score    = :away_score,
                    status        = :status,
                    espn_event_id = COALESCE(espn_event_id, :espn_event_id),
                    updated_at    = now()
                WHERE week_number = :week_number
                  AND home_abbr = :home_abbr
                  AND away_abbr = :away_abbr
                  AND (
                    home_score IS DISTINCT FROM :home_score OR
                    away_score IS DISTINCT FROM :away_score OR
                    status     IS DISTINCT FROM :status OR
                    espn_event_id IS NULL
                  )
            """),
            {
                "home_score": home_score,
                "away_score": away_score,
                "status": status,
                "espn_event_id": espn_event_id,
                "week_number": week_number,
                "home_abbr": home_abbr,
                "away_abbr": away_abbr,
            },
        )
        return result.rowcount if hasattr(result, "rowcount") else 1

    async def _update_kickoff_by_event_id(self, *, espn_event_id: int, new_kickoff: datetime) -> int:
        result = await self.session.execute(
            text("""
                UPDATE games
                SET kickoff_at = :new_kickoff,
                    updated_at = now()
                WHERE espn_event_id = :espn_event_id
                  AND kickoff_at IS DISTINCT FROM :new_kickoff
            """),
            {"new_kickoff": new_kickoff, "espn_event_id": espn_event_id},
        )
        return result.rowcount if hasattr(result, "rowcount") else 1

    async def _update_kickoff_by_triplet(
        self,
        *,
        week_number: int,
        home_abbr: str,
        away_abbr: str,
        new_kickoff: datetime,
        espn_event_id: Optional[int] = None,
    ) -> int:
        result = await self.session.execute(
            text("""
                UPDATE games
                SET kickoff_at = :new_kickoff,
                    espn_event_id = COALESCE(espn_event_id, :espn_event_id),
                    updated_at = now()
                WHERE week_number = :week_number
                  AND home_abbr = :home_abbr
                  AND away_abbr = :away_abbr
                  AND kickoff_at IS DISTINCT FROM :new_kickoff
            """),
            {
                "new_kickoff": new_kickoff,
                "espn_event_id": espn_event_id,
                "week_number": week_number,
                "home_abbr": home_abbr,
                "away_abbr": away_abbr,
            },
        )
        return result.rowcount if hasattr(result, "rowcount") else 1


# -----------------------------------------------------------------------------
# Small HTTP/parse helpers (kept local and simple)
# -----------------------------------------------------------------------------
#
# NOTE on ESPN's `week=` param: it's unreliable for a season that hasn't started
# yet — passing `week=N` (with any `year=`/`seasontype=`) silently ignores `year`
# and resolves against whatever season ESPN currently considers "current", which
# lags behind until the new season is actually underway. Passing `dates=` instead
# is unaffected and always returns the correct games. So this module never sends
# `week=`: `load_schedule` reads per-week date ranges from ESPN's own `calendar`
# block, and `refresh_kickoffs`/`sync_scores_and_status` derive their date range
# from that week's already-loaded `kickoff_at` values in the DB.

REGULAR_SEASON_TYPE = "2"  # ESPN seasontype: 1=preseason, 2=regular, 3=postseason


def _parse_iso_utc(iso: str) -> datetime:
    """ESPN timestamps are ISO8601, often ending with 'Z' for UTC. Parse to tz-aware UTC."""
    if iso.endswith("Z"):
        iso = iso.replace("Z", "+00:00")
    dt = datetime.fromisoformat(iso)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def _dates_param(start: date, end: date) -> str:
    """Build ESPN's `dates=YYYYMMDD-YYYYMMDD` query value for a date range."""
    return f"{start:%Y%m%d}-{end:%Y%m%d}"


def _pad_date_range(min_dt: datetime, max_dt: datetime, pad_days: int = 1) -> tuple[date, date]:
    """Widen a week's known kickoff span by `pad_days` on each side (UTC day-boundary safety)."""
    return min_dt.date() - timedelta(days=pad_days), max_dt.date() + timedelta(days=pad_days)


def _calendar_week_ranges(calendar: list[dict[str, Any]], season_type: str) -> dict[int, tuple[datetime, datetime]]:
    """
    Parse ESPN's `leagues[0].calendar` block into {week_number: (start, end)} for
    one season_type ("1"=preseason, "2"=regular, "3"=postseason). Only entries with
    a plain integer `value` (i.e. real weeks, not e.g. "Hall of Fame Weekend"-style
    preseason labels lacking one) are included.
    """
    block = next((b for b in calendar if b.get("value") == season_type), None)
    if not block:
        return {}

    ranges: dict[int, tuple[datetime, datetime]] = {}
    for entry in block.get("entries", []):
        try:
            week = int(entry["value"])
        except (KeyError, ValueError):
            continue
        ranges[week] = (_parse_iso_utc(entry["startDate"]), _parse_iso_utc(entry["endDate"]))
    return ranges


async def _fetch_current_calendar() -> list[dict[str, Any]]:
    """
    GET ESPN's scoreboard with no query params and return its `leagues[0].calendar`
    block.

    Deliberately omits `dates=` here rather than pinning it to today: during the
    off-season, `dates=<today>` resolves the calendar to the *previous* completed
    season (e.g. querying in July 2026 returns the 2025 season's week dates), while
    an unparameterized request correctly resolves to the upcoming season. Verified
    empirically; not documented by ESPN.
    """
    sb = await _fetch_scoreboard()
    return sb["leagues"][0]["calendar"]


async def _fetch_scoreboard(*, dates: Optional[str] = None) -> dict[str, Any]:
    """GET ESPN's NFL scoreboard, optionally for a `dates=YYYYMMDD-YYYYMMDD` range."""
    url = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard"
    params = {"dates": dates} if dates else {}
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.get(url, params=params)
        resp.raise_for_status()
        return resp.json()


def _parse_event_kickoff(ev: dict[str, Any]) -> datetime:
    """ESPN event['date'] is ISO8601; convert to tz-aware datetime in UTC."""
    return _parse_iso_utc(ev["date"])


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
