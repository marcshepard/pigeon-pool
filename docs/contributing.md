# Contributing

## Development setup

See [README.md](../README.md) for full local setup (DB, backend, frontend).

Short version:
- Backend: `uvicorn backend.main:app --reload --port 8000` (or VS Code task `pigeon BE`)
- Frontend: `cd frontend && npm run dev` (or VS Code task `pigeon FE`)
- Both at once: VS Code task `pigeon pool`

## Backend tests

Tests live in `tests/` and use pytest against the `pigeon_pool_multi` development database
(see [docs/multi.md](multi.md) for migration context).

Run all tests:
```bash
pytest
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

## Frontend type checking

```bash
cd frontend && npx tsc --noEmit
```
