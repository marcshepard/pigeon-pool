# Alembic migration plan

## Purpose

Introduce Alembic without rebuilding or losing data in the desktop development, laptop
development, or Azure production databases. All three environments currently have the latest
intended `database/schema.sql` schema, so that schema will become the common Alembic baseline.
After the transition, Alembic revisions—not ad hoc SQL execution or rerunning `schema.sql`—will be
the authoritative history of database structure.

This work should be completed before the database changes in `LOGIN_FIXES.md`. Establishing the
baseline first gives those changes a versioned and repeatable deployment path.

## Execution status

Phase 1 was completed on 2026-08-30. The semantic baseline inventory and read-only
`verify-schema-baseline` CLI command are implemented, and the desktop development, laptop
development, and Azure production databases all pass. The frozen baseline commit deployed on
`main` and Azure is `eee8584a6dc1b1d1f42624ad15646a3d69a5e74e`.

Phase 2 was completed on `dev` on 2026-08-30. Alembic 1.19 is a production dependency;
`backend/alembic.ini`, the credential-safe synchronous psycopg migration environment, the typed
revision template, and the versions directory are in place. The empty migration graph reports no
heads or history, `alembic current` connects successfully without creating a version table, and
the pre-Alembic schema verifier still passes. At the end of that phase, no revision had been
created and no database had been stamped.

Phase 3 was completed on `dev` on 2026-08-30. Revision `0001_current_schema_baseline` contains the
complete pre-Alembic application schema and refuses a destructive downgrade. Automated migration
tests create a uniquely named local database, upgrade base to `0001`, validate the semantic
inventory, confirm a second upgrade is a no-op, exercise core relationships and views, and remove
the database. The full backend suite also passes against a separate database created solely by
`alembic upgrade head` after adding the minimal reference rows required by the shared fixtures.
At the end of Phase 3, no persistent database had been stamped or otherwise changed.

Phase 4 schema enrollment was completed on 2026-08-31. The desktop development database passed the
preflight verifier, had no current Alembic revision, and was stamped at `0001`. Its post-stamp semantic verification passes,
and `alembic current` reports `0001 (head)`. The only database object added during enrollment was
Alembic's version table. The laptop development database subsequently passed the same preflight,
was stamped at `0001`, and passed both the revision and semantic post-stamp verification. On
2026-08-31, the exact validated revision was deployed to Azure production. Azure initially
reported no current revision and one head (`0001`), was stamped at `0001`, and then reported
`0001 (head)`. Its post-stamp schema and roster validations both passed with no integrity errors.
All three persistent environments therefore report the same single Alembic head. Azure's built-in
PITR was confirmed in the portal with seven-day retention and seven available snapshots. The
production application smoke test exposed
missing historical picks and an unrelated pre-existing week-filter bug in the commissioner status
display; because `stamp` only wrote `alembic_version`, the operator explicitly deferred that data
incident rather than treating it as schema-enrollment failure.

Phase 5 was completed on 2026-08-31. The README, contributing guide, and architecture guide now
use Alembic as the only schema workflow and document the Kudu/SSH production procedure. The
arbitrary `backend.cli run-sql` command and all 15 tracked files in the obsolete SQL directory were
removed. The migration graph test now requires exactly one head, and a PostgreSQL-backed backend CI
workflow runs Ruff, Pyright, and the complete backend suite against a disposable database built
from Alembic base to head. The Azure backend deployment also waits for a fast exactly-one-head gate.
Locally, that Alembic-built suite passes all 111 tests, Ruff passes, and Pyright reports no errors
or warnings.

Phase 6 is the final delivery canary. Revision `0002_document_tenants_table` makes a harmless,
transactional catalog change by documenting the `tenants` table. It changes no application data,
columns, constraints, indexes, or runtime behavior. The phase is complete when normal backend
startup—not a manual Alembic command—advances the desktop, laptop, and Azure databases from `0001`
to `0002`, and all three applications pass their smoke tests. Desktop startup applied the canary
successfully on 2026-08-31 and `/ping` returned 200; laptop and Azure verification remain.

The frozen pre-Alembic inventory currently consists of:

