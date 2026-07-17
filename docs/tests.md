# Test Suite Overview

The project has two test suites:

| Suite | Command | Count | Framework |
|-------|---------|-------|-----------|
| Backend | `pytest` (repo root) | 54 tests | pytest + FastAPI `TestClient` |
| Frontend E2E | `npm run test:e2e` (in `frontend/`) | 35 tests | Playwright (Chromium) |

Both suites run against the dev database configured in `backend/.env` and create/teardown their
own isolated test tenants, so they never touch Tenant 1 data (except snapshot tests,
which read-only query Tenant 1).

---

# Frontend E2E Test Design

## Architecture

**Global setup** (`e2e/global-setup.ts`) calls `python -m backend.cli setup-fe-tests`,
which creates a `_Test FE League` tenant with:
- One player: `_TestFE` (pigeon_number=1)
- One commissioner user: `_testfe@example.com / testpass`
- Lock times: the lowest scored week is locked (past); all other weeks use year-2099
  lock times (unlocked). Week 18 is always unlocked for pick submission.
- Writes `playwright/.test-state.json` with auth tokens and game IDs.

**Global teardown** (`e2e/global-teardown.ts`) calls `teardown-fe-tests`, which
deletes the tenant (cascading picks/players) and the state file.

**Auth injection** (`e2e/helpers/auth.ts`): `setAuthToken` injects a pre-minted JWT
into `localStorage` via `page.addInitScript` — tests start authenticated without
clicking through the login form.

## Spec files

| File | Tests | What it covers |
|------|-------|----------------|
| `auth.spec.ts` | 5 | Login success/failure, redirect, tenant name in app bar, tenant switcher |
| `picks.spec.ts` | 4 | Page loads, full submit via home-by-3 easter egg, lock rejection (API), alt-player (API) |
| `results.spec.ts` | 5 | Page loads, locked week table, picks/leaderboard API, unlocked week privacy |
| `admin.spec.ts` | 6 | Commissioner access, league rename, payouts, roster player, 401 on bad token, lock page |
| `analytics.spec.ts` | 8 | Selectors, tabs, Your Picks table, Top 5 panel, pigeon selector, MNF/Top5 content, API |
| `snapshots.spec.ts` | 7 | Golden-file API and rendered-content checks against the real Tenant 1 pool |

## Design decisions

**No `role=tabpanel`**: Analytics uses conditional rendering (`{tab === 0 && <Component />}`),
not MUI `TabPanel`. Tests check for `<table>` (Your Picks) or MnfOutcomes/Top5 text (Top 5).

**No `waitForResponse` for week selection**: The test tenant has only one locked week
(the earliest week with real scored games). The analytics page defaults to that week on
mount, so the picks response fires before the test can register a listener. Tests verify
UI content directly instead.

**Pick submission via easter egg**: The submit button validates that every game in the
week has a pick. Week 2 has 16 real NFL games. The test double-clicks the "Enter picks"
heading to auto-fill all games as home by 3, then submits.

**Roster autocomplete**: Player names in the Admin Roster page live inside a collapsed
MUI Autocomplete. Tests open the dropdown before asserting on player names.

**Cleanup via cascade**: Picks submitted during tests are not deleted explicitly. Global
teardown deletes the `_Test FE League` tenant, which cascades to players and picks.

---

# Backend Test Design

## Overview

The backend test suite lives in `tests/` and uses pytest against the dev database configured in `backend/.env`. Tests are organized by feature area:

| File | What it tests |
|------|---------------|
| `test_auth.py` | Login, `/auth/me`, tenant context switching, password reset |
| `test_picks.py` | Pick submission, retrieval, lock enforcement, alt-player delegation |
| `test_results.py` | Leaderboard ranking, scoring correctness, YTD aggregation |
| `test_admin.py` | Pigeon/player management, league rename, payout config, user management |
| `test_tenant_isolation.py` | Data from Tenant A never leaks into Tenant B responses |
| `test_snapshots.py` | Golden-file regression tests against Tenant 1's real data |

---

## Auth approach

### Pre-minted tokens (most tests)

Most tests receive a pre-built JWT `Authorization: Bearer <token>` header via one of three session-scoped fixtures:

| Fixture | Identity |
|---------|----------|
| `comm_headers` | Commissioner in Tenant A (`testcomm@pigeon.test`) |
| `member_headers` | Regular member in Tenant A (`testmember@pigeon.test`) |
| `tenant_b_headers` | Same commissioner user, but scoped to Tenant B |

These tokens are built in `conftest.py` by calling `make_session_token(player_id, tenant_id, email, uid=user_id)` directly — no HTTP call or password needed. The IDs come from the `test_data` fixture (the test tenants/users inserted at session start).

