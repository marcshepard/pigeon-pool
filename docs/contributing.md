# Contributing

## Development setup

See [README.md](../README.md) for full local setup (DB, backend, frontend).

Short version:
- Backend: `uvicorn backend.main:app --reload --port 8000` (or VS Code task `pigeon BE`, which first
  applies pending Alembic revisions)
- Frontend: `cd frontend && npm run dev` (or VS Code task `pigeon FE`)
- Both at once: VS Code task `pigeon pool`

## Backend tests

Tests live in `tests/` and use pytest against the dev database configured in `backend/.env`.
See [docs/tests.md](tests.md) for a full explanation of the test design: auth approach, the adaptive
`scored_games` fixture, how pick insertion bypasses the lock trigger, and the scoring formula mirror.

Backend dependencies (including pytest) are installed in the `pigeon` conda environment, not the
system Python. Activate it before running backend commands:
```bash
conda activate pigeon
```

Run all tests:
```bash
pytest
```

Run a specific file:
```bash
pytest tests/test_results.py -v
```

To verify that Alembic can construct a fresh database capable of running the full backend suite:

```bash
python tests/run_alembic_database_suite.py
```

This command only runs against a localhost PostgreSQL server. It creates a uniquely named
`pigeon_pool_alembic_suite_*` database, upgrades it from Alembic base to head, adds minimal NFL
reference rows required by the fixtures, runs all backend tests against it, and drops that exact
temporary database afterward.

## Database migrations

Alembic revisions are the sole source of truth for the PostgreSQL schema. Run all commands from
the repository root with the backend environment active:

```bash
python -m alembic -c backend/alembic.ini current
python -m alembic -c backend/alembic.ini history
python -m alembic -c backend/alembic.ini heads
python -m alembic -c backend/alembic.ini upgrade head
```

Before developing on a branch, update the branch and run `upgrade head` against the local database.
If `current` is behind, upgrade it; never use `stamp` to conceal a failed or unapplied migration.

Create a new revision with:

```bash
python -m alembic -c backend/alembic.ini revision -m "short description"
```

The application does not maintain SQLAlchemy schema metadata, so autogeneration is intentionally
disabled. Handwrite `upgrade()` and add a `downgrade()` only when reversal is safe and useful.
Revisions must be self-contained: they may not load mutable SQL files at runtime. Once a revision
has been applied to a shared environment, do not edit or reorder it; add a corrective revision.

Keep the graph at exactly one head. If concurrent branches create multiple heads, reconcile them
with an explicit merge revision before merging. For every schema change:

1. Test upgrading representative data from the prior revision.
2. Run `python tests/run_alembic_database_suite.py` to test base-to-head creation and the backend
   suite against an Alembic-built database.
3. Run Ruff and Pyright as described below.
4. Commit the revision with backward-compatible application code, unless an expand-and-contract
   rollout deliberately separates the releases.

Both the VS Code `pigeon BE` task and Azure's `backend/startup.sh` invoke
`python -m backend.migrate` before Uvicorn. The runner identifies the target without printing
credentials, takes a PostgreSQL advisory lock to serialize concurrent App Service starts, and runs
`upgrade head`. If it fails, the new backend does not start; Azure's post-deployment health check
then fails as well. Thus the normal operator workflow is to merge/sync the tested change to `main`
and monitor the deployment—no Kudu migration command is normally required.

The revision must still be compatible with the previously deployed backend while Azure replaces
the running instance. Prefer additive expand-and-contract changes. For a destructive or otherwise
incompatible change, split the work across releases so the old code remains safe during the first
migration. Application rollback normally leaves additive schema in place; do not automatically
downgrade production. If a migration fails, inspect the startup/Alembic logs and `current` from
Kudu/SSH; never use `stamp` to conceal the failure.

## Backend static checks

Install the local-only tools from `backend/requirements-dev.txt`, then run Ruff and
Pyright from the repository root:

```bash
python -m ruff check backend tests
python -m pyright backend tests
```

VS Code uses the same Ruff executable, Pyright version, and repository configuration.

## Frontend E2E tests

Tests live in `frontend/e2e/` and use Playwright (Chromium). They spin up an isolated
`_Test FE League` tenant in the dev DB for the duration of the run.

```bash
cd frontend && npm run test:e2e
```

Or use the VS Code task **pigeon FE tests**.

The backend and frontend servers are started automatically if not already running. If
your **pigeon pool** VS Code task is already up, Playwright reuses those servers and
starts faster.

See [docs/tests.md](tests.md) for the full test design (both backend and frontend).

## Frontend type checking

```bash
cd frontend && npx tsc --noEmit
```