- 12 application tables: `teams`, `weeks`, `games`, `tenants`, `tenant_weeks`, `users`,
  `players`, `user_players`, `tenant_members`, `tenant_payouts`, `picks`, and `scheduler_runs`;
- four sequences: the three identity sequences for `games`, `tenants`, and `users`, plus
  `players_player_id_seq`;
- six explicit indexes, including the case-insensitive user-email index and partial single-owner
  index;
- five application views;
- the `deny_picks_after_lock()` function and its insert, update, and delete triggers on `picks`;
- all column types, nullability, defaults, identity behavior, keys, foreign-key delete behavior,
  uniqueness rules, and check constraints represented by those objects.

`password_reset_uses` is the one optional application table at this baseline and is verified
strictly when present. `alembic_version` is also accepted with its standard exact shape after
stamping, but it is an Alembic control table rather than part of revision `0001`'s application
schema.

## Desired end state

- `python -m alembic -c backend/alembic.ini upgrade head` creates a brand-new database and upgrades
  an existing database to the latest schema.
- Desktop, laptop, and Azure each have an `alembic_version` row at the same revision.
- Every schema change is represented by an immutable, reviewed Alembic revision.
- Application code does not create or alter tables at request time.
- The `database/` directory is removed after the baseline is proven and all three persistent
  environments are enrolled. Alembic revisions are the sole schema source of truth.
- The backend can report the expected schema revision and fails deployment checks when the target
  database is behind.
- Database migrations are applied explicitly during deployment, before code that requires them is
  started.

## Design decisions

### Use handwritten revisions

The application uses SQLAlchemy for connections and sessions but does not define its schema with
SQLAlchemy declarative metadata. Alembic autogeneration therefore cannot reliably describe this
database. Revisions should be handwritten with Alembic operations and PostgreSQL SQL.

Do not add ORM table models merely to enable autogeneration. That would create a second schema
representation and is unnecessary for this application.

### Keep Alembic under `backend`

Use this layout:

```text
backend/
  alembic.ini
  migrations/
    env.py
    script.py.mako
    versions/
      0001_current_schema_baseline.py
      0002_document_tenants_table.py
      0003_manage_auth_schema.py
```

The Azure artifact already packages the entire `backend` directory, so this layout avoids a
second packaging rule for migration files. Run commands from the repository or deployed artifact
root with:

```powershell
python -m alembic -c backend/alembic.ini <command>
```

Add `alembic` to `backend/requirements.txt`, because production must be able to run migrations.

### Reuse application environment selection

`backend/migrations/env.py` should call `get_settings()` so Alembic follows the existing `APP_ENV`
rules and `.env` loading behavior. It must construct a synchronous SQLAlchemy URL using the
already-installed psycopg 3 driver (`postgresql+psycopg`). Credentials must not be copied into
`alembic.ini`, printed, or committed.

Alembic does not need the application's async engine. Migrations are operational commands and a
synchronous connection keeps the migration setup small and predictable.

### Make revisions self-contained and immutable

The baseline revision must contain the SQL required to create the baseline; it must not read
`database/schema.sql` at runtime. Otherwise editing or removing that file later would change the
behavior of an already-published revision.

Once a revision has been applied outside one local machine, never edit or reorder it. Correct it
with a new revision.

### Treat production rollback as a compatibility and restore problem

Forward migrations should be transactional where PostgreSQL permits it. A failed transaction
must leave the Alembic revision unchanged. Deployments should use expand-and-contract changes so
the prior backend remains compatible while additive database changes are applied.

Do not automatically downgrade production as part of an application rollback. A downgrade can
destroy data needed by the new code or data written since deployment. Roll back application code
when the schema remains backward compatible; use Azure point-in-time restore or a tested backup
restore for a destructive database rollback.

The baseline downgrade should intentionally refuse to drop the entire application schema. Later
revisions may provide downgrades only when they are demonstrably safe and useful.

## Important current-schema caveat

`backend/routes/auth.py` currently creates `password_reset_uses` lazily. The table is absent from
`database/schema.sql`, which means an environment may contain it only if a password reset path has
already caused its creation.

For a truthful baseline:

- Revision `0001` represents the current contents of `database/schema.sql` and excludes
  `password_reset_uses`.