The `make_session_token()` helper is the same function the `/auth/login` endpoint uses internally to produce tokens, so the tokens are fully valid for the `current_user` FastAPI dependency (which does a DB lookup verifying `user_players + players + tenant_members`).

### Login endpoint test (one exception)

`test_auth.py::test_login_success` calls `POST /auth/login` with real credentials:
- email: `testcomm@pigeon.test`
- password: `testpass`

For this to work, `test_data` inserts the commissioner user with a bcrypt hash of `"testpass"` (via `passlib.hash.bcrypt.hash("testpass")`). The member user gets a placeholder hash `"x"` since the login endpoint is never called for them.

### Snapshot tests

`test_snapshots.py` uses a separate `auth_headers` fixture (not `comm_headers`) that queries the DB for the first real commissioner in the production pool (Tenant 1). This is intentional — snapshots must reflect real data, not test-fixture data.

---

## Game data: the adaptive `scored_games` fixture

Tests that assert on leaderboard ranking or scoring output need games with final scores. The challenge is that the test suite must work in all three NFL-season states:

| Season state | What's in the DB |
|---|---|
| Post-season (most of the year) | Scored games exist |
| Mid-season | Partial week history of scored games |
| Pre-season / after reset | No scored games yet |

The `scored_games` session fixture handles this adaptively:

1. **Query first.** It runs `SELECT … FROM games WHERE kickoff_at <= now() AND home_score IS NOT NULL` (up to 10 rows).
2. **If scored games exist**, use those `game_id`s directly. No writes to the `games` table.
3. **If no scored games exist**, insert two synthetic games into week 1 (KC 21 BUF 14, LAR 10 SF 3) with `kickoff_at` in the past, and delete them at teardown.

This matters because of `v_picks_filled`, which uses a `CROSS JOIN` between players and games. Inserting a new game adds default-pick rows for every player in the DB — including Tenant 1's 68 real players, which would corrupt their leaderboard and break snapshot tests. By reusing real `game_id`s when they exist, we insert zero new game rows in the normal case.

### Submission week

Pick-submission tests need an **unlocked** game (one the server will accept new picks for). The fixture always inserts a synthetic game in week 17 (`TB vs NO`, `lock_at` year 2099) using `ON CONFLICT DO NOTHING`. This game is separate from the scoring weeks and is cleaned up at teardown.

### Lock times

The fixture sets `tenant_weeks` rows for the test tenants:
- Scored weeks → `lock_at = '2020-01-01'` (in the past → locked)
- Week 17 (submission week) → `lock_at = '2099-01-01'` (in the future → unlocked)

Tenant B gets the same locked weeks so isolation tests can call results endpoints.

---

## Pick insertion in locked weeks

Some tests need to insert picks directly into locked weeks (bypassing the `deny_picks_after_lock()` DB trigger) to set up scoring scenarios. The `insert_pick` fixture handles this:

```python
with cur.execute("SET LOCAL app.bypass_lock = 'on'"):
    # INSERT INTO picks ...
```

`SET LOCAL` scopes the bypass flag to the current transaction. The trigger already checks `current_setting('app.bypass_lock', true)` and skips enforcement when it's `'on'`.

The `pick_cleaner` fixture (function-scoped) collects `(player_id, game_id)` pairs and deletes them after each test, whether the test passes or fails.

---

## Scoring formula

`conftest.py` exports `expected_score(picked_home, predicted_margin, home_score, away_score, is_made=True)` which mirrors the `v_results` SQL view formula exactly:

```
actual_margin = home_score - away_score
pred          = predicted_margin if picked_home else -predicted_margin
diff          = abs(pred - actual_margin)
penalty       = 0    # correct side
            or 7    # wrong side (sign mismatch) or both zero
            or 100  # no pick (is_made=False)
score         = min(diff + penalty, 800)
```

Tests import this with `from conftest import expected_score` and use it to assert exact scores and rank orderings without hard-coding magic numbers.

---

## Tenant isolation

The `test_data` fixture creates:
- **Tenant A**: commissioner (`pigeon_number=1`), member (`pn=2`), alt (`pn=3`, no primary user)
- **Tenant B**: commissioner player (`pn=1`) — same user (`comm_uid`) as Tenant A's commissioner

This setup lets `test_tenant_isolation.py` verify that API responses are scoped per-tenant: picks, leaderboards, and admin pigeon lists from Tenant A never include Tenant B player IDs, and vice versa.

---

## Test data teardown

At session end, `test_data` runs:
```sql
DELETE FROM tenants WHERE tenant_id IN (tenant_a_id, tenant_b_id)  -- cascades
DELETE FROM users WHERE user_id IN (comm_uid, member_uid)
```

The tenants cascade-delete: `players → picks`, `tenant_members`, `tenant_weeks`. No orphan data is left behind.
