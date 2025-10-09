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
3. Run database/users.sql to populate the DB with users

### 2. Backend API setup
1. Create a backend/.env.development.local file and add these lines:
```env
POSTGRES_PASSWORD=whatever password you used when installing postgresql
JWT_SECRET=any string you like
```
Note: this file constains secrets and will be .gitignored. Never check in secrets.

2. Create and activate an anaconda environment
```bash
conda create -n pigeon python=3.12
conda activate pigeon
pip install -r backend/requirements.txt
```

3. Run the backend cli to populate the DB with the NFL schedule
```bash
python -m backend.cli sync-schedule
```
Note: the CLI has other command line options available. To see them all:
```bash
python -m backend.cli -h
```

4. Start the server
```bash
uvicorn backend.main:app --reload --port 8000
```
Note: You can also use the backend.cmd script on windows so you don't have to remember the syntax above

### 3. FE setup
1. Install node.js from https://nodejs.org/en/download
2. Start the front-end
```bash
cd fronend
npm run dev
```
Note: You can also use the frontend.cmd script on windows so you don't have to remember the syntax above

Note: the first time you sign in, you will need to go through password reset. Emailing the reset URL is
not currently implemented, but in the backend logs, yhou will see something like:
```
DEBUG (auth.py:350): password-reset: reset link = http://localhost:5173/reset-password?token=xxx
```
Type that link into a browser to complete the password reset


### 4. Subsequent runs
From windows, you can run these two commands in separate terminals (or use the more verbose syntax above):
```cmd
backend.cmd
frontend.cmd
```
Once those are running, point your browser to http://localhost:5173