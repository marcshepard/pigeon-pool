# Agent Instructions

## Documentation

Read the documentation before making any design decisions. Update the relevant doc file whenever a code change affects the documented behavior. Files and their scope:

| File | Contains |
|------|----------|
| `README.md` | Localhost quickstart (DB setup, backend, frontend steps), brief architecture table, environment config, Azure/ops notes, DB cloning commands for the multi-tenant dev DB |
| `docs/contributing.md` | How to run the test suite, snapshot update workflow (`pytest --update-snapshots`) |
| `docs/frontend.md` | Frontend directory layout, key data flows (auth, results, analytics, YTD), build/type-check commands |
| `docs/architecture.md` | Durable design decisions: multi-tenancy data model, auth/JWT, onboarding model, scheduler, known limitations |
| `docs/preseason_testing.md` | Temporary: plan for testing against live preseason NFL data. Delete once implemented and no longer needed (planned: August) |

## Minimize changes

Always look to implement the minimal possible changes in order to meet a goal. If a larger change is important to pay off tech debt or to make the app easier to maintain, explicitly bring it up as a possible extention of backlog item - never assume it is the right path.

## Test

Always consider if additional test automation is required. However we don't want to over-test.

After changing Python code, run the shared backend static checks from the repository root:

```powershell
python -m ruff check backend tests
python -m pyright backend tests
```

After changing frontend code, run the existing frontend lint check from the repository root:

```powershell
cd frontend
npm run lint
```

## Database schema changes

Alembic revisions under `backend/migrations/versions/` are the sole schema source of truth. Any
change to a table, column, constraint, index, view, function, or trigger must include a handwritten
Alembic revision; do not add request-time DDL or recreate a `schema.sql` workflow. Autogeneration is
intentionally unavailable because the application has no SQLAlchemy schema metadata.

Before coding, run `python -m alembic -c backend/alembic.ini upgrade head`. Keep exactly one
migration head, preserve existing data, and make production migrations backward compatible with
the previously deployed application during rollout. Test every schema change with
`python tests/run_alembic_database_suite.py` in addition to the normal backend checks. Never edit a
revision that has reached a shared environment; add a corrective revision instead.

The VS Code backend task and Azure startup both run the serialized `python -m backend.migrate`
phase before Uvicorn. A migration failure must prevent the new backend from starting. Do not bypass
that phase, stamp over a failed upgrade, or put schema changes outside Alembic.
