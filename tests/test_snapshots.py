"""
Stage 1 baseline snapshot tests.

Captures the current single-pool API output before the multi-tenant migration.
Run with --update-snapshots to regenerate the golden files; run without to assert
they still match (used after each migration stage to catch regressions).
"""

import json
from pathlib import Path

import psycopg
import pytest

from backend.utils.settings import get_settings

SNAPSHOTS = Path(__file__).parent / "snapshots"
WEEKS = [1, 10]  # representative weeks: start and mid-season


# ---------------------------------------------------------------------------
# Skip guard — snapshot tests require real season data in the DB.
# They are skipped (not failed) when running against a post-reset-season DB
# that contains only synthetic test fixtures.
# ---------------------------------------------------------------------------

def _has_real_games() -> bool:
    s = get_settings()
    with psycopg.connect(**s.psycopg_kwargs()) as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT COUNT(*) FROM games WHERE kickoff_at <= now() AND home_score IS NOT NULL"
            )
            return (cur.fetchone() or (0,))[0] > 0


_SKIP_NO_GAMES = pytest.mark.skipif(
    not _has_real_games(),
    reason="No scored games in DB — snapshot tests skipped (run against a real-season DB)",
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _load(name: str):
    return json.loads((SNAPSHOTS / name).read_text(encoding="utf-8"))


def _save(name: str, data) -> None:
    SNAPSHOTS.mkdir(exist_ok=True)
    (SNAPSHOTS / name).write_text(json.dumps(data, indent=2), encoding="utf-8")


def _check(name: str, data, update: bool) -> None:
    if update:
        _save(name, data)
    else:
        assert data == _load(name), f"Snapshot mismatch: {name}"


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

@_SKIP_NO_GAMES
def test_ytd_leaderboard(client, auth_headers, update_snapshots):
    """YTD standings across all locked weeks — powers the YearToDate page."""
    resp = client.get("/results/leaderboard", headers=auth_headers)
    assert resp.status_code == 200
    _check("ytd_leaderboard.json", resp.json(), update_snapshots)


@_SKIP_NO_GAMES
@pytest.mark.parametrize("week", WEEKS)
def test_week_picks(week, client, auth_headers, update_snapshots):
    """All picks + game metadata for a locked week — powers Picks/Results and Analytics."""
    resp = client.get(f"/results/weeks/{week}/picks", headers=auth_headers)
    assert resp.status_code == 200
    _check(f"week_{week}_picks.json", resp.json(), update_snapshots)


@_SKIP_NO_GAMES
@pytest.mark.parametrize("week", WEEKS)
def test_week_leaderboard(week, client, auth_headers, update_snapshots):
    """Weekly leaderboard for a locked week — powers Picks/Results and Analytics."""
    resp = client.get(f"/results/weeks/{week}/leaderboard", headers=auth_headers)
    assert resp.status_code == 200
    _check(f"week_{week}_leaderboard.json", resp.json(), update_snapshots)
