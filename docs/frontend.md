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
- **League administration**: `/admin` opens Settings by default, followed by Roster and Picks.
  The Roster page fetches the aggregate `/admin/pigeons` collection and renders a read-only table
  (responsive cards on small screens). New and Edit submit one complete pigeon aggregate; Delete
  uses a confirmation dialog. Successful POST/PUT responses replace the affected row locally,
  while failed mutations leave displayed state unchanged. New and Delete are hidden once any week
  is locked.
- **Roster people fields**: Owner and additional managers are edited together with free-text email
  autocomplete over people already visible in the league roster. Selecting a manager as owner
  removes that email from the manager list; a former owner retains access only when explicitly
  added as a manager.
- **Default pigeon**: Users who manage more than one pigeon can choose “Set default pigeon…” from
  the avatar menu. This calls `PUT /me/primary-pigeon`; the dialog explains that the selection
  applies on the next sign-in because the current JWT is not replaced.

## Running locally

```bash
cd frontend
npm install
npm run dev       # http://localhost:5173
npm run build     # production build
npx tsc --noEmit  # type-check only
```
