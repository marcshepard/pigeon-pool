# Multi-Tenant Migration Plan

This plan breaks the project into staged prompts so the app can move from a single-pool implementation to a general-purpose multi-tenant app without one giant migration.

## How We're Working

Each stage is implemented in its own Claude Code conversation thread. When a stage is done, completion notes are added to that stage's section in this file before starting the next thread. New threads should read `multi.md` first for context.

## Guiding Principles

- Keep the current app working after each major stage.
- Use a cloned database for development and migration testing.
- Prefer incremental compatibility over a full rewrite.
- Keep global NFL facts global: teams, games, and probably weeks for now.
- Make tenant-specific data explicit: players, picks, user/player assignments, roles, admin access.
- Preserve current user-facing behavior until the backend is safely tenant-scoped.

## Stage 0: Safety Net ✅ COMPLETE

Create a cloned database and verify the app can run against either original or experimental DB.

Deliverables:

- Clone the current database to a development tenant-migration database.
- Leave the original database untouched.
- Document connection string switching in `README.md`.
- Export a schema/data snapshot before changing anything.
- Confirm the current app works against the clone before modifying schema.

Suggested prompt:

> Help me clone the current database for multi-tenant migration work and document how to switch between the original DB and clone.

### Completion notes

- `pigeon_pool_multi` created as an exact clone of `pigeon_pool` (272 games, 68 players, 17,946 picks).
- Original `pigeon_pool` database is untouched.
- `backend/.env` on the `multi` branch sets `POSTGRES_DB=pigeon_pool_multi`; checking out `main`/`dev` restores the original automatically.
- `README.md` documents the branch/database mapping and commands to recreate or restore the clone.
- No snapshot SQL file was committed; the clone itself is the safety net and the README documents how to recreate it.

## Stage 1: Baseline Backend Tests ✅ COMPLETE

Add tests around current single-pool behavior before changing schema.

Initial test targets:

- Auth login and `/auth/me`.
- Current week and games.
- Get picks for a user.
- Submit picks before lock.
- Reject picks after lock.
- Results privacy for locked and unlocked weeks.
- Weekly leaderboard.
- YTD leaderboard.
- Admin roster user/player assignment.
- Admin picks visibility.

Suggested prompt:

> Add a first backend test suite that captures current single-pool behavior before we start the tenant migration.

### Completion notes

Implemented as golden-file snapshot tests (simpler than the original plan, given all weeks are locked off-season and pick submission can't be tested against last year's data):

- `tests/test_snapshots.py` — 5 pytest tests covering the three results endpoints
- `tests/snapshots/` — 5 JSON golden files: `ytd_leaderboard.json`, `week_1_picks.json`, `week_1_leaderboard.json`, `week_10_picks.json`, `week_10_leaderboard.json`
- `tests/conftest.py` — shared fixtures: `TestClient`, auth token minted via `make_session_token()` for the first admin user in the DB, `--update-snapshots` flag
- `pytest.ini` at project root; `pytest` added to `backend/requirements.txt`

Snapshot row counts: 68-row leaderboards per week, 952–1088 picks per week, 1224 YTD rows (68 pigeons × 18 weeks).

Run tests: `pytest` (compare) or `pytest --update-snapshots` (regenerate after intentional data changes).

## Stage 2: Minimal Target Schema ✅ COMPLETE

Design and update the from-scratch schema for the minimal tenant model.

Target model:

- Add `tenants`.
- Add stable `players.player_id`.
- Add `players.tenant_id`.
- Make `pigeon_number` unique per tenant, not globally.
- Change `user_players` to reference `player_id`.
- Change `picks` to reference `player_id`.
- Add `tenant_weeks` for per-tenant lock times (replaces global `weeks.lock_at`).
- Add `tenant_members` for tenant membership independent of player ownership (supports admins who do not compete).
- Leave `users.is_admin` untouched — role separation happens in Stage 5.
- Update views to carry and partition by tenant.

Notes on design decisions:

- `pigeon_number` upper bound is not hardcoded to 68; new tenants may run pools of different sizes.
- `tenant_members` is preferred over a nullable `player_id` in `user_players`. A tenant admin who does not compete needs a membership row without owning a player.
- `weeks` (week numbers 1–18) remains global. Only `lock_at` moves to `tenant_weeks` because each tenant sets its own lock times. The pick-lock DB triggers must also be updated to reference `tenant_weeks`.
- `v_picks_filled` is retained as a useful synthetic-default helper. `v_results` and `v_weekly_leaderboard` are updated to filter and partition by `tenant_id`.

Likely tables:

