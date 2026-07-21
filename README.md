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

### 1. DB setup
1. Install PostgreSQL, take all the defaults (they should match backend/.env), create a DB called "pigeon_pool", note the password
2. Run database/schema.sql to create the DB schema
3. Add yourself as an admin user and pigeon using the database/queries/add_user.sql script

### 2. Backend API setup
1. Create a backend/.env.development.local file and add these lines:
```env
POSTGRES_PASSWORD=whatever password you used when installing postgresql
JWT_SECRET=any-string-you-like
EMAIL_ACCESS_KEY=<get from Marc or Joe>
```
Note: this file constains secrets and will be .gitignored. Never check in secrets.

2. Create and activate an anaconda environment
```bash
conda create -n pigeon python=3.12
conda activate pigeon
pip install -r backend/requirements.txt
```

3. Run the CLI to populate the DB with the NFL schedule
```bash
python -m backend.cli sync-schedule
```

4. Run the CLI to sync historic pigeon picks from previous weeks into the DB
First, get a copy of picks 2025.xlsx (not checked in for privacy reasons). Then:
```bash
python -m backend.cli import-picks-xlsx
```

5. Run the CLI to sync historic scores from previous weeks into the DB
For example, to sync scores from the first 6 weeks of the season:
```bash
python -m backend.cli sync-scores 6
```

6. Start the server
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

### Running CLI commands against production
`backend.cli` picks its DB target from `APP_ENV` (see `backend/utils/settings.py`), which
defaults to `development` — i.e. localhost. To point a CLI command at production instead, set
`APP_ENV=production` plus the three secrets that are normally supplied by Azure App Service
config (`POSTGRES_PASSWORD`, `JWT_SECRET`, `EMAIL_ACCESS_KEY`).

Use `conda activate pigeon` + `python -m backend.cli ...`, **not**
`conda run -n pigeon python -m backend.cli ...`. Commands like `reset-season` and
`delete-league` prompt for an interactive `yes` confirmation via `input()`, and in Windows
PowerShell `conda run` doesn't forward an interactive TTY for that prompt — it fails
immediately with `[cli] Aborted (no TTY — use --yes to skip confirmation)`. `conda activate`
runs the command directly in your shell, so the prompt works normally.

**Option A — per-shell env vars** (no secrets on disk):
```powershell
conda activate pigeon
$env:APP_ENV = "production"
$env:POSTGRES_PASSWORD = "<from Azure App Service Configuration>"
$env:JWT_SECRET = "<from Azure App Service Configuration>"
$env:EMAIL_ACCESS_KEY = "<from Azure App Service Configuration>"
python -m backend.cli <command> [args]
```

**Option B — `backend/.env.production.local`** (fewer commands per session): copy the same
three secrets from Azure App Service Configuration into a local `backend/.env.production.local`
file (same `KEY=value` format as `.env.development.local`). `settings.py` loads it automatically
whenever `APP_ENV=production`, so you only need:
```powershell
conda activate pigeon
$env:APP_ENV = "production"
python -m backend.cli <command> [args]
```
This file is covered by the repo's `.env.*.local` gitignore pattern, so it won't get committed
— but it does put real production secrets at rest on your machine. Treat the copy as temporary:
delete `backend/.env.production.local` once you're done with production CLI work.

Either way, unset `APP_ENV` (or open a new shell) afterward so you don't accidentally point a
later local command at production.

### League (tenant) management
```bash
python -m backend.cli list-leagues
# Read-only roster validation for all leagues (add --tenant ID or --json as needed)
python -m backend.cli validate-rosters
# Create a new league (commissioner must already have a user account)
python -m backend.cli create-league --name "My Pool" --commissioner-email admin@example.com
# Delete a league and all its data (orphaned users are also deleted)
python -m backend.cli delete-league <tenant_id> --yes
```

Run `validate-rosters` before and after roster/schema deployments. It checks owner, assignment,
membership, primary-pigeon, role, numbering, and commissioner invariants without changing data.
Integrity errors return a nonzero exit code. Global users with no tenant or pigeon relationships
are printed as informational warnings and are never deleted by this command.

New-league onboarding flow:
1. Run `create-league` — creates the tenant and a placeholder "Commissioner" player
2. Commissioner logs in; their new league appears in the tenant switcher
3. Commissioner goes to League Settings → Roster to add pigeons with their owner and optional managers
4. New users visit the site and use "Forgot Password" to set their password before first login

### Scheduler jobs (run immediately, bypass time gates)
```bash
python -m backend.cli run-job score_sync
python -m backend.cli run-job email_sun --dry-run
python -m backend.cli show-email-recipients --which tue
```

### 3. FE setup
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


### 4. Subsequent runs
From VS Code, run the `pigeon pool` task to start both the backend and frontend. You can also run
`pigeon BE` and `pigeon FE` separately if you only need one side.
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

## Learn more

| Document | Contents |
|----------|----------|
| [docs/contributing.md](docs/contributing.md) | Running the test suite, snapshot update workflow |
| [docs/frontend.md](docs/frontend.md) | Frontend directory structure, key data flows, build commands |
| [docs/architecture.md](docs/architecture.md) | Multi-tenancy data model, auth/JWT, onboarding model, scheduler, known limitations |
