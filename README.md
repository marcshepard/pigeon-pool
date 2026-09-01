# Pigeon pool

Web app for the pigeon pool

## Architecture overview
| Component | Architecture |
| --------- | ------------ |
| Frontend  | React + Vite + MUI |
| Backend   | Fast API + Python
| Database  | PostgreSQL |
| Tests     | Python scripts in tests directory |
| Hosting   | Azure |
| Auth      | Name/PW w self-reset |
| Monitoring | App insights implements a ping test, provides per API error and timing stats |
| Diagnostics | Backend logs are sent to an Azure log analytics instance |

| Branch | Environment | Purpose |
| ------ | ----------- | ------- |
| dev    | development | localhost development |
| main   | production  | azure hosted app, CI/CD using github actions |

Environment configuration:
* .env - default non-secret values for dev/localhost
* .env.development.local - secrets for dev/localhost (or just use environment variables) - gitignore'd
* .env.production - overrides of non-secrets in .env for main/production
Note: there is no .env.production.local; production secrets are stored as Azure environment variables

## Quick start (localhost deployment)

### 1. Database and backend API setup

1. Install PostgreSQL, take all the defaults (they should match `backend/.env`), create a
   database called `pigeon_pool`, and note the password.
2. Create a `backend/.env.development.local` file and add these lines:
```env
POSTGRES_PASSWORD=whatever password you used when installing postgresql
JWT_SECRET=any-string-you-like
EMAIL_ACCESS_KEY=<get from Marc or Joe>
```
Note: this file constains secrets and will be .gitignored. Never check in secrets.

3. Create and activate an Anaconda environment:
```bash
conda create -n pigeon python=3.12
conda activate pigeon
pip install -r backend/requirements.txt
pip install -r backend/requirements-dev.txt  # local linting and type checking only
```

4. Build the database schema from the Alembic migration history:

```bash
python -m alembic -c backend/alembic.ini upgrade head
```

5. Run the CLI to populate the database with the NFL schedule:
```bash
python -m backend.cli sync-schedule
```

6. Create the initial league and its commissioner account:
```bash
python -m backend.cli create-league --name "Pigeon Pool" --commissioner-email admin@example.com
```
`create-league` creates the commissioner user when needed. All new accounts receive a bcrypt hash
of a discarded random token, so start the app and use **Forgot Password** to set a known password
before the first login.

7. Run the CLI to sync historic pigeon picks from previous weeks into the database.
First, get a copy of picks 2025.xlsx (not checked in for privacy reasons). Then:
```bash
python -m backend.cli import-picks-xlsx
```

8. Run the CLI to sync historic scores from previous weeks into the database.
For example, to sync scores from the first 6 weeks of the season:
```bash
python -m backend.cli sync-scores 6
```

9. Start the server:
```bash
uvicorn backend.main:app --reload --port 8000
```
Note: You can also run the `pigeon BE` VS Code task.

## CLI reference

All commands are run from the repo root with the conda environment active.

### Initial season setup
```bash
python -m backend.cli sync-schedule          # import NFL schedule for the season
python -m backend.cli sync-scores 6          # sync scores for week 6
python -m backend.cli sync-kickoffs 6        # refresh kickoff times for week 6
python -m backend.cli import-picks-xlsx picks.xlsx --week 6   # import picks from XLSX
```

### New season setup (each subsequent summer)
Run once before the new NFL season starts. Archives all picks, wipes last season's games and
lock times, resets player season status, syncs the new schedule, and reseeds lock times.
Against production, use the production env setup below to target the live DB.
```bash
# Archive, wipe, and re-sync (prompts for confirmation; add --yes to skip)
python -m backend.cli reset-season

# Then in the admin UI, per tenant/league:
# - Activate Season (League Settings) — copies new default_lock_at values into tenant_weeks;
#   review/adjust individual week lock times if needed
# - Roster (League Settings) — set each returning pigeon's season_status (pending/active/out)
#   as they confirm they're playing this year
```
Archives are written to `archive/<tenant_id>_<year>_picks.csv` in the repo root.

### Database schema migrations

Alembic revisions under `backend/migrations/versions/` are the only supported schema-change
workflow. From the repository root:

