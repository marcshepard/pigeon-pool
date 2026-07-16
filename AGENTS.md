# Agent Instructions

## Documentation

Update the relevant doc file whenever a code change affects the documented behavior. Files and their scope:

| File | Contains |
|------|----------|
| `README.md` | Localhost quickstart (DB setup, backend, frontend steps), brief architecture table, environment config, Azure/ops notes, DB cloning commands for the multi-tenant dev DB |
| `docs/contributing.md` | How to run the test suite, snapshot update workflow (`pytest --update-snapshots`) |
| `docs/frontend.md` | Frontend directory layout, key data flows (auth, results, analytics, YTD), build/type-check commands |
| `docs/architecture.md` | Durable design decisions: multi-tenancy data model, auth/JWT, onboarding model, scheduler, known limitations |
| `docs/deployment.md` | Temporary: production migration steps + new-season runbook. Delete after the production migration is done — do not add new durable content here, put it in `docs/architecture.md` instead |
