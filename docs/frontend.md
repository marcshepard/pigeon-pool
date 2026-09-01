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

- **Mobile sign-in**: iOS and Android browsers show platform-specific Home Screen installation
  instructions at the bottom of the sign-in page. The prompt is hidden when the app is already
  running in standalone mode.
- **Auth**: `useAuth` → JWT stored in localStorage → `Authorization: Bearer` header on every API call.
  Signing in, signing out, or switching tenants invalidates all in-memory application caches;
  tenant switching then reloads the page so cached results can never cross an auth context.
  Login failures remain generic and point first-time users to password reset. The reset form
  mirrors the backend's 8–128 character password policy.
- **Picks/Results**: `useResults(week)` fetches `/results/weeks/{week}/picks` and `/results/weeks/{week}/leaderboard`, then shapes via `resultsShaping.ts`
- **Analytics**: Both "Your Picks" and "Top 5" tabs consume the same `useResults` data, displayed differently
- **YTD leaderboard**: `useYtd` fetches `/results/leaderboard` (all locked weeks concatenated)
- **Schedule/games**: `useSchedule` and `useAppCache` fetch from `/schedule`
- **League administration**: `/admin` opens Settings by default, followed by Roster and Picks.
  The Roster page fetches the aggregate `/admin/pigeons` collection and renders a read-only table
  (responsive cards on small screens). New and Edit submit one complete pigeon aggregate; Delete
  uses a confirmation dialog. Successful POST/PUT responses replace the affected row locally,
  while failed mutations leave displayed state unchanged. The optional Notes and Status columns
  can be hidden from the Columns menu; visibility is stored in the browser per tenant. New and
  Delete are hidden once any week is locked.
- **Admin Locks & Picks page**: The week selector offers only not-yet-started weeks. For a week
  that has not locked yet it shows a pick-submission status list from `/admin/weeks/{week}/pick-status`
  (pigeon number, name, and a Submitted / Not submitted chip, with a filter defaulting to
  "Not submitted") — never the picks themselves, so the commissioner gains no preview of margins.
  Once a week has locked it shows the full picks grid from `/admin/weeks/{week}/picks`. See
  architecture.md "Pre-lock pick visibility".
- **Roster people fields**: Owner and additional managers are edited together with free-text email
  autocomplete over people already visible in the league roster. The owner is optional; a pigeon
  with no assigned people is displayed as “Not using the app.” Email text can be copied and pasted
  between the fields. On submission, the owner is removed from the additional-manager list; a
  former owner retains access only when explicitly added as a manager.
- **Roster notes**: The edit dialog includes a commissioner-only “Notes” field backed by
  `players.commissioner_notes`. The roster shows a 20-character preview and a copy action that
  copies the complete note. Notes are limited to 2,000 characters and never enter member-facing
  frontend data flows.
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
