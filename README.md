# Pigeon pool

Web app for the pigeon pool

## Architecture overview
FE: React + Vite + MUI
Backend: Fast API + Python
DB: PostgreSQL
Hosting: Azure
Auth: Name/PW
Environments/branches: development/dev, production/main
* Non-secrets are stored in .env or .env.<environment> files.
* Secrets are stored in .env.<environment>.local (that are .gitignore'ed) or in actual environment variables (the latter for Azure)

## Quick start (localhost deployment)

### 1. DB setup
1. Install PostgreSQL, take all the defaults (they should match backend/.env), create a DB called "pigeon", note the password
2. Run database/schema.sql to create the DB schema
3. Run database/user.sql to populate the DB with users
4. Create backend/.env.development.local, and add the line POSTGRES_PASSWORD=<your password>
5. Create an activate an anaconda environment
```bash
conda create -n pigeon python=3.12
conda activate pigeon
pip install -r backend/requirements.txt
```
6. Run dbmanagement.py to populate the DB with the NFL schedule

### 2. Backend API setup
0. Get your conda environment set up (should already be done, per step 5 in DB setup)
1. Define additional secrets in backend/.env.development.local
```env
JWT_SECRET=<pick any string>
```
2. Start the server 
```bash
uvicorn backend.src.main:app --reload --port 8000
```
Note: You can also use the backend.cmd script on windows so you don't have to remember the syntax above

### 3. FE setup

### 4. Subsequent runs