- Baseline parity checks tolerate this one known extra table only when its columns and constraints
  exactly match the current application DDL.
- Revision `0002` formally creates or adopts `password_reset_uses`, after which the lazy
  `CREATE TABLE` code is removed.
- No other unexplained difference is acceptable before an existing database is stamped.

This prevents stamping a database as having a managed table that may not actually exist, while
also preserving reset-token records if the table already exists.

## Phase 1: inventory and freeze the baseline

1. Record the commit containing the baseline and do not make unrelated schema changes while the
   three environments are being enrolled.
2. Inventory the intended objects in `database/schema.sql`:

   - tables and sequences;
   - columns, PostgreSQL types, nullability, identity/default expressions;
   - primary, unique, foreign-key, and check constraints;
   - normal and partial indexes;
   - views and their definitions;
   - the pick-lock function and triggers.

3. Build a read-only baseline verification command, preferably
   `python -m backend.cli verify-schema-baseline`. It should query `pg_catalog` or
   `information_schema`, print a concise diff, and return nonzero for any mismatch.
4. Make the verifier recognize `password_reset_uses` as the single permitted optional object,
   subject to the exact-shape check described above.
5. Run the verifier against desktop and laptop. Run it against Azure from an Azure-hosted execution
   context that is permitted through the PostgreSQL firewall, initially the backend App Service's
   Kudu/SSH console. Do not reopen PostgreSQL to a developer IP merely to perform this transition.
6. Resolve every unexpected difference before stamping. Do not use `alembic stamp` as a repair
   mechanism; stamping records history but performs no schema validation.

The verifier should avoid comparing raw catalog text where PostgreSQL formatting or generated
constraint names are immaterial. Compare normalized definitions or semantic fields so the check
is strict about behavior without being fragile about whitespace.

## Phase 2: add the Alembic framework

1. Add a bounded Alembic dependency to `backend/requirements.txt`.
2. Add `backend/alembic.ini` with `script_location` pointing to `backend/migrations` relative to the
   configuration file.
3. Add `backend/migrations/env.py` that:

   - imports the existing settings loader;
   - creates a psycopg-based synchronous SQLAlchemy URL without logging secrets;
   - supports both online mode and Alembic's offline SQL mode;
   - uses `target_metadata = None`, since revisions are handwritten;
   - enables transaction-per-migration behavior;
   - gives useful connection errors without including the password.

4. Generate the normal Alembic revision template and configure it to include revision identifiers,
   dependencies, and typed `upgrade()`/`downgrade()` functions.
5. Confirm that these read-only commands work against the desktop database before adding any
   revision:

   ```powershell
   python -m alembic -c backend/alembic.ini heads
   python -m alembic -c backend/alembic.ini history
   ```

## Phase 3: create and test revision `0001`

Create `0001_current_schema_baseline.py` with `down_revision = None`.

Its `upgrade()` must create the current schema in dependency order, including all tables,
sequences, constraints, indexes, views, the pick-lock function, and triggers found in
`database/schema.sql`. It must not create application data such as teams, weeks, games, tenants,
or users. Existing environment enrollment will use `stamp`, so the baseline `upgrade()` runs only
when constructing a new database.

Do not depend on broad `IF NOT EXISTS` clauses to hide errors in this revision. Creating a fresh
database should fail on an unexpected preexisting object rather than silently produce an unknown
hybrid schema.

Test the revision on an empty temporary PostgreSQL database:

1. Run `alembic upgrade head`.
2. Run the baseline verifier and require an exact match.
3. Run `alembic current` and confirm it reports `0001`.
4. Run `alembic upgrade head` again and confirm it is a no-op.
5. Run the backend test suite against the new database after loading whatever schedule/reference
   data the tests require.
6. Compare a schema-only dump of the migrated database with a database created from the existing
   `schema.sql`. Review meaningful differences rather than generated names or ownership metadata.

The temporary database must have a specific disposable name. Verify that name before dropping it.
Never test baseline creation by clearing a desktop, laptop, or Azure database.

## Phase 4: enroll the existing databases

Before changing an existing environment, take or confirm a recoverable backup. Azure point-in-time
restore is the production safety net; also capture a schema-only dump for quick comparison. Local
databases should have a normal PostgreSQL backup if their data is not easily recreated.