```sql
tenants (
  tenant_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name      TEXT NOT NULL
);

-- Per-tenant lock times; replaces lock_at on the global weeks table.
tenant_weeks (
  tenant_id   BIGINT NOT NULL REFERENCES tenants(tenant_id),
  week_number INT    NOT NULL REFERENCES weeks(week_number),
  lock_at     TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, week_number)
);

-- Tenant membership independent of player ownership.
-- Supports admins and commissioners who do not compete.
tenant_members (
  tenant_id BIGINT NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  user_id   BIGINT NOT NULL REFERENCES users(user_id)    ON DELETE CASCADE,
  role      TEXT   NOT NULL DEFAULT 'member' CHECK (role IN ('admin','member')),
  PRIMARY KEY (tenant_id, user_id)
);

players (
  player_id     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id     BIGINT NOT NULL REFERENCES tenants(tenant_id),
  pigeon_number INT    NOT NULL CHECK (pigeon_number >= 1),
  pigeon_name   TEXT   NOT NULL,
  UNIQUE (tenant_id, pigeon_number),
  UNIQUE (tenant_id, pigeon_name)
);

user_players (
  user_id    BIGINT NOT NULL REFERENCES users(user_id)    ON DELETE CASCADE,
  player_id  BIGINT NOT NULL REFERENCES players(player_id) ON DELETE CASCADE,
  role       TEXT   NOT NULL DEFAULT 'owner' CHECK (role IN ('owner','manager','viewer')),
  is_primary BOOLEAN NOT NULL DEFAULT TRUE,
  PRIMARY KEY (user_id, player_id)
);

picks (
  player_id        BIGINT  NOT NULL REFERENCES players(player_id) ON DELETE CASCADE,
  game_id          BIGINT  NOT NULL REFERENCES games(game_id)     ON DELETE CASCADE,
  picked_home      BOOLEAN NOT NULL,
  predicted_margin INT     NOT NULL CHECK (predicted_margin >= 0),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, game_id)
);
```

Suggested prompt:

> Update the from-scratch database schema for the minimal multi-tenant model, but do not touch backend code yet.

### Completion notes

Updated `database/schema.sql` with the full multi-tenant target schema. Key decisions made during design:

- **`tenants`** — new table; `tenant_id BIGINT IDENTITY PRIMARY KEY`, `name TEXT`.
- **`tenant_weeks`** — replaces `weeks.lock_at`; per-tenant lock times with `PRIMARY KEY (tenant_id, week_number)`. Both FKs use `ON DELETE CASCADE`.
- **`weeks.default_lock_at`** — nullable template column for new tenant onboarding. Not used as trigger fallback; trigger always reads `tenant_weeks` (missing row → unlocked).
- **`users.is_admin` dropped** — no global-admin features exist in the current codebase. Tenant management role is now `tenant_members.role = 'commissioner'`. If a global-admin concept is needed later, add `users.global_admin` at that time.
- **`players`** — new stable `player_id BIGINT` PK (via sequence `players_player_id_seq`). `pigeon_number` stays as display column, unique per tenant (not globally). 68-player cap removed; CHECK now `>= 1`. Old global UNIQUE on `pigeon_name` replaced with `UNIQUE (tenant_id, pigeon_name)`.
- **`user_players`** — `pigeon_number` FK replaced by `player_id` FK. `is_primary` column dropped; "active player per tenant" moved to `tenant_members.primary_player_id`.
- **`tenant_members`** — new table; `PRIMARY KEY (tenant_id, user_id)`, `role IN ('commissioner','member')`, `primary_player_id BIGINT NOT NULL`. Every member must have a player (no nullable primary; revisit if non-player admins are needed in a future season). Creation order for a new member: `users → players → user_players → tenant_members` (atomic transaction).
- **`picks`** — `pigeon_number` FK replaced by `player_id` FK.
- **Lock trigger** — `deny_picks_after_lock()` now joins `players → tenant_weeks` via `player_id`. Missing `tenant_weeks` row treated as unlocked.
- **Views** — all five views updated: carry `player_id` and `tenant_id`; leaderboard partitions by `(tenant_id, week_number)`; `v_week_picks_with_names` joins `tenant_weeks` for per-tenant lock check. Backend (Stage 4) must filter by `tenant_id` when querying views.

## Stage 3: Existing DB Migration ✅ COMPLETE

Write a migration script that converts the current single-pool database into the new tenant-aware shape.

Write a migration script that converts the current single-pool database into the new tenant-aware shape.

Migration behavior:

- Create one tenant for the current pool.
- Backfill every existing player into that tenant.
- Assign each player a `player_id`.
- Convert `user_players` to reference `player_id`.
- Convert `picks` to reference `player_id`.
- Preserve current users, passwords, picks, locks, games, and results.
- Recreate tenant-aware views.
- Add indexes and constraints after data backfill.

Suggested prompt:

> Write the migration script to convert the existing DB clone into the new tenant-aware schema and backfill all current data into one tenant.

### Completion notes

