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

## Stage 4: Backend Single-Tenant Compatibility ✅ COMPLETE

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

### Completion notes

Updated five files to use the tenant-aware schema:

- **`backend/routes/auth.py`** — `find_user` no longer selects `is_admin` (dropped). `select_primary_pigeon` replaced by `select_primary_player` using `tenant_members.primary_player_id`. `current_user` validates via `user_players(user_id, player_id)` and joins `tenant_members` for `role`/`tenant_id`. `MeOut` and `AuthUser` gain `player_id` and `tenant_id`. `is_admin` is now derived from `tenant_members.role = 'commissioner'`. JWT token format is unchanged (`sub = pigeon_number`, which equals `player_id` for the single backfilled tenant).
- **`backend/routes/picks.py`** — Lock check uses `tenant_weeks(tenant_id, week_number)`. Upsert uses `player_id` FK; RETURNING joins `players` to surface `pigeon_number` for the unchanged `PickOut` response. GET query filters by `player_id` and `tenant_id` via `v_picks_filled`.
- **`backend/routes/results.py`** — `WEEK_LOCKED_SQL` queries `tenant_weeks`. All view queries add `tenant_id = :tenant_id` filter. `ALL_LOCKED_LEADERBOARD_SQL` joins `tenant_weeks` instead of `weeks.lock_at`.
- **`backend/routes/schedule.py`** — `GET /schedule/current_week` now requires auth (lock times are per-tenant). Query uses `tenant_weeks` with `me.tenant_id`. `GET /{week}/games` remains unauthenticated (games are global).
- **`backend/utils/submit_picks_to_andy.py`** — Picks query now joins `players` to resolve `pigeon_number → player_id` since `picks.pigeon_number` was dropped.
- **`tests/conftest.py`** — Auth fixture updated to use `tenant_members` + `players` instead of dropped `users.is_admin` and `user_players.pigeon_number`.

**Deferred to Stage 5/6:**
- `backend/routes/admin.py` — All admin/commissioner endpoints remain broken (use dropped columns: `weeks.lock_at`, `user_players.pigeon_number`, `user_players.is_primary`, `users.is_admin`). Fix in Stage 5.
- `backend/utils/score_sync.py` — Still inserts into `weeks.lock_at` (dropped); will fail if scheduler is re-enabled. The scheduler is currently disabled (`DISABLE_SCHEDULER=True` in `main.py`). Fix before re-enabling.
- `backend/utils/import_picks_xlsx.py` — Uses `pigeon_number` as player identifier. Fix in Stage 5/6.

## Stage 5: Backend Fixes and Multi-Tenant Auth ✅ COMPLETE

Fix all backend breakage deferred from Stage 4, update the JWT token shape, and add
multi-tenant auth UX. The original Stages 5 and 6 are merged here because the JWT
token change and admin-route fixes are tightly coupled.

### Role model

There is no global-admin concept. The two roles are:

- **Commissioner**: tenant-level admin who manages players, users, lock times, and
  emails within one tenant. Represented by `tenant_members.role = 'commissioner'`.
- **Member**: regular participant. Represented by `tenant_members.role = 'member'`.

`users.is_admin` was dropped in Stage 2 and is not reintroduced. `require_admin` in
`auth.py` enforces commissioner-only access.

### JWT token shape (breaking change from Stage 4)

- `sub` = `str(player_id)` — was `pigeon_number`; now unambiguously `player_id`
  (numerically equal for all Stage-3-migrated rows).
- `tid` = `tenant_id` — new claim; used by `current_user` to scope the DB join.
- `uid` = `user_id` — unchanged.
- `adm` claim dropped — was redundant with the DB join in `current_user`.
- Existing Stage-4 tokens are invalidated; users must log in again.

### Deliverables

**Schema (migration `database/migration_stage5.sql`):**
- Add `last_used_at TIMESTAMPTZ` to `tenant_members`. Tracks which tenant a user last
  signed into; used to auto-select the default tenant on next login.

