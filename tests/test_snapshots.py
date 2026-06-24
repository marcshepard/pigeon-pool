"""
Stage 1 baseline snapshot tests.

Captures the current single-pool API output before the multi-tenant migration.
Run with --update-snapshots to regenerate the golden files; run without to assert
they still match (used after each migration stage to catch regressions).
"""

import json
from pathlib import Path

import pytest

SNAPSHOTS = Path(__file__).parent / "snapshots"
WEEKS = [1, 10]  # representative weeks: start and mid-season


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

def test_ytd_leaderboard(client, auth_headers, update_snapshots):
    """YTD standings across all locked weeks — powers the YearToDate page."""
    resp = client.get("/results/leaderboard", headers=auth_headers)
    assert resp.status_code == 200
    _check("ytd_leaderboard.json", resp.json(), update_snapshots)


@pytest.mark.parametrize("week", WEEKS)
def test_week_picks(week, client, auth_headers, update_snapshots):
    """All picks + game metadata for a locked week — powers Picks/Results and Analytics."""
    resp = client.get(f"/results/weeks/{week}/picks", headers=auth_headers)
    assert resp.status_code == 200
    _check(f"week_{week}_picks.json", resp.json(), update_snapshots)


@pytest.mark.parametrize("week", WEEKS)
def test_week_leaderboard(week, client, auth_headers, update_snapshots):
    """Weekly leaderboard for a locked week — powers Picks/Results and Analytics."""
    resp = client.get(f"/results/weeks/{week}/leaderboard", headers=auth_headers)
    assert resp.status_code == 200
    _check(f"week_{week}_leaderboard.json", resp.json(), update_snapshots)
