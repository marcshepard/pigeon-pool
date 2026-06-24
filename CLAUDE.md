# Claude Instructions

## Permissions

- Do not ask for permission before making code changes or edits to files in this repository.
- Do not ask for permission before running read-only scripts or commands to search, explore, or inspect the codebase (e.g., grep, glob, reading files, git log).

## Documentation

Update the relevant doc file whenever a code change affects the documented behavior. Files and their scope:

| File | Contains |
|------|----------|
| `README.md` | Localhost quickstart (DB setup, backend, frontend steps), brief architecture table, environment config, Azure/ops notes, DB cloning commands for the multi-tenant dev DB |
| `docs/contributing.md` | How to run the test suite, snapshot update workflow (`pytest --update-snapshots`) |
| `docs/frontend.md` | Frontend directory layout, key data flows (auth, results, analytics, YTD), build/type-check commands |
| `docs/multi.md` | Multi-tenant migration plan: stage definitions, design decisions, completion notes per stage — update the completion notes when a stage finishes |
