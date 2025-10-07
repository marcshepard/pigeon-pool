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
4. Create backend/.env.development.local and add the line POSTGRES_PASSWORD=<your password>
5. Create and activate an anaconda environment
```bash
conda create -n pigeon python=3.12
conda activate pigeon
pip install -r backend/requirements.txt
```
6. dbmanagement.py to populate the DB with the NFL schedule
```bash
cd backend
dbmanagement.py
```


### 2. Backend API setup
0. Your conda environment should be set up and activated already, per step 5 in DB setup above
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
1. Install node.js from https://nodejs.org/en/download
2. Start the front-end
```bash
cd fronend
npm run dev
```
Note: You can also use the frontend.cmd script on windows so you don't have to remember the syntax above

### 4. Subsequent runs
From windows, you can run these two commands in separate terminals:
```cmd
backend.cmd
frontend.cmd
```
Alternatively, use the commands above
