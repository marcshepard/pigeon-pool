# Deployment: Production Migration and New-Season Runbook

Two things live here:

1. **One-time**: migrate the production database from the old single-pool schema to the
   multi-tenant schema (this is what the `multi` branch's work has been building toward).
2. **Every season**: the commands to archive the old season and bring up the new one for
   Andy's existing tenant.

Delete this file once the one-time migration is done — the durable design decisions it was
built on now live in [docs/architecture.md](architecture.md).

## One-time: migrate production to the multi-tenant schema

Run this when merging `multi` → `main` for the production release. Production connection
details are in `backend/.env.production` (host, DB name, user); the password is an Azure
environment variable, not in the repo.

1. **Back up production first.** Azure's PITR already covers the last 7 days automatically
   (see README "Implementation notes"), but take an explicit snapshot before migrating so
   there's a known-good restore point tied to this change.
2. **Run the migration scripts against the production DB, in this exact order** (each was
   already applied to the local `pigeon_pool_multi` clone and verified there):
   ```bash
   psql -h <POSTGRES_HOST> -U <POSTGRES_USER> -d <POSTGRES_DB> -f database/db_update.sql
   psql -h <POSTGRES_HOST> -U <POSTGRES_USER> -d <POSTGRES_DB> -f database/migration_stage5.sql
   psql -h <POSTGRES_HOST> -U <POSTGRES_USER> -d <POSTGRES_DB> -f database/migration_stage10.sql
   psql -h <POSTGRES_HOST> -U <POSTGRES_USER> -d <POSTGRES_DB> -f database/migration_stage11.sql
   ```
   Values for `<POSTGRES_HOST>` / `<POSTGRES_USER>` / `<POSTGRES_DB>` come from
   `backend/.env.production`.
3. **Merge `multi` → `main` and push.** The existing GitHub Actions workflows deploy backend
   and frontend automatically on push to `main` — no separate deploy step needed.
4. **Smoke test production**: log in, confirm existing picks/leaderboards still render
   correctly for the migrated tenant (row counts and leaderboard output should match
   pre-migration).
5. Keep the pre-migration snapshot available for at least one season as a rollback target.

## Every season: bring up the new year

Run each summer once the new NFL schedule is available from ESPN (see
[docs/preseason_testing.md](preseason_testing.md) if testing against preseason data first):

```bash
python -m backend.cli reset-season
```

This archives the outgoing season's picks to `archive/<tenant_id>_<year>_picks.csv`, wipes
`games` (cascading `picks`), resets every player's `season_status` to `pending`, and syncs the
new season's schedule (`weeks.default_lock_at`).

Then, as commissioner in League Settings:

1. **Activate Season** — copies the new `default_lock_at` values into `tenant_weeks` for the
   tenant. Review/adjust individual week lock times if needed.
2. **Roster** — set each returning pigeon's `season_status` (`pending` / `active` / `out`) as
   they confirm they're playing this year (e.g. paid up).

Full CLI reference (including score/kickoff sync and league management) is in README.md.