Use this order so a problem is discovered before production:

1. desktop development;
2. laptop development;
3. Azure production.

For desktop and laptop:

1. Check out the exact commit containing revision `0001`.
2. Use the normal development environment and confirm the displayed database host and database name
   before continuing.
3. Run the read-only baseline verifier and save its result.
4. Confirm that `alembic current` reports no revision because the database is not enrolled yet.
5. Stamp the database without executing the baseline DDL:

   ```powershell
   python -m alembic -c backend/alembic.ini stamp 0001
   ```

6. Confirm the revision and schema checks:

   ```powershell
   python -m alembic -c backend/alembic.ini current
   python -m alembic -c backend/alembic.ini heads
   python -m backend.cli verify-schema-baseline
   ```

   Do not use `alembic check` as the schema validator. That command is based on autogeneration,
   while this project deliberately has no SQLAlchemy schema metadata.

7. Run the baseline verifier again and perform an application smoke test: login, tenant selection,
   results, pick entry for an unlocked week, and an admin read operation.

For Azure, first deploy a baseline-enablement backend release that contains Alembic, revision
`0001`, and the verifier but does not contain application code that requires any new schema. Then
open the backend App Service's Kudu/SSH console and run the same verify, `current`, `stamp`, and
post-stamp verification commands from the deployed artifact root. The App Service environment must
already identify itself as production and provides the database settings without copying secrets
to a developer machine. Confirm the non-secret target host/database identity before stamping.

Because the PostgreSQL firewall blocks direct access from the operator's current IP addresses, do
not rely on the README's local `APP_ENV=production` CLI procedure for migration administration. Do
not temporarily widen the firewall for routine schema work. A later automation may use a secured
Azure-hosted job, but it must run inside an approved network path to PostgreSQL.

`stamp` creates only Alembic's version table and version row. It must not alter application data or
objects. If validation fails before stamping, stop and reconcile the environment. If smoke testing
fails after stamping, removing or correcting only the version record is safe provided no later
migration has run; do not modify application tables merely to make the revision label agree.

## Phase 5: make Alembic the only schema workflow

After all three databases report `0001`:

1. Change the README's new-database setup from "run `database/schema.sql`" to:

   ```powershell
   python -m alembic -c backend/alembic.ini upgrade head
   ```

2. Document `current`, `history`, `heads`, `upgrade head`, and revision creation in
   `docs/contributing.md`.
3. Update `docs/architecture.md` to state that Alembic revisions are the schema source of truth and
   describe the production migration policy.
4. Remove `backend.cli run-sql`. Alembic replaces its schema-change purpose, the SQL-file collection
   is being deleted, and arbitrary production SQL is no longer part of the supported operator
   workflow.
5. Delete the entire `database/` directory after confirming all of the following:

   - `0001` contains every schema object formerly defined by `database/schema.sql`;
   - a fresh empty database can be created solely with `alembic upgrade head`;
   - desktop, laptop, and Azure have passed schema verification and report the expected revision;
   - no application code, test, workflow, task, or documentation still references a file under
     `database/`.

   This intentionally removes `schema.sql`, `db_update.sql`, `test.sql`,
   `seed_test_tenant.sql`, and `database/queries/`. The old SQL files remain recoverable from Git
   history if they are ever needed for investigation.

   The ad hoc queries should not be moved elsewhere by default. They are not used by the
   application, several reflect older schema assumptions, and production PostgreSQL is no longer
   directly reachable from the operator's current IP addresses. For supported operations, prefer
   tenant-safe backend CLI commands or purpose-built read-only diagnostics that use the normal
   application configuration and access path. Add a new diagnostic only when there is a current,
   concrete need; do not preserve the old query collection speculatively.

6. Add a CI check that the migration graph has exactly one head. Multiple heads require an explicit
   merge revision and must not reach deployment accidentally.

## Phase 6: prove automated delivery with revision `0002`

Create `0002_document_tenants_table.py` as a harmless real migration. Its upgrade adds the
PostgreSQL comment `One row per Pigeon Pool league` to the `tenants` table, and its downgrade
removes that comment. The comment is permanent once the revision reaches a shared environment;
do not delete or renumber the revision after deployment.

