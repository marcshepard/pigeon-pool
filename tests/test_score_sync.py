"""
Unit tests for the pure helper functions in backend/utils/score_sync.py.

These cover the date-range/calendar-parsing logic added to work around ESPN's
`week=` query param being unreliable for a season that hasn't started yet (see
the module docstring note above `_fetch_scoreboard` in score_sync.py). No DB or
network access — pure functions only.
"""

from datetime import date, datetime, timezone

from backend.utils.score_sync import (
    _calendar_week_ranges,
    _dates_param,
    _pad_date_range,
    _parse_iso_utc,
)


# ── _parse_iso_utc ────────────────────────────────────────────────────────────

def test_parse_iso_utc_with_trailing_z():
    assert _parse_iso_utc("2026-09-10T00:20Z") == datetime(2026, 9, 10, 0, 20, tzinfo=timezone.utc)


def test_parse_iso_utc_with_explicit_offset():
    assert _parse_iso_utc("2026-09-09T17:00-07:00") == datetime(2026, 9, 10, 0, 0, tzinfo=timezone.utc)


# ── _dates_param ──────────────────────────────────────────────────────────────

def test_dates_param_formats_range():
    assert _dates_param(date(2026, 9, 9), date(2026, 9, 16)) == "20260909-20260916"


# ── _pad_date_range ───────────────────────────────────────────────────────────

def test_pad_date_range_widens_by_one_day_each_side():
    min_dt = datetime(2026, 9, 13, 17, 0, tzinfo=timezone.utc)
    max_dt = datetime(2026, 9, 15, 0, 15, tzinfo=timezone.utc)
    assert _pad_date_range(min_dt, max_dt) == (date(2026, 9, 12), date(2026, 9, 16))


def test_pad_date_range_single_game_week_still_widens():
    same = datetime(2026, 9, 10, 0, 20, tzinfo=timezone.utc)
    assert _pad_date_range(same, same) == (date(2026, 9, 9), date(2026, 9, 11))


# ── _calendar_week_ranges ─────────────────────────────────────────────────────

_FAKE_CALENDAR = [
    {
        "label": "Preseason",
        "value": "1",
        "entries": [
            {"label": "Hall of Fame Weekend", "value": "1",
             "startDate": "2026-08-06T07:00Z", "endDate": "2026-08-13T06:59Z"},
            {"label": "Preseason Week 1", "value": "2",
             "startDate": "2026-08-13T07:00Z", "endDate": "2026-08-20T06:59Z"},
        ],
    },
    {
        "label": "Regular Season",
        "value": "2",
        "entries": [
            {"label": "Week 1", "value": "1",
             "startDate": "2026-09-09T07:00Z", "endDate": "2026-09-16T06:59Z"},
            {"label": "Week 2", "value": "2",
             "startDate": "2026-09-16T07:00Z", "endDate": "2026-09-23T06:59Z"},
        ],
    },
]


def test_calendar_week_ranges_extracts_requested_season_type():
    ranges = _calendar_week_ranges(_FAKE_CALENDAR, "2")
    assert set(ranges) == {1, 2}
    assert ranges[1] == (
        datetime(2026, 9, 9, 7, 0, tzinfo=timezone.utc),
        datetime(2026, 9, 16, 6, 59, tzinfo=timezone.utc),
    )


def test_calendar_week_ranges_unknown_season_type_returns_empty():
    assert _calendar_week_ranges(_FAKE_CALENDAR, "3") == {}


def test_calendar_week_ranges_skips_non_numeric_entry_values():
    calendar = [{
        "label": "Regular Season",
        "value": "2",
        "entries": [
            {"label": "Weird", "value": "n/a",
             "startDate": "2026-09-09T07:00Z", "endDate": "2026-09-16T06:59Z"},
            {"label": "Week 1", "value": "1",
             "startDate": "2026-09-09T07:00Z", "endDate": "2026-09-16T06:59Z"},
        ],
    }]
    ranges = _calendar_week_ranges(calendar, "2")
    assert set(ranges) == {1}