**`backend/routes/auth.py`:**
- `make_session_token` updated to new JWT shape.
- `current_user` uses `tid` from token to scope the `tenant_members` join.
- Login auto-selects the most-recently-used tenant (by `last_used_at`) where the user
  is still a member; falls back to any tenant. Sets `last_used_at` on the chosen row.
- `POST /auth/select-context` — validates membership in the requested tenant, issues a
  new token scoped to that tenant, updates `last_used_at`.
- `/auth/me` expanded to include `available_tenants` list (so the frontend knows
  whether to show a tenant switcher).

**`backend/routes/admin.py` (commissioner endpoints):**
- All routes updated to use the new schema: `tenant_weeks` (not `weeks.lock_at`),
  `player_id` (not `pigeon_number`), `tenant_members` (not `users.is_admin` or
  `user_players.is_primary`). All data-access routes scoped to `me.tenant_id`.
- `POST /admin/activate-season` — copies `weeks.default_lock_at` into `tenant_weeks`
  for the commissioner's tenant (idempotent). Errors if `default_lock_at` is not yet
  populated (i.e. no schedule has been imported for the new season).

**`backend/utils/score_sync.py`:**
- `load_schedule()` writes `weeks.default_lock_at` instead of the dropped `weeks.lock_at`.
- Does not touch `tenant_weeks`; each commissioner activates their own season via
  `POST /admin/activate-season`.

**`backend/utils/import_picks_xlsx.py`:**
- Raises `NotImplementedError` with a clear message. The historical XLSX import used
  `pigeon_number` as the player identifier, but `picks` now uses `player_id`. Full fix
  and end-to-end testing are deferred to Stage 8 (cannot be tested until the next NFL
  season provides new data).

**`database/seed_test_tenant.sql`:**
- One-time script to create a second tenant for local multi-tenant testing.
- Copies `weeks.default_lock_at` → `tenant_weeks` for the new tenant.
- Adds a placeholder user as commissioner — edit the email placeholder before running.
- Run with: `psql -U postgres -d pigeon_pool_multi -f database/seed_test_tenant.sql`

### Completion notes

- **`database/migration_stage5.sql`** — adds `last_used_at TIMESTAMPTZ` to `tenant_members`. Run before deploying.
- **`backend/routes/auth.py`** — new JWT shape (`sub=player_id`, `tid=tenant_id`, `uid=user_id`; `adm` dropped). `current_user` scopes DB join to `tenant_id` from token. Login auto-selects last-used tenant and sets `last_used_at`. `POST /auth/select-context` issues a new scoped token. `/auth/me` returns `available_tenants` list. Stage-4 tokens are invalid; users must log in again.
- **`backend/routes/admin.py`** — all routes rewritten to use `tenant_weeks`, `player_id`, `tenant_members`. Routes scoped to `me.tenant_id`. `POST /admin/activate-season` copies `weeks.default_lock_at` → `tenant_weeks` for the active tenant. XLSX import endpoint now returns HTTP 501.
- **`backend/utils/score_sync.py`** — `load_schedule()` writes `weeks.default_lock_at` instead of dropped `weeks.lock_at`. Does not touch `tenant_weeks`.
- **`backend/utils/import_picks_xlsx.py`** — `import_picks_pivot_xlsx_with_engine` raises `NotImplementedError`. Full fix deferred to Stage 8.
- **`database/seed_test_tenant.sql`** — creates a second tenant with a commissioner for local multi-tenant testing. Edit the email placeholder and run once with `psql`.
- **`tests/conftest.py`** — updated to use new `make_session_token(player_id, tenant_id, email, uid)` signature.
- All 5 snapshot tests pass.

### Testing after this stage

- All commissioner UI pages load (picks page already worked; pigeons and users pages
  were broken due to old schema references — now fixed).
- Log in as commissioner → `available_tenants` in `/auth/me` shows multiple tenants
  if the seed script has been run.
