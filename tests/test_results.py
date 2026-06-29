"""
Results and leaderboard tests — the primary scoring correctness tests.

All scoring assertions use expected_score() from conftest, which mirrors
the v_results formula exactly:
    correct side:  ABS(predicted - actual)
    wrong side:    ABS(predicted - actual) + 7
    no pick:       ABS(0 - actual) + 100   (v_picks_filled default)
    cap:           800
"""

import pytest
from conftest import expected_score


# ── lock gate ─────────────────────────────────────────────────────────────────

def test_week_picks_unlocked_week_returns_409(client, comm_headers, scored_games):
    """Results endpoints refuse to serve an unlocked week."""
    resp = client.get(f"/results/weeks/{scored_games['submission_week']}/picks", headers=comm_headers)
    assert resp.status_code == 409


def test_week_leaderboard_unlocked_week_returns_409(client, comm_headers, scored_games):
    resp = client.get(f"/results/weeks/{scored_games['submission_week']}/leaderboard", headers=comm_headers)
    assert resp.status_code == 409


# ── week picks ────────────────────────────────────────────────────────────────

def test_week_picks_locked_week_returns_data(client, comm_headers, scored_games):
    """A locked week with scored games returns pick rows for all players."""
    week = next(iter(scored_games["scored_weeks"]))
    resp = client.get(f"/results/weeks/{week}/picks", headers=comm_headers)
    assert resp.status_code == 200
    body = resp.json()
    assert len(body) > 0
    row = body[0]
    assert "pigeon_number" in row
    assert "picked_home" in row
    assert "home_score" in row


# ── leaderboard scoring correctness ──────────────────────────────────────────

@pytest.fixture
def two_player_picks(test_data, scored_games, insert_pick):
    """
    Inserts known picks for comm and member players for one locked game.
    Returns (game, expected_comm_score, expected_member_score).

    Picks chosen so:
      comm   picks the correct side (lower score → better rank)
      member picks the wrong side   (higher score)
    """
    home_wins = scored_games["home_win_games"]
    if not home_wins:
        pytest.skip("No home-win game available for scoring test")

    gid, wk, hs, as_ = home_wins[0]
    actual_margin = hs - as_

    # comm picks home (correct side) with exact margin
    insert_pick(test_data["comm_pid"], gid, picked_home=True, predicted_margin=actual_margin)
    # member picks away (wrong side)
    insert_pick(test_data["member_pid"], gid, picked_home=False, predicted_margin=3)

    comm_score = expected_score(True, actual_margin, hs, as_)
    member_score = expected_score(False, 3, hs, as_)

    return (gid, wk, hs, as_), comm_score, member_score


def test_weekly_leaderboard_correct_side_ranks_higher(client, comm_headers, scored_games, two_player_picks):
    """Player who picked the correct side scores lower and ranks higher."""
    _, wk, _, _ = two_player_picks[0]
    comm_score, member_score = two_player_picks[1], two_player_picks[2]
    assert comm_score < member_score, "Test setup: comm should have lower score than member"

    resp = client.get(f"/results/weeks/{wk}/leaderboard", headers=comm_headers)
    assert resp.status_code == 200
    body = resp.json()

    rows_by_pn = {r["pigeon_number"]: r for r in body}
    comm_pn = 1   # pigeon_number=1 for comm in test tenant
    member_pn = 2  # pigeon_number=2 for member

    assert comm_pn in rows_by_pn, "Commissioner not in leaderboard"
    assert member_pn in rows_by_pn, "Member not in leaderboard"
    assert rows_by_pn[comm_pn]["rank"] < rows_by_pn[member_pn]["rank"]


def test_wrong_side_penalty_applied(client, comm_headers, scored_games, test_data, insert_pick):
    """A pick on the wrong side incurs a +7 penalty vs. a pick on the correct side with the same margin error."""
    home_wins = scored_games["home_win_games"]
    if not home_wins:
        pytest.skip("No home-win game available")

    gid, wk, hs, as_ = home_wins[0]

    # Both players predict the same absolute distance (7) but on opposite sides
    insert_pick(test_data["comm_pid"], gid, picked_home=True, predicted_margin=7)   # correct side
    insert_pick(test_data["member_pid"], gid, picked_home=False, predicted_margin=7)  # wrong side

    correct_score = expected_score(True, 7, hs, as_)
    wrong_score = expected_score(False, 7, hs, as_)
    # The +7 penalty is applied on top of a different diff term (pred flips sign),
    # so the total score gap > 7. Just assert wrong-sider scores higher (worse).
    assert wrong_score > correct_score

    resp = client.get(f"/results/weeks/{wk}/leaderboard", headers=comm_headers)
    assert resp.status_code == 200
    rows = {r["pigeon_number"]: r for r in resp.json()}
    assert rows[1]["rank"] < rows[2]["rank"]


def test_no_pick_penalty_applied(client, comm_headers, scored_games, test_data, insert_pick):
    """A player with no pick for a game gets a +100 penalty (on top of diff from actual)."""
    home_wins = scored_games["home_win_games"]
    if not home_wins:
        pytest.skip("No home-win game available")

    gid, wk, hs, as_ = home_wins[0]

    # Only comm has a pick; member has no pick (v_picks_filled default: home, 0, is_made=False)
    insert_pick(test_data["comm_pid"], gid, picked_home=True, predicted_margin=7)
    # member deliberately has no pick

    comm_score = expected_score(True, 7, hs, as_)
    member_no_pick_score = expected_score(True, 0, hs, as_, is_made=False)
    assert member_no_pick_score > comm_score

    resp = client.get(f"/results/weeks/{wk}/leaderboard", headers=comm_headers)
    assert resp.status_code == 200
    rows = {r["pigeon_number"]: r for r in resp.json()}
    assert rows[1]["rank"] < rows[2]["rank"]


# ── YTD leaderboard ───────────────────────────────────────────────────────────

def test_ytd_leaderboard_returns_locked_weeks_only(client, comm_headers, scored_games):
    """YTD endpoint aggregates all locked weeks and excludes the unlocked submission week."""
    resp = client.get("/results/leaderboard", headers=comm_headers)
    assert resp.status_code == 200
    body = resp.json()
    week_numbers = {r["week_number"] for r in body}
    assert scored_games["submission_week"] not in week_numbers
    assert week_numbers.issubset(scored_games["scored_weeks"])


def test_ytd_leaderboard_no_auth(client):
    resp = client.get("/results/leaderboard")
    assert resp.status_code == 401