```bash
python -m alembic -c backend/alembic.ini current
python -m alembic -c backend/alembic.ini heads
python -m alembic -c backend/alembic.ini history
python -m alembic -c backend/alembic.ini upgrade head
```

See [docs/contributing.md](docs/contributing.md#database-migrations) before creating or editing a
revision. The VS Code `pigeon BE` task runs the serialized migration runner before Uvicorn, so a
normal local launch automatically advances the configured development database to `head` and
refuses to start the backend if an upgrade fails.

### Running database commands against production

The production PostgreSQL firewall does not permit direct access from developer machines. Run
production Alembic and database-backed CLI commands from the backend App Service's Kudu/SSH
console, using the environment and approved network path already provided to the application.
Do not copy production secrets locally or temporarily widen the firewall.

Azure deployments are extracted under `/tmp/<deployment-id>`. Work from the directory containing
the deployed `backend` package, not `/home/site/wwwroot` when that directory contains only the
compressed deployment artifact:

```bash
pwd
ls backend/cli.py backend/alembic.ini
python -m alembic -c backend/alembic.ini current
python -m backend.cli validate-rosters
```

Every command prints the selected environment files, and schema verification prints the non-secret
database host/name. Confirm that production is selected before a mutating command. Normal `main`
deployments run `python -m backend.migrate` before Uvicorn starts. That runner takes a PostgreSQL
advisory lock, applies all pending revisions, and prevents the new backend from starting if the
upgrade fails. The deployment workflow then requires `/ping` to become healthy. Kudu/SSH is still
available for `current` and other diagnostics, but a normal deployment does not require a manual
`upgrade head` command.

### Copying a production roster and picks to localhost
Use a JSON snapshot when you need production pigeon names/numbers and picks for local
troubleshooting. Snapshots contain pigeon details and picks only; they never include users,
email addresses, password hashes, or sessions.

First, from the production App Service's Kudu/SSH console, export the source tenant to a temporary
file and transfer it securely to the development machine before the App Service instance is
recycled:
```bash
python -m backend.cli export-tenant-picks --tenant 1 --output snapshots/production-tenant-1.json
```

The local target tenant must already exist and have a locally synced NFL schedule. The importer
only runs when `APP_ENV=development` and the database host is localhost. It displays every planned
roster change and pick replacement, then requires you to type `yes`:
```powershell
conda activate pigeon
python -m backend.cli sync-schedule
python -m backend.cli import-tenant-picks --tenant 1 --input snapshots/production-tenant-1.json
```

Without `--week`, import reconciles pigeons by name first (including renumbering), creates missing
pigeons, retains non-conflicting local-only pigeons, and replaces all picks in the target tenant.
To refresh just one week's picks later in the season without changing pigeons, use:
```powershell
python -m backend.cli import-tenant-picks --tenant 1 --input snapshots/production-tenant-1.json --week 6
```
Source and target tenant IDs and names are shown for comparison but never changed; different IDs
are allowed. Import stops before making changes if a local-only pigeon occupies a number needed by
the snapshot or if its games do not match the local schedule.

### League (tenant) management
```bash
python -m backend.cli list-leagues
# Read-only roster validation for all leagues (add --tenant ID or --json as needed)
python -m backend.cli validate-rosters
# Create a new league (creates the commissioner user if needed)
python -m backend.cli create-league --name "My Pool" --commissioner-email admin@example.com
# Delete a league and all its data (orphaned users are also deleted)
python -m backend.cli delete-league <tenant_id> --yes
```

Run `validate-rosters` before and after roster/schema deployments. It checks owner, assignment,
membership, primary-pigeon, role, numbering, and commissioner invariants without changing data.
Integrity errors return a nonzero exit code. Global users with no tenant or pigeon relationships
are printed as informational warnings and are never deleted by this command.

To diagnose schema drift without changing the configured database, run:
```bash
python -m backend.cli verify-schema-baseline
python -m backend.cli verify-schema-baseline --json
```
The command checks tables, columns, constraints, indexes, views, functions, and triggers, and
returns a nonzero exit code when it detects drift. It permits the lazily created
`password_reset_uses` table to be either absent or present with its exact expected definition.

New-league onboarding flow:
1. Run `create-league` — creates the commissioner user if needed, plus the tenant and a placeholder "Commissioner" player
2. Commissioner logs in; their new league appears in the tenant switcher
3. Commissioner goes to League Settings → Roster to add pigeons with their owner and optional managers
4. New users visit the site and use "Forgot Password" to set their password before first login

### Scheduler jobs (run immediately, bypass time gates)
```bash
python -m backend.cli run-job score_sync
python -m backend.cli run-job email_sun --dry-run
python -m backend.cli show-email-recipients --which tue
```

### 2. Frontend setup
1. Install node.js from https://nodejs.org/en/download

2. Install the frontend
```bash
cd frontend
npm install
npm audit fix
```

3. start the front-end
```bash
cd frontend
npm run dev
```
Note: You can also run the `pigeon FE` VS Code task.

Note: the first time you sign in, you will need to go through password reset. Emailing the reset URL is
not currently implemented, but in the backend logs, yhou will see something like:
```
DEBUG (auth.py:350): password-reset: reset link = http://localhost:5173/reset-password?token=xxx
```
Type that link into a browser to complete the password reset


### 3. Subsequent runs
From VS Code, run the `pigeon pool` task to start both the backend and frontend. You can also run
`pigeon BE` and `pigeon FE` separately if you only need one side. The backend task automatically
runs the configured development database to Alembic `head` before starting Uvicorn.
Once those are running, point your browser to http://localhost:5173

## Implementation notes
It's currently running on low-tier/low-cost Azure resoures; a free FE, B1 backend, lowest end PostgreSQL flexible server

For disaster recovery, we rely on Azure's built-in PITR with no zone redundancy:
* It automatically takes continuous backups for the last 7 days (the default is perfect for our use-case)
* To restart from the Azure portal: DB/settings/backend and restore. Then select a snapshot and restore. Note - this will create a new SQL instance, and the Backend will then need to be pointed to it
In the future, we might consider adding zone redundancy

These scheduled jobs are implemented in backend/utils/scheduler:
* During games, the BE syncs scores from ESPN every PP_LIVE_POLL_SECONDS (see backend/.env)
** The FE auto-refreshed from the BE when it has the focus every VITE_AUTO_REFRESH_INTERVAL_MINUTES
* Sunday emails, right after SNF completes, letting them know the monday-night "what ifs" anaytics are ready
* Monday emails, right after MNF completes, congratulating the winner and reminding them to enter next weeks picks
* Tuesday emails at 5pm to any pigeon who hasn't yet entered their picks
* Note: Picks lock at midnight on Tuesday unless the admin changes that

There is currently a fair bit of code needed for interop with Andy's current system, which bloats the BE,
slows down the submission UX horribly, and makes the BE deployment much slower (setting up Playright). When
we go standalone next year, the following changes should be made to the BE (or at least temporarily disabled)
* Requirements.txt: remove playwright. Also openpyxl unless we wind up using it for other features
* Azure/yml: Rework startup to remove all the playwrite installation (which takes forever)
* Code: remove import_picks_xlsx & utils/submit_picks_to_andy.py

Until that integration is retired, the production App Service's Debian 11 runtime requires
`playwright==1.61.0`; Playwright 1.62 and later no longer support that OS. `backend/startup.sh`
stores the matching Chromium build under persistent `/home/.cache/ms-playwright`. Backend CI
installs and launches that browser in a Debian 11 container, while the deployment workflow rejects
an incompatible Playwright requirement before packaging Azure. After deploying a Playwright change,
confirm the startup log reports `Playwright Chromium is ready`, launch Chromium once from Kudu/SSH,
and then perform an intended Tenant 1 submission.

## Learn more

| Document | Contents |
|----------|----------|
| [docs/contributing.md](docs/contributing.md) | Running the backend and frontend test suites |
| [docs/frontend.md](docs/frontend.md) | Frontend directory structure, key data flows, build commands |
| [docs/architecture.md](docs/architecture.md) | Multi-tenancy data model, auth/JWT, onboarding model, scheduler, known limitations |
| [LOGIN_FIXES.md](LOGIN_FIXES.md) | Deferred high-priority login and session security work |