- `POST /auth/select-context` switches tenant and issues a new scoped token.
- After switching, commissioner pages show data for the new tenant only.

## Stage 6: Frontend Commissioner and Tenant UX ✅ COMPLETE

Bring the commissioner (admin) UI to a fully working state under the new multi-tenant
schema, and add tenant-switching UX so users with multiple tenants can switch without
touching the API directly.

### Deliverables

**Commissioner roster page (`frontend/src/pages/admin/AdminRoster.tsx`):**
- **Create pigeon** — "New Pigeon" button opens a dialog with a required name field and
  optional number field (auto-assigned if blank, via `POST /admin/pigeons`). On success,
  the new pigeon is appended to the list and auto-selected.
- **Update pigeon** — `adminUpdatePigeon` now uses `player_id` in the URL path (not
  `pigeon_number`) to match the backend PATCH route.
- **Create user** — "Add new user" dialog now includes a pigeon autocomplete; the user
  must choose a primary pigeon before the Create button enables. Passes
  `{ email, primary_pigeon }` to `POST /admin/users`, which atomically creates the
  `users` + `user_players` + `tenant_members` rows. Prevents the "orphaned user" bug
  from Stage 5 testing.

**Frontend type updates (`frontend/src/backend/types.ts` / `fetch.ts`):**
- `AdminPigeon` gains `player_id: number` field and constructor validation.
- `AdminPigeonCreateIn` interface added (`pigeon_name`, optional `pigeon_number`).
  Imported as `import type` so esbuild strips it (interfaces have no runtime value).
- `AdminUserCreateIn` requires `primary_pigeon: number`.
- `adminCreatePigeon()` added to `fetch.ts` (`POST /admin/pigeons`).
- `adminUpdatePigeon()` now takes `playerId: number` (was `pigeonNumber`).

**Tenant switching:**
- `TenantInfo` interface added to `types.ts` (`tenant_id`, `name`, `role`).
- `Me` class gains `tenant_id: number`, `available_tenants: TenantInfo[]`,
  `activeTenant` getter, and `canSwitchTenant` getter.
- `apiSelectTenantContext(tenant_id)` added to `fetch.ts` — POSTs to
  `/auth/select-context`, stores the new JWT, returns the updated `Me`.
- `switchTenant(tenant_id)` added to `AuthContext`; calls the above then triggers a
  full page reload so all page-level data re-fetches against the new tenant.
- `UserMenuAvatar` shows the active tenant name and role, plus "Switch to: X" items for
  each other tenant. Only visible when the user belongs to more than one tenant.
