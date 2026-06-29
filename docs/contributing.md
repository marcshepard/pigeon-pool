# Contributing

## Development setup

See [README.md](../README.md) for full local setup (DB, backend, frontend).

Short version:
- Backend: `uvicorn backend.main:app --reload --port 8000` (or VS Code task `pigeon BE`)
- Frontend: `cd frontend && npm run dev` (or VS Code task `pigeon FE`)
- Both at once: VS Code task `pigeon pool`

## Backend tests

Tests live in `tests/` and use pytest against the `pigeon_pool_multi` development database.
See [docs/tests.md](tests.md) for a full explanation of the test design: auth approach, the adaptive
`scored_games` fixture, how pick insertion bypasses the lock trigger, and the scoring formula mirror.

Run all tests:
```bash
pytest
```

Run a specific file:
```bash
pytest tests/test_results.py -v
```

### Snapshot tests

`tests/test_snapshots.py` captures golden-file JSON responses from the results API. These snapshots
represent current single-pool behavior and are used to verify that the multi-tenant migration does
not regress data output.

Snapshots are stored in `tests/snapshots/`.

To regenerate snapshots after an intentional schema or data change:
```bash
pytest --update-snapshots
```

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

To regenerate the FE snapshot golden files after an intentional data change:
```bash
cd frontend && npm run test:e2e:update
```

See [docs/tests.md](tests.md) for the full test design (both backend and frontend).

## Frontend type checking

```bash
cd frontend && npx tsc --noEmit
```
