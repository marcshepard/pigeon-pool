# Architecture

Design decisions behind the multi-tenant data model, auth, and background jobs. This is
the durable reference — for directory structure and frontend data flows see
[docs/frontend.md](frontend.md).

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
  `role IN ('owner', 'manager', 'viewer')` for alt-pigeon management. Every pigeon must have
  exactly one owner and may have additional managers. Owner and manager currently grant the
  same application access; owner identifies the primary administrative contact. The database's
  partial unique index enforces at most one owner, while the roster API enforces that an owner is
  always supplied. The unused `viewer` role is preserved but is not exposed by roster management.
- **`picks`** — keyed by `player_id` (not `pigeon_number`).
- **`tenant_weeks`** — per-tenant lock time for each of the 18 global `weeks`. `weeks` itself
  (the week numbers and `default_lock_at` template) stays global — only lock time is
  tenant-specific, since every tenant runs the same NFL schedule but sets its own deadlines.
  A missing `tenant_weeks` row is treated as *unlocked* by the pick-lock trigger, which is why
  "Activate Season" (copying `default_lock_at` → `tenant_weeks`) is a required step before a
  tenant's picks should be trusted as gated.
- **`players.season_status`** (`pending` / `active` / `out`) — tracks whether a returning
  pigeon is confirmed in for the season. Resets to `pending` for everyone on `reset-season`.
  Currently informational only (Roster tab display/edit) — nothing blocks a `pending` player
  from submitting picks once their week unlocks.
- **`tenant_payouts`** — `(tenant_id, place, points)`, one row per paying finish position.
  Commissioner-configurable via League Settings; the "top N places pay" count (rows with
  `points > 0`) is derived from this table across analytics/YTD/About.
- **`tenants.pigeons_can_rename`** (default `true`) — whether a pigeon's owner/manager can
  rename it themselves via `PATCH /players/{player_id}/name` (avatar menu → "Rename
  pigeon…"), instead of asking the commissioner to do it via the Roster tab. Gated by the
  same `role IN ('owner','manager')` check picks submission already uses — commissioners
  can always rename any pigeon via the Roster tab regardless of this setting. Name is
  validated to 1-30 printable characters, trimmed of leading/trailing whitespace.

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
  is deferred.
- `PUT /me/primary-pigeon` lets a user choose another pigeon they own or manage as the default
  for future sessions. It updates `tenant_members.primary_player_id` but deliberately does not
  replace existing JWTs, so an already-open session may continue using its current pigeon.

## Roster administration

Commissioner roster changes use a pigeon aggregate rather than separate pigeon and user
workflows:

| Method | Endpoint | Behavior |
|--------|----------|----------|
| `GET` | `/admin/pigeons` | Returns each pigeon with its owner, additional managers, status, and per-person primary flags. |
| `POST` | `/admin/pigeons` | Creates a pigeon plus all owner/manager relationships in one transaction. |
| `PUT` | `/admin/pigeons/{player_id}` | Replaces the pigeon's name, status, owner, and manager set in one transaction. |
| `DELETE` | `/admin/pigeons/{player_id}` | Deletes a preseason pigeon and repairs affected memberships and primaries. |

Pigeon numbers are display/order values assigned by the server. Creation fills the lowest
available positive number; deletion leaves a gap until a later create fills it. Mutation routes
always use stable `player_id` values.

Owner and manager emails are resolved against the global case-insensitive user identity. A new
account is created when there is no match; otherwise the existing account is linked into the
active tenant. New memberships receive the `member` role, while an existing role—including
`commissioner`—is preserved. Roster operations never delete global `users` rows or relationships
in another tenant.

The submitted owner and manager lists are the complete desired state. Changing the owner does not
implicitly preserve the former owner as a manager. If the new owner was an additional manager,
that relationship becomes owner so the person is not listed twice.

After each mutation, a user's existing primary remains unchanged if it is still assigned. If it
was removed, the lowest-numbered remaining owned/managed pigeon becomes primary. An ordinary
member with no remaining assignment is removed from that tenant only. A mutation that would
remove any commissioner's final pigeon assignment is rejected. Each mutation is atomic and
tenant-scoped; simultaneous edits of the same pigeon use last-write-wins behavior.

The obsolete split `/admin/users` workflow and partial admin pigeon `PATCH` endpoint were removed.
The member-facing pigeon-name endpoint remains separate because it has different authorization.

Before deploying roster changes, run the read-only integrity validator:

```bash
python -m backend.cli validate-rosters
python -m backend.cli validate-rosters --tenant 2
python -m backend.cli validate-rosters --json
```

It reports invalid owner counts, memberships, assignments, primary pigeons, roles, pigeon fields,
and missing commissioners. Orphaned global users are informational warnings only. The command
never repairs or deletes data and exits nonzero only when integrity errors are present.

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
  transition (archive → wipe → resync) is the `reset-season` CLI command — see the
  [README's CLI reference](../README.md#cli-reference). A formal `season_id` to keep multiple
  seasons live at once is a future iteration if it's ever needed.
- **Pool size**: no formal `max_players` per tenant, even though the schema no longer caps at 68.
- **Tenant switch reload**: see Auth & sessions above.
- **`season_status` not enforced**: see Multi-tenancy data model above.
