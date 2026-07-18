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

## Minimize changes

Always look to implement the minimal possible changes in order to meet a goal. If a larger change is important to pay off tech debt or to make the app easier to maintain, explicitly bring it up as a possible extention of backlog item - never assume it is the right path.

## Test

Always consider if additional test automation is required. However we don't want to over-test.