`database/db_update.sql` is the migration script. It runs as a single transaction against `pigeon_pool_multi` (never against `pigeon_pool`). Steps in order:

1. Create `tenants`; insert `'The Pigeon Pool'` → `tenant_id = 1`.
2. Add `weeks.default_lock_at`; backfill from `weeks.lock_at`.
3. Create `tenant_weeks`; backfill 18 rows from `weeks.lock_at` for tenant 1.
4. Drop `weeks.lock_at`.
5. Drop `user_players` and `picks` FKs referencing `players(pigeon_number)`.
6. Add `player_id` and `tenant_id` to `players`; backfill `player_id = pigeon_number` (values 1–68 map 1:1, so no mapping table needed).
7. Create sequence `players_player_id_seq` starting at 69; set as `player_id` default.
8. Drop old `players` PK/constraints; add new PK on `player_id`, per-tenant UNIQUEs, relaxed CHECK.
9. Add `player_id` to `user_players`; backfill via `pigeon_number` join.
10. Create `tenant_members`; backfill all users-with-players: `is_admin=TRUE` → `role='commissioner'`, others → `role='member'`; `primary_player_id` from `is_primary=TRUE` row or lowest `player_id`.
11. Drop `users.is_admin`.
12. Drop old `user_players` indexes (`uniq_pigeon_single_owner`, `uniq_user_single_primary`), PK, `is_primary` column, `pigeon_number` column; rebuild with new PK and `uniq_player_single_owner`.
13. Add `player_id` to `picks`; backfill via `pigeon_number` join.
14. Drop old `picks` triggers, indexes, PK, `pigeon_number` column; rebuild.
15. Replace `deny_picks_after_lock()` function with tenant-aware version.
16. Recreate all triggers and five views.

Run: `psql -U postgres -d pigeon_pool_multi -f database/db_update.sql`

## Stage 4: Backend Single-Tenant Compatibility

Update backend queries to use the tenant-aware schema while still auto-selecting the only existing tenant.

Deliverables:

- Login still works with email/password.
- Backend resolves active tenant automatically when the user has one tenant context.
- `require_user` returns active user, tenant, player, pigeon number, and role info.
- Picks APIs filter by active tenant/player.
- Results APIs filter by active tenant.
- Admin APIs filter by active tenant.
- Leaderboard views partition by tenant.
- Existing frontend still behaves the same.

Suggested prompt:

> Update the backend to use tenant-aware tables in single-tenant compatibility mode, keeping the current frontend behavior unchanged.

## Stage 5: Role Separation

Separate platform/global admin from tenant admin.

Roles:

- Global admin: can manage platform-level state and support all tenants. Represented by `users.is_admin` renamed/repurposed to `global_admin`.
- Tenant admin: can manage users, players, imports, locks, and emails within one tenant. Represented by `tenant_members.role = 'admin'` (added in Stage 2).
- Owner/manager/viewer: player-level permissions within a tenant.

Notes:

- `users.is_admin` is renamed to `global_admin` here. This is intentionally deferred from Stage 2 to reduce blast radius.
- The JWT currently encodes `adm` as a boolean for `is_admin`. Stage 5 changes the semantics of that claim to mean global admin only. Stage 6 then adds `tenant_id` to the token. These two stages must be coordinated: updating the token schema in Stage 5 without also adding `tenant_id` is a half-step — plan the full token shape in Stage 5 and implement it across both stages.
- Scheduled email jobs currently assume one pool. Tenant-scoped emails (weekly results, pick reminders) must loop over tenants or be dispatched per-tenant here.

Suggested prompt:

> Separate global admin from tenant admin in the backend permissions model, with tenant admin represented through tenant_members.role.

## Stage 6: Multi-Tenant Auth UX

Add explicit tenant/player selection once backend scoping is safe.

Backend behavior:

- Login returns a normal session if the user has exactly one available tenant/player context.
- Login returns a tenant/player choice payload if the user has multiple contexts.
- Add an endpoint such as `/auth/select-context`.
- Session token includes active `tenant_id` and `player_id`.
- `/auth/me` returns active tenant, available tenants, active player, alternate players, and roles.

Frontend behavior:

- Existing users with one tenant see no added complexity.
- Users with multiple tenants can choose/switch tenant.
- Player switching remains scoped to the active tenant.

Suggested prompt:

> Add tenant and player selection to auth for users who belong to multiple tenants, preserving the simple flow for single-tenant users.

## Stage 7: Frontend Data Model Cleanup

Update frontend types and pages so player identity and display pigeon number are distinct.

Priority areas:

- `frontend/src/backend/types.ts`
- `EnterPicks`
- `PicksAndResults`
- `YearToDatePage`
- `Analytics`
- Admin roster
- Admin locks/imports
- User menu / tenant switcher

Goals:

