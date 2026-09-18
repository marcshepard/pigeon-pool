"""Scoreboard selection and calendar parsing tests, without network or database access."""

import asyncio
from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest

from backend.utils import score_sync
from backend.utils.score_sync import (
    _calendar_week_ranges,
    _fetch_week_scoreboard,
    _parse_iso_utc,
    _season_year,
)


def test_parse_iso_utc_with_trailing_z():
    assert _parse_iso_utc("2026-09-10T00:20Z") == datetime(2026, 9, 10, 0, 20, tzinfo=UTC)


def test_parse_iso_utc_with_explicit_offset():
    assert _parse_iso_utc("2026-09-09T17:00-07:00") == datetime(2026, 9, 10, tzinfo=UTC)


@pytest.mark.parametrize("kickoff, expected", [
    (datetime(2026, 9, 18, tzinfo=UTC), 2026),
    (datetime(2027, 1, 4, tzinfo=UTC), 2026),
    (datetime(2027, 2, 7, tzinfo=UTC), 2026),
    (datetime(2026, 8, 6, tzinfo=UTC), 2026),
])
def test_season_year_uses_schedule(kickoff, expected):
    assert _season_year(kickoff) == expected


@pytest.mark.parametrize("season_type", ["1", "2", "3"])
def test_week_request_selects_explicit_season(monkeypatch, season_type):
    payload = {"season": {"year": 2026, "type": int(season_type)},
               "week": {"number": 2}, "events": [{"id": "401872932"}]}
    def handle(request):
        assert dict(request.url.params) == {
            "dates": "2026", "seasontype": season_type, "week": "2",
        }
        return httpx.Response(200, json=payload)

    client = httpx.AsyncClient(transport=httpx.MockTransport(handle))
    monkeypatch.setattr(score_sync.httpx, "AsyncClient", lambda **kwargs: client)
    monkeypatch.setattr(score_sync, "get_settings",
                        lambda: SimpleNamespace(nfl_season_type=season_type))
    assert asyncio.run(_fetch_week_scoreboard(season=2026, week=2)) == payload


@pytest.mark.parametrize("payload", [
    {"events": []},
    {"season": {"year": 2025, "type": 2}, "week": {"number": 2}},
    {"season": {"year": 2026, "type": 1}, "week": {"number": 2}},
    {"season": {"year": 2026, "type": 2}, "week": {"number": 3}},
])
def test_week_request_rejects_missing_or_wrong_metadata(monkeypatch, payload):
    monkeypatch.setattr(score_sync, "get_settings",
                        lambda: SimpleNamespace(nfl_season_type="2"))
    monkeypatch.setattr(score_sync, "_fetch_scoreboard", AsyncMock(return_value=payload))
    with pytest.raises(ValueError, match="ESPN scoreboard mismatch"):
        asyncio.run(_fetch_week_scoreboard(season=2026, week=2))


@pytest.mark.parametrize("method", ["sync_scores_and_status", "refresh_kickoffs"])
def test_invalid_scoreboard_does_not_write_games(monkeypatch, method):
    session = AsyncMock()
    syncer = score_sync.ScoreSync(session)
    monkeypatch.setattr(syncer, "_week_kickoff_bounds", AsyncMock(return_value=(
        datetime(2027, 1, 3, tzinfo=UTC), datetime(2027, 1, 4, tzinfo=UTC),
    )))
    fetch = AsyncMock(side_effect=ValueError("ESPN scoreboard mismatch"))
    monkeypatch.setattr(score_sync, "_fetch_week_scoreboard", fetch)
    with pytest.raises(ValueError, match="ESPN scoreboard mismatch"):
        asyncio.run(getattr(syncer, method)(18))
    fetch.assert_awaited_once_with(season=2026, week=18)
    session.execute.assert_not_awaited()
    session.commit.assert_not_awaited()


def test_schedule_import_uses_calendar_season_for_january(monkeypatch):
    session = AsyncMock()
    monkeypatch.setattr(score_sync, "get_settings",
                        lambda: SimpleNamespace(nfl_season_type="2"))
    monkeypatch.setattr(score_sync, "_fetch_current_calendar", AsyncMock(return_value=[{
        "value": "2", "entries": [{
            "value": "18", "startDate": "2027-01-06T08:00Z",
            "endDate": "2027-01-13T07:59Z",
        }],
    }]))
    fetch = AsyncMock(return_value={"events": []})
    monkeypatch.setattr(score_sync, "_fetch_week_scoreboard", fetch)
    assert asyncio.run(score_sync.ScoreSync(session).load_schedule()) == 0
    fetch.assert_awaited_once_with(season=2026, week=18)


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
        datetime(2026, 9, 9, 7, 0, tzinfo=UTC),
        datetime(2026, 9, 16, 6, 59, tzinfo=UTC),
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
