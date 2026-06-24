# Pigeon pool

Web app for the pigeon pool

## Architecture overview
| Component | Architecture |
| --------- | ------------ |
| Frontend  | React + Vite + MUI |
| Backend   | Fast API + Python
| Data      | PostgreSQL |
| Hosting   | Azure |
| Auth      | Name/PW w self-reset |
| Monitoring | App insights implements a ping test, provides per API error and timing stats |
| Diagnostics | Backend logs are sent to an Azure log analytics instance |

| Branch | Environment | Purpose |
| ------ | ----------- | ------- |
| dev    | development | localhost development |
| main   | production  | azure hosted app, CI/CD using github actions |
| multi  | development | multi-tenancy migration work (uses `pigeon_pool_multi` DB clone) |

Environment configuration:
* .env - default non-secret values for dev/localhost
* .env.development.local - secrets for dev/localhost (or just use environment variables) - gitignore'd
* .env.production - overrides of non-secrets in .env for main/production
Note: there is no .env.production.local; production secrets are stored as Azure environment variables

### Switching between databases (multi-tenancy development)

The `multi` branch sets `POSTGRES_DB=pigeon_pool_multi` in `backend/.env`. Checking out that branch automatically points the app at the migration clone. Checking out `main` or `dev` restores `POSTGRES_DB=pigeon_pool`.

To recreate the clone from scratch:
```bash
# Windows (PowerShell) — uses the password from backend/.env.development.local
$env:PGPASSWORD = "LetMeIn!"
createdb -U postgres pigeon_pool_multi
pg_dump -U postgres pigeon_pool | psql -U postgres -d pigeon_pool_multi
```

A pre-migration snapshot is stored at `database/snapshot_pre_migration.sql`. To restore the original schema and data to the clone at any time:
```bash
$env:PGPASSWORD = "LetMeIn!"
psql -U postgres -d pigeon_pool_multi -f database/snapshot_pre_migration.sql
```

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
| [docs/multi.md](docs/multi.md) | Multi-tenant migration plan and per-stage completion notes |