- Use `player_id` for identity.
- Use `pigeon_number` as display/order within a tenant.
- Avoid assuming `pigeon_number` is globally unique.
- Remove `scoreForPick` and the rank-derivation logic from `resultsShaping.ts`. The frontend has been duplicating the scoring formula and the two implementations have already drifted (frontend is missing the missed-pick penalty). Trust pre-computed scores and ranks from the backend.
- Remove `useAutoRefreshManager` (the polling hook). It has been a source of bugs — two overlapping timers, a >2-day stale-data heuristic, and a week-transition detector — and it is the primary consumer of the duplicate scoring logic. Replace with a manual refresh button on PicksAndResults. The backend already keeps scores current on its own schedule; the frontend does not need to poll.

Suggested prompt:

> Update the frontend data model so player identity uses `player_id` while keeping `pigeon_number` as the tenant-local display number. Also remove the auto-refresh polling hook and the duplicate scoring logic, replacing auto-refresh with a manual refresh button.

## Stage 8: Frontend and Integration Tests

Add tests around the high-mode UI pages and tenant scoping.

Picks/results cases:

- Before lock: own picks visible, others hidden.
- After lock: all picks visible.
- In-progress games show partial scoring.
- Final games show final scoring.
- Missing picks synthesize default/penalty behavior.
- Current user and alternates highlight correctly.
- Tenant switch changes visible players/results.

Enter-picks cases:

- Can edit before lock.
- Cannot edit after lock.
- Can switch managed player.
- Admin/manager permissions behave correctly.
- Submit errors are surfaced.

Analytics cases:

- Uses only active tenant rows.
- Current player selection works.
- Alternate/managed player selection works.
- Top 5, MNF outcomes, and best possible rank ignore other tenants.

Admin cases:

- Tenant admin sees only own tenant.
- Global admin can access platform-level tools.
- Bulk email only emails active tenant.
- Import only affects active tenant.

Suggested prompt:

> Add frontend and integration tests for picks/results, enter-picks, analytics, and admin tenant-scoping behavior.

## Stage 9: Tenant Creation and Onboarding

Add product-level flows for creating and managing new tenants.

Deliverables:

- Global admin can create a tenant.
- Tenant admin can invite or create users.
- Tenant admin can create/edit players.
- New-user password reset/onboarding works.
- New tenants can start without Andy-specific integrations enabled.

Suggested prompt:

> Add global-admin tenant creation and tenant-admin onboarding flows for users and players.

## Stage 10: Product Decoupling

Move current-pool-specific behavior out of the core product path.

Deliverables:

- Make Andy survey submission optional per tenant.
- Disable external submission by default for new tenants.
- Keep it enabled only for the current tenant if still needed.
- Rename or configure app branding where appropriate.
- Remove hard-coded current-pool assumptions from docs and UI over time.

Suggested prompt:

> Move Andy-specific submission and current-pool branding behind optional tenant configuration.

## Stage 11: Production Migration and Rollback

Prepare the final release process.

Checklist:

- Run migration against the cloned DB.
- Compare old/new leaderboard outputs for the current tenant.
- Compare picks/results row counts.
- Compare user/player assignments.
- Smoke test the frontend.
- Take a production backup.
- Apply migration.
- Keep old DB available for quick rollback.

Suggested prompt:

> Prepare and run the production migration checklist for the multi-tenant release, including validation queries and rollback notes.

## Scheduler Architecture

The backend runs an internal asyncio scheduler (1-minute heartbeat) for score sync, kickoff sync, and weekly emails. This is kept in-process rather than moved to an external trigger service because:

- The `scheduler_runs` table plus PostgreSQL advisory locks already prevent double-runs across concurrent instances.
- The background task is essentially idle (sleeping) except during game windows, so B1 overhead is negligible.
- An external trigger would add operational complexity (authenticated endpoint, external cron service, separate log aggregation) for a problem already solved.

The one required change for multi-tenancy: email jobs currently assume one pool. They must be updated to loop over tenants (or dispatch per-tenant) when tenant count grows. Address in Stage 5.

## Known Limitations / Out of Scope

- **Seasons**: `weeks` (1–18) and `games` implicitly represent one NFL season. Multiple tenants running different seasons simultaneously is not modeled. Each season, the games and weeks tables are reset. This is a known constraint; a `season_id` concept is left for a future iteration.
- **Pool size**: The 68-pigeon cap is removed from the schema constraint. Individual tenants may configure pool sizes differently through application logic, but there is no formal `max_players` per-tenant setting in this plan.

## Immediate Recommended Sequence

1. Clone the DB.
2. Add baseline backend tests.
3. Update the from-scratch schema.
4. Write and test the migration.
5. Update backend in single-tenant compatibility mode.
6. Add role separation.
7. Add tenant selection UX.
8. Expand frontend/integration tests.

