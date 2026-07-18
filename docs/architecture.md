# Architecture

Design decisions behind the multi-tenant data model, auth, and background jobs. This is
the durable reference — for directory structure and frontend data flows see
[docs/frontend.md](frontend.md); for the one-time production migration and season-transition
runbook see [docs/deployment.md](deployment.md) (deleted once the migration is done).

## Multi-tenancy data model

- **`tenants`** — one row per league/pool.
- **`tenant_members`** — tenant membership independent of player ownership: `(tenant_id, user_id)`,
  `role IN ('commissioner', 'member')`, `primary_player_id` (the user's default pigeon when
  they belong to more than one), `last_used_at` (drives auto-selecting a tenant on login).
  Preferred over a nullable `player_id` on `user_players` because a tenant admin who doesn't
  compete still needs a membership row. Every member currently must have a player — there's
  no non-competing-admin case yet; revisit if one comes up.
- **`players`** — stable `player_id` (numeric PK, independent of the display `pigeon_number`).
  `pigeon_number` is unique per tenant, not globally, and the old 68-pigeon cap is gone
  (`CHECK (pigeon_number >= 1)` only) — tenants can size their pool however they like, though
  there's no formal `max_players` setting to enforce a chosen size.
- **`user_players`** — links a login (`user_id`) to the player(s) it controls, with
  `role IN ('owner', 'manager', 'viewer')` for alt-pigeon management.
- **`picks`** — keyed by `player_id` (not `pigeon_number`).
- **`tenant_weeks`** — per-tenant lock time for each of the 18 global `weeks`. `weeks` itself
  (the week numbers and `default_lock_at` template) stays global — only lock time is
  tenant-specific, since every tenant runs the same NFL schedule but sets its own deadlines.
  A missing `tenant_weeks` row is treated as *unlocked* by the pick-lock trigger, which is why
  "Activate Season" (copying `default_lock_at` → `tenant_weeks`) is a required step before a
  tenant's picks should be trusted as gated — see [docs/deployment.md](deployment.md).
- **`players.season_status`** (`pending` / `active` / `out`) — tracks whether a returning
  pigeon is confirmed in for the season. Resets to `pending` for everyone on `reset-season`.
  Currently informational only (Roster tab display/edit) — nothing blocks a `pending` player
  from submitting picks once their week unlocks. See backlog for the proposal to enforce it.
- **`tenant_payouts`** — `(tenant_id, place, points)`, one row per paying finish position.
  Commissioner-configurable via League Settings; the "top N places pay" count (rows with
  `points > 0`) is derived from this table across analytics/YTD/About.

## Auth & sessions

- JWT claims: `sub` = `player_id`, `tid` = `tenant_id`, `uid` = `user_id`. No `adm` claim —
  role is derived by joining `tenant_members` on `(tid, uid)` at request time, not baked into
  the token.
- There is no global-admin concept. `tenant_members.role = 'commissioner'` gates commissioner
  (League Settings) routes via `require_admin`; everyone else is `'member'`.
- Login auto-selects the tenant with the most recent `tenant_members.last_used_at` for that
  user, falling back to any tenant they belong to.
- `POST /auth/select-context` validates membership in the requested tenant, issues a new
  token scoped to it, and updates `last_used_at`. The frontend's tenant switcher calls this
  then does a full `window.location.reload()` so every page re-fetches against the new
  tenant — simple and correct, but jarring; a cache-invalidation approach without the reload
  is deferred (see [docs/backlog.md](backlog.md)).

## Tenant onboarding (curated-pool model)

- **No self-registration.** A commissioner always creates users; a user with no tenant is a
  setup error, not a UX state.
- **No invite email.** New users go to the site and use "Forgot Password" to set their
  password before first login — avoids spam-folder issues with transactional email from a
  new domain, and keeps the CLI-driven onboarding simple.
- **Tenant creation is CLI-only**, run by the operator (`list-leagues` / `create-league` /
  `delete-league` — see README's CLI reference for usage). No API endpoint exists, so there's
  no auth surface to protect; sufficient for a curated-pool model where leagues aren't
  self-serve.

## Scheduler

The backend runs an in-process asyncio scheduler (1-minute heartbeat) for score sync, kickoff
sync, and weekly emails, rather than an external trigger service:

- The `scheduler_runs` table plus PostgreSQL advisory locks already prevent double-runs across
  concurrent instances.
- The background task is essentially idle (sleeping) except during game windows, so the B1
  App Service tier overhead is negligible.
- An external trigger would add operational complexity (authenticated endpoint, external cron
  service, separate log aggregation) for a problem already solved in-process.

Weekly email jobs (`run_email_sun` / `run_email_mon` / `run_email_tue_warn`) loop per tenant
and filter recipients by `tenant_id` — required once a second tenant exists, since the
underlying queries (`tenant_weeks`, `v_weekly_leaderboard`, recipient lists) are otherwise
tenant-agnostic.

## Known limitations / out of scope

- **Seasons**: `weeks` (1–18) and `games` implicitly represent one NFL season shared by every
  tenant. Multiple tenants running different seasons simultaneously isn't modeled. Season
  transition (archive → wipe → resync) is the `reset-season` CLI command — see
  [docs/deployment.md](deployment.md). A formal `season_id` to keep multiple seasons live at
  once is a future iteration if it's ever needed.
- **Pool size**: no formal `max_players` per tenant, even though the schema no longer caps at 68.
- **Tenant switch reload**: see Auth & sessions above.
- **`season_status` not enforced**: see Multi-tenancy data model above and
  [docs/backlog.md](backlog.md).