Verify it in deployment order:

1. Launch the desktop backend through the VS Code task and confirm startup reports the upgrade and
   `alembic current` reports `0002 (head)`.
2. Commit and push the revision to `dev`; on the laptop, sync `dev`, launch through VS Code without
   running Alembic manually, and confirm `0002 (head)`.
3. Merge/sync `dev` to `main` and let Azure startup apply the revision. Confirm the migration log,
   successful `/ping` deployment gate, application smoke test, and optionally `0002 (head)` from
   Kudu/SSH.

This proves revision discovery, the PostgreSQL connection, advisory-lock serialization,
transactional DDL, version-table advancement, startup ordering, and deployment health reporting.
Future revisions still require tests for their own schema and data behavior.

## Post-cutover follow-up: adopt the login-related schema

After the canary has reached every environment at `0002`, create
`0003_manage_auth_schema.py` (or smaller consecutive revisions) for the database portion of the
related `LOGIN_FIXES.md` work.

The revision should:

- create `password_reset_uses` when absent;
- when it already exists, verify that `jti`, `user_id`, `used_at`, the primary key, default, and
  cascading foreign key match the intended definition, preserving all rows;
- add `users.session_version` (or the final chosen name) as `NOT NULL` with an explicit default,
  initially zero;
- use PostgreSQL operations that avoid a prolonged rewrite or table lock for the small additive
  change;
- retain the default if all future user inserts should start at version zero;
- include focused migration tests for both starting states: reset table absent and reset table
  already present with data.

Deploy this as an expand-and-contract sequence:

1. Apply revision `0003` while the old backend is still running. Both changes are additive and the
   old backend should ignore them.
2. Deploy backend code that atomically claims a reset-token JTI and reads/increments
   `session_version`.
3. Remove `ensure_reset_table()` and the request-time DDL in that same backend release or a small
   follow-up once `0003` is guaranteed everywhere.
4. Run the authentication tests and production smoke tests.

If the password and session work is split into separate application releases, split `0003` into
small, single-purpose consecutive revisions. The revision boundary should follow deployability,
not an arbitrary preference for fewer files.

The HttpOnly cookie and CSRF portion of `LOGIN_FIXES.md` does not inherently require a database
migration. Do not add one unless its final design introduces persisted sessions, refresh tokens,
or a revocation table.

## Deployment policy

Alembic is not run from FastAPI lifespan code or separately by web workers. It runs as a visible,
fail-closed process phase before Uvicorn. `python -m backend.migrate` holds a PostgreSQL advisory
lock while applying `upgrade head`, which serializes concurrent App Service starts and releases the
lock automatically if the migration process dies.

The preferred production sequence is:

1. confirm backup/PITR availability;
2. merge a tested, backward-compatible revision and application change to `main`;
3. let App Service startup run the serialized migration phase inside Azure's approved database
   network path;
4. start Uvicorn only after the migration reaches `head`;
5. require the public `/ping` health check to succeed;
6. smoke-test the affected behavior and inspect logs.

Kudu/SSH remains the diagnostic and recovery path for checking `current` after a failure, but it is
not part of a normal successful deployment. Do not retry by stamping. Fix an unpublished revision
only if it has never succeeded in a shared environment; otherwise add a corrective revision.

The backend deployment workflow currently triggers only for `backend/**` and the workflow file.
Keeping revisions under `backend` ensures migration-only commits trigger deployment packaging. If
schema tooling is later moved elsewhere, update both the workflow path filters and the ZIP contents
in the same commit.

## Development workflow after cutover

For each database-affecting change:

1. Update the local branch and run `alembic upgrade head` before coding against the database.
2. Create a revision:

   ```powershell
   python -m alembic -c backend/alembic.ini revision -m "short description"
   ```

3. Handwrite `upgrade()` and, when safe, `downgrade()`.
4. Test upgrading from the previous revision with representative data.
5. Test creation from an empty database by upgrading from base to head.
6. Run the backend tests and the required static checks.
7. Update documentation whenever behavior or operations change.
8. Commit the migration and compatible application code together unless the expand-and-contract
   rollout intentionally requires separate commits/releases.

