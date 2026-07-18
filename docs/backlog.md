# Backlog

Known improvements that are out of scope for the current multi-tenancy milestone (Stages
1–12) but worth doing at some point. Roughly ordered by likely priority.

## Commissioner / admin UX

**Prevent adding pigeons mid-season**
`POST /admin/pigeons` has no guard against creating players after week 1 picks have
started. A new pigeon added mid-season has no picks for completed weeks, which distorts
leaderboards. Add a check: block pigeon creation once any week's lock has passed for
this tenant (or require commissioner to explicitly acknowledge the risk).

**Delete pigeons**
No delete endpoint exists. Blocked because `picks` references `player_id` — deleting a
player would cascade and erase historical picks. Options: soft-delete (add
`players.deleted_at`), or only allow deletion before any picks are submitted for the
player. Add a `DELETE /admin/pigeons/{player_id}` endpoint with appropriate guards.

## Product / UX

**Self-service league creation (Model B)**
Currently tenant creation is an operator CLI operation (Stage 9, curated-pool model).
If the product grows beyond marc's personal circles, a self-service path would be
needed: user registration, "Create a League" onboarding flow, invite links. This is a
significant product scope increase — see Stage 9 design notes for the trade-offs.

**Tenant switch without full page reload**
`switchTenant` currently calls `window.location.reload()`. A cleaner approach would
invalidate per-page query caches (e.g. via React Query) and re-render in place.

**Multi-season history in the app**
After `reset-season`, last year's picks are only in the archived CSV. A future
`season_id` concept on `games` and `picks` would let the app show prior-season results
without a separate tool.

## Frontend technical debt

**`player_id` vs `pigeon_number` in picks/results/analytics**
`AltPigeon` only carries `pigeon_number`; `withPigeon()` in `fetch.ts` has a hardcoded
`> 68` cap. Both are fixed in Stage 10. If that stage is delayed, these are silent bugs
for any tenant whose players have `player_id > 68`.
_(Note: this will be fixed in Stage 10 — remove this entry when done.)_

**Scoring divergence: frontend vs backend**
Frontend `scoreForPick` is missing the missed-pick penalty and doesn't cap at 800 points
(backend does). `Top5Playground` and `bestPossibleRank` use the frontend version
directly. Low risk in practice (edge cases only) but will mislead users in those views.
Fix by pulling scoring from the backend leaderboard API rather than recalculating
client-side.