- App-bar title replaced with `me.activeTenant.name` (falls back to `"Pigeon Pool"`
  when auth hasn't resolved). Makes it immediately clear which pool the user is in.

### Completion notes

- All TypeScript compiles cleanly (`tsc --noEmit` zero errors after all changes).
- Correct workflow for a new tenant: create pigeons first, then create users (each user
  requires an existing primary pigeon). Attempting the reverse is blocked at the UI level.
- Tenant switch triggers `window.location.reload()` — simple and correct, if slightly
  jarring. Noted in Known Limitations for future improvement.
- The `import type` fix for interfaces avoids a browser ES-module error where Vite emits
  the bare `import { InterfaceName }` and the browser can't find it as a runtime export.

## Stage 7: Frontend Cleanup ✅ COMPLETE

Removed the buggy auto-refresh polling hook and fixed the hard-coded player range in
the commissioner picks view.

**Scope actually implemented (narrower than original plan — see notes):**

- Deleted `frontend/src/hooks/useAutoRefreshManager.ts` (~200 lines). The hook had two
  overlapping timers, a >2-day stale-data heuristic, and a kickoff-transition detector.
  Browser refresh is sufficient; users are not watching a live dashboard.
- Removed the import and call site from `App.tsx`.
- Removed stale "handled by useAutoRefreshManager" comments from `PicksAndResults.tsx`,
  `Analytics.tsx`, and the docblock in `resultsShaping.ts`.
- Fixed `EnterPicks`: the commissioner pigeon selector was hard-coded to numbers 1–68.
  Now fetches the tenant's actual player list via `adminGetPigeons()` on mount and uses
  that to populate the extra options.

**Deliberately left unchanged:**

- `scoreForPick` and the rank/points aggregation in `shapeRowsAndGames` — the original
  plan suggested removing these and trusting backend leaderboard ranks, but this was
  incorrect. `Top5Playground` and `bestPossibleRank` both import `scoreForPick` directly;
  removing it would break both. The frontend scoring logic has been battle-tested through
  a full season. `useYtd` already uses the backend leaderboard independently. Fixing the
  divergence between the two scoring paths (frontend missing the missed-pick penalty,
  backend capping at 800) is deferred to a future stage when the season is running and
  the numbers can be verified end-to-end.
- `player_id` vs `pigeon_number` in picks/results/analytics — since `player_id ==
  pigeon_number` for all migrated rows, there is no functional bug today. The deeper
  type cleanup (adding `player_id` to `AltPigeon`, switching row identity keys) is also
  deferred until a second tenant exists and can be tested.

### Suggested prompt

> Update the remaining frontend pages (EnterPicks, PicksAndResults, YTD, Analytics) so
> player identity uses `player_id` throughout. Remove the auto-refresh polling hook and
> the duplicate scoring logic, replacing auto-refresh with a manual refresh button.

## Stage 8: Product Decoupling

Move current-pool-specific behavior out of the core product path.

Deliverables:

- Make Andy survey submission optional per tenant.
- Disable external submission by default for new tenants.
- Keep it enabled only for the current tenant if still needed.
- Rename or configure app branding where appropriate.
- Remove hard-coded current-pool assumptions from docs and UI over time.

Suggested prompt:

> Move Andy-specific submission and current-pool branding behind optional tenant configuration.

## Stage 9: Tenant Creation and Onboarding ✅ COMPLETE

Add operator-level CLI commands for tenant lifecycle management and a commissioner-facing
"League Settings" page for renaming the league.

**Design decisions made during this stage:**

- **Model A (curated pools)** — users are always created by a commissioner; no
  self-registration. A user with no tenant is a setup error, not a UX state (403).
- **No invite email** — commissioners handle new-user communication out-of-band. New users
  go to the site and use "Forgot Password" to set their password before first login. This
  avoids spam-folder issues with transactional email from new domains.
- **Tenant creation via CLI only** — no API endpoint. The CLI is safer (no auth surface to
  protect, runs only on the server) and sufficient for the curated-pool model.

### Completion notes

**`backend/cli.py` — three new commands:**

- `list-leagues` — tabular view of all tenants with member and player counts.
- `create-league --name "X" --commissioner-email user@example.com` — creates tenant,
  placeholder player "Commissioner" (pigeon_number=1), links the user as commissioner,
  copies `weeks.default_lock_at` into `tenant_weeks`. Commissioner must already have a
  user account. Rename the placeholder via League Settings after first login.
- `delete-league <tenant_id> [--yes]` — shows what will be deleted (members, players,
  picks), prompts for confirmation unless `--yes` is passed. Deletes in order:
  `tenant_members` → orphaned `users` → `players` (cascades picks/user_players) →
  `tenants` (cascades tenant_weeks). Users who belong only to the deleted league are also
  deleted; users in multiple leagues keep their accounts.

**`backend/routes/admin.py` — one new endpoint:**

- `PATCH /admin/league` — commissioner renames their active tenant. Body: `{name: str}`.
  Returns 204. Empty name returns 400.

**Frontend:**

- Nav label `"Admin"` → `"League Settings"` (`App.tsx`).
- Admin tab `"Pigeons"` → `"Roster"` (same route `/admin/pigeons`, label only).
- New tab `"Settings"` → `/admin/settings` → `AdminSettings.tsx`. Shows the current
  league name in a text field; Save calls `PATCH /admin/league` then `refresh()` so the
  app-bar title updates immediately.
- `frontend/src/backend/fetch.ts`: `adminUpdateLeague(name)` added.

**Onboarding flow (end-to-end):**

1. Operator: `python -m backend.cli create-league --name "…" --commissioner-email …`
2. Commissioner logs in (existing account), sees their new league in the tenant switcher.
3. Commissioner: League Settings → create players → create users.
4. New users visit the site, click "Forgot Password", set their password, log in.

## Stage 10: New League Year

Last development milestone. Implements everything needed to transition from one NFL season
to the next, plus two new commissioner features (player season status and configurable
payouts). Manually verified end-to-end on localhost with live 2025 season data.

### Season transition

**`reset-season` CLI command** (`backend/cli.py`):

1. Archive: for each tenant, write a CSV of all picks joined with game/result data to
   a local file (e.g. `archive/<tenant_id>_<year>_picks.csv`). The commissioner can
   save these for later analytics or import into a spreadsheet.
2. Wipe: delete all rows from `games` (cascades `picks`). Tenant and player data are
   untouched.
3. Reset: set `players.season_status = 'pending'` for all players across all tenants.
4. Sync: run the equivalent of `sync-schedule` to import the new season's games and
   populate `weeks.default_lock_at`.

After `reset-season`, each commissioner logs in and clicks "Activate Season" in League
Settings (already implemented) to copy the default lock times into their tenant.

### Player season status

Tracks each pigeon's participation state for the coming season. Resets to `pending`
every season so commissioners start with a clean slate.

**Schema** (`database/migration_stage10.sql`):
```sql
ALTER TABLE players
  ADD COLUMN season_status TEXT NOT NULL DEFAULT 'pending'
  CHECK (season_status IN ('pending', 'active', 'out'));
```

- `pending` — default; assumed returning but not yet confirmed
- `active` — confirmed (e.g. paid entry fee, told commissioner they're in)
- `out` — dropping this season

**Backend**: expose `season_status` in `GET /admin/pigeons` response and accept it in
`PATCH /admin/pigeons/{player_id}`.

**Frontend**: show a status badge/dropdown per pigeon in the Roster tab. Commissioner
can change status inline.

### Configurable payout structure

Commissioners can define how many points each finishing place pays per week and for the
overall standings. The "top 5 pays" threshold stays hardcoded for now (see backlog).

**Schema** (`database/migration_stage10.sql`):
```sql
CREATE TABLE tenant_payouts (
  tenant_id BIGINT NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  place     INT    NOT NULL CHECK (place >= 1),
  points    INT    NOT NULL CHECK (points >= 0),
  PRIMARY KEY (tenant_id, place)
);
```

Seed default values for existing tenants from the current hardcoded amounts.

**Backend**: `GET /admin/payouts` and `PUT /admin/payouts` (replaces all rows for the
tenant atomically).

**Frontend** (League Settings → new "Payouts" section):
- Table with one row per place (1–5), editable points field.
- Calculator below: **Total annual prize pool = sum(points) × 19** (18 weekly winners
  + 1 overall winner). Updates live as commissioner types.
- Save button replaces all rows atomically.

### Code fixes included in this stage

These were deferred from earlier stages and are required before manual testing:

- **`fetch.ts` `withPigeon()` hardcoded cap**: remove the `> 68` guard; switch
  alt-player management to use `player_id` throughout.
- **`AltPigeon` missing `player_id`**: add `player_id` to the type and use it in the
  picks API call instead of `pigeon_number`.
- **`import_picks_xlsx` raises `NotImplementedError`**: rewrite for `player_id` schema
  and test end-to-end with new-season data.
- **Scheduler email jobs cross-tenant**: loop over tenants in `run_email_sun`,
  `run_email_mon`, and `run_email_tue_warn`; filter recipients and winner query by
  `tenant_id`.

### Manual test checklist

- `reset-season` archives CSVs, wipes games/picks, resets season_status.
- `sync-schedule` loads 2025 games and default lock times.
- Commissioner activates season; lock times appear correctly.
- Commissioner updates pigeon season statuses (pending / active / out).
- Commissioner configures payouts; calculator shows correct total.
- Player enters picks before lock; picks are saved.
- Picks are rejected after lock.
- Alt-player pick entry works (player_id routing, not pigeon_number).
- Results page shows correct data after week locks.
- Leaderboard ranks correctly against new payout structure.
- Sunday/Monday/Tuesday emails fire with correct recipients and content per tenant.
- XLSX pick import works end-to-end.

Suggested prompt:

> Implement Stage 10: reset-season CLI command, player season_status field, configurable
> tenant payout structure, and the deferred code fixes (AltPigeon/player_id, withPigeon
> cap, import_picks_xlsx, multi-tenant email jobs).

### Completion notes

All deliverables implemented:

**Database (`database/migration_stage10.sql`)**
- `players.season_status TEXT NOT NULL DEFAULT 'pending' CHECK (IN ('pending','active','out'))`
- `tenant_payouts` table `(tenant_id, place, points)` with `PRIMARY KEY (tenant_id, place)`
- Tenant 1 seeded with 530/270/160/100/70 for places 1–5

**Backend code fixes:**
- `backend/routes/auth.py` — `AltPigeon` now includes `player_id`; `/auth/me` returns it
- `backend/routes/picks.py` — `withPigeon` param renamed to `player_id`; `_resolve_acting_player` verifies tenant membership for admin path
- `backend/utils/scheduled_jobs.py` — all three email jobs (`run_email_sun/mon/tue_warn`) loop per tenant, use `_get_tenant_emails`, subject/signature include tenant name
- `backend/utils/import_picks_xlsx.py` — rewritten to use `player_id` (via `pigeon_to_player` lookup dict); no longer creates players; 403 on non-tenant-1 call from the API

**New features:**
- `backend/routes/admin.py` — `GET /admin/payouts` (any member) and `PUT /admin/payouts` (admin); pigeon rows include `season_status`; `PATCH /admin/pigeons/{id}` accepts `season_status`
- `backend/cli.py` — `reset-season` command (archive CSV per tenant → delete games → delete tenant_weeks → reset season_status → sync schedule → reseed lock times); payout seeding added to `create-league`; `show-email-recipients` fixed (broken `weeks.lock_at` and `f.pigeon_number` references removed, now per-tenant)
- Frontend `types.ts` — `player_id` added to `AltPigeon` and `Me`; `season_status` added to `AdminPigeon`; `AdminPigeonUpdateIn` accepts `season_status`; `PayoutRow` interface added
- Frontend `fetch.ts` — `withPigeon()` uses `player_id` param (removed `> 68` guard); `getPayouts()` and `adminPutPayouts()` added
- Frontend `useAppCache.ts` — `payouts: TimeStamped<PayoutRow[]>` cache entry with 1-hour TTL
- Frontend `EnterPicks.tsx` — pigeon selector keyed by `player_id`; all picks API calls use `player_id`
- Frontend `AdminRoster.tsx` — season status selector (pending/active/out) added to PigeonsPanel
- Frontend `AdminSettings.tsx` — `PayoutsEditor` section added below league name (editable table, prize pool calculator, save button)
- Frontend `AboutPage.tsx` — payout table replaced with dynamic data from `GET /admin/payouts` via Zustand cache

## Stage 11: Backend Integration Tests

Build a durable backend test suite so future changes have less chance to break things.

### Completion notes

- Rewrote `tests/conftest.py` with session-scoped fixtures: two isolated test tenants,
  adaptive `scored_games` (uses real game IDs when available, inserts synthetic games
  otherwise), pre-minted JWT tokens, and `insert_pick`/`pick_cleaner` helpers.
- Created `tests/test_auth.py`, `tests/test_picks.py`, `tests/test_results.py`,
  `tests/test_admin.py`, `tests/test_tenant_isolation.py` — 54 tests total, all passing.
- Added `database/migration_stage11.sql`: `ON DELETE CASCADE` on `players.tenant_id`
  (pigeon deletion now cascades from tenant delete; users are unaffected).
- Added `python -m backend.cli run-sql <file>` command for applying SQL migration files
  without requiring a separate psql install.
- Added `docs/tests.md` with design rationale (auth approach, adaptive fixture, lock
  bypass, scoring formula mirror).
- Deferred: XLSX import round-trip, email job recipient tests (edge cases, low priority).
- Snapshot tests (`test_snapshots.py`) updated to reflect post-reset-season DB state.
  Revert snapshots before restoring last year's DB for regression testing.

## Stage 12: Frontend Tests

Choose a framework (Playwright or Vitest + React Testing Library) and cover:

- Login and tenant switch flow.
- Enter Picks: submit, reject after lock, alt-player.
- Picks and Results: before/after lock visibility, scoring display.
- Analytics: tenant-scoped rows, top 5, MNF outcomes, best possible rank.
- League Settings: rename, payout editor, season activation, roster management.
- Season status badges update and persist.

Note: `MnfOutcomes.tsx` uses `new Date()` directly (line 63) — the only place requiring
genuine clock control. Will need injection or mocking for that component's tests.

Suggested prompt:

> Build the Stage 12 frontend test suite using [chosen framework]. Cover the flows listed
> in docs/multi.md Stage 12. Note the MnfOutcomes date dependency.

## Stage 13: Production Migration and Deployment

Ops-only stage. No new development. Run after Stage 12 tests pass.

Checklist:

- Run `database/db_update.sql` + stage migrations against the cloned DB; verify row
  counts and leaderboard output match the original.
- Smoke test the frontend against the clone.
- Take a production backup (point-in-time snapshot).
- Apply migrations to production DB.
- Deploy updated backend and frontend.
- Run `reset-season` when the 2024 season data is ready to be archived.
- Keep the old `pigeon_pool` DB available for at least one season as a rollback target.

Suggested prompt:

> Run the production migration checklist and deploy the multi-tenant release.

## Scheduler Architecture

The backend runs an internal asyncio scheduler (1-minute heartbeat) for score sync, kickoff sync, and weekly emails. This is kept in-process rather than moved to an external trigger service because:

- The `scheduler_runs` table plus PostgreSQL advisory locks already prevent double-runs across concurrent instances.
- The background task is essentially idle (sleeping) except during game windows, so B1 overhead is negligible.
- An external trigger would add operational complexity (authenticated endpoint, external cron service, separate log aggregation) for a problem already solved.

The required change for multi-tenancy: email jobs currently query `tenant_weeks` and
`v_weekly_leaderboard` without a `tenant_id` filter, and `get_all_player_emails` returns
all users across all tenants. Fine for one tenant; breaks when a second tenant goes live.
Fix scheduled for Stage 10.

## Known Limitations / Out of Scope

- **Seasons**: `weeks` (1–18) and `games` implicitly represent one NFL season. Multiple
  tenants running different seasons simultaneously is not modeled. The season transition
  flow (archive → wipe → sync) is implemented in Stage 10 via `reset-season`. A formal
  `season_id` concept (to keep multiple seasons live simultaneously) is left for a future
  iteration.
- **Pool size**: The 68-pigeon cap is removed from the schema constraint. Individual tenants may configure pool sizes differently through application logic, but there is no formal `max_players` per-tenant setting in this plan.
- **Tenant switch triggers full page reload**: `switchTenant` stores the new JWT then calls `window.location.reload()` so all page-level data re-fetches against the new tenant. A future improvement would invalidate per-page query caches (e.g., via React Query) and re-render in place without a full reload.

## Immediate Recommended Sequence

1. Clone the DB.
2. Add baseline backend tests.
3. Update the from-scratch schema.
4. Write and test the migration.
5. Update backend in single-tenant compatibility mode.
6. Add role separation.
7. Add tenant selection UX.
8. Expand frontend/integration tests.