The normal developer/operator action after these checks is only to merge/sync the change to
`main` and monitor the backend workflow. The Azure startup migration and health gate are automatic.

When moving between branches, run `alembic current` and `alembic heads`. Never stamp over an
unknown revision or use `stamp head` to suppress an upgrade failure.

## Test strategy

The existing pytest suite uses the configured development database and assumes its schema already
exists. Alembic support should add focused migration tests without unnecessarily rebuilding the
database for every application test.

At minimum, automate:

- migration graph has one head;
- empty database upgrades from base to head;
- a database at `0001` upgrades to head while preserving representative rows;
- `0002` handles both presence and absence of the lazily created reset table;
- upgrading an already-current database is a no-op;
- the baseline verifier passes at head;
- backend tests pass against a database built by Alembic rather than manually by `schema.sql`.

Migration tests should use a dedicated temporary database and robust cleanup. They must never
point at the normal development or production database. Require an unmistakable test database
suffix and check the resolved host/database name before any create, drop, or reset operation.

After Python changes, run the repository-required checks:

```powershell
python -m ruff check backend tests
python -m pyright backend tests
pytest
```

## Failure and recovery procedures

### Baseline verifier reports drift

Do not stamp. Capture the diff, determine which history produced it, and write a reviewed,
environment-specific reconciliation plan. Prefer making the database match the intended baseline
before enrollment. If the drift represents legitimate functionality, update the baseline design
for all environments rather than blessing only one database.

### Baseline stamp was applied to the wrong database

If no revision after `0001` has run, verify the target and remove/correct only the Alembic version
record. Stamping does not otherwise change the schema. Record the incident so another environment
is not mistakenly skipped.

### Upgrade fails

Preserve the error and check whether PostgreSQL rolled back the transaction. Confirm `alembic
current` before retrying. Fix the revision only if it has never succeeded in any shared or
production environment; otherwise add a corrective revision.

### Code deployment fails after an additive migration

Leave the additive schema in place and roll back the application artifact. This is why migrations
must be backward compatible during the deployment window. Do not downgrade reflexively.

### A destructive migration causes production data problems

Stop writes if necessary and use Azure point-in-time restore according to the existing recovery
procedure. Point the backend at the restored server only after confirming its Alembic revision and
application compatibility.

## Completion checklist

- [x] Baseline object inventory is reviewed.
- [x] Read-only baseline verifier exists and passes on desktop, laptop, and Azure.
- [x] Alembic is installed and configured without committed credentials.
- [x] `0001` creates the exact baseline on an empty database.
- [x] Empty-database migration tests and backend tests pass.
- [x] Desktop is stamped and smoke-tested.
- [x] Laptop is stamped and smoke-tested.
- [x] Azure PITR is confirmed with seven-day retention and seven snapshots; Azure is stamped and
      passes revision, schema, and roster checks.
      The unrelated application-data anomaly found during smoke testing is deferred separately.
- [x] All environments report the same single Alembic head.
- [x] README, contributing, and architecture documentation use the Alembic workflow.
- [x] Ad hoc schema migration paths are retired or clearly restricted.
- [x] No code, tests, workflows, tasks, or operational documentation depends on `database/`.
- [x] The obsolete `database/` directory has been deleted after baseline and enrollment
      verification.
- [x] CI rejects multiple migration heads and tests base-to-head upgrades.
- [x] VS Code and Azure apply pending revisions before backend startup; Azure serializes upgrades
      with a database advisory lock and fails closed on migration errors.
- [ ] The harmless `0002` canary is applied by normal startup and smoke-tested on desktop, laptop,
      and Azure without a manual upgrade command.
- [ ] `password_reset_uses` is adopted by a post-baseline revision.
- [ ] Request-time table creation is removed.
- [ ] The first login-related schema migration is deployed using the documented expand-and-contract
      sequence.

## Acceptance criteria

The Alembic transition is complete when a fresh empty PostgreSQL database can be built solely with
`alembic upgrade head`, all three persistent environments report the same revision, no request path
performs schema DDL, the obsolete `database/` directory has been removed, and a developer can move
between machines or deploy to Azure without manually tracking which SQL files have already been
applied.
