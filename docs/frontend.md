# Frontend

React + TypeScript + Vite + MUI application.

## Directory structure

| Path | Contents |
|------|----------|
| `src/pages/` | Top-level page components (PicksAndResults, Analytics, YearToDatePage, Admin, etc.) |
| `src/pages/analytics/` | Analytics tab sub-components (YourPicks, Top5Playground, MnfOutcomes) |
| `src/hooks/` | Data-fetching hooks (useResults, useYtd, useSchedule, useAppCache, useAuth) |
| `src/backend/` | API fetch functions and shared types (`fetch.ts`, `types.ts`) |
| `src/components/` | Shared UI components |
| `src/auth/` | Auth context and useAuth hook |
| `src/utils/` | Pure utilities (resultsShaping.ts, etc.) |

## Key data flows

- **Auth**: `useAuth` → JWT stored in localStorage → `Authorization: Bearer` header on every API call
- **Picks/Results**: `useResults(week)` fetches `/results/weeks/{week}/picks` and `/results/weeks/{week}/leaderboard`, then shapes via `resultsShaping.ts`
- **Analytics**: Both "Your Picks" and "Top 5" tabs consume the same `useResults` data, displayed differently
- **YTD leaderboard**: `useYtd` fetches `/results/leaderboard` (all locked weeks concatenated)
- **Schedule/games**: `useSchedule` and `useAppCache` fetch from `/schedule`

## Running locally

```bash
cd frontend
npm install
npm run dev       # http://localhost:5173
npm run build     # production build
npx tsc --noEmit  # type-check only
```
