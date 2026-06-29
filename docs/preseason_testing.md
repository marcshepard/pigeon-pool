# Preseason Testing Plan

Run the app against real NFL preseason data for a few weeks before the regular season
starts. This exercises the full stack (schedule sync, pick entry, score sync, emails,
leaderboard) with live data, without injecting synthetic fixtures.

## Why

The multi-tenant migration (Stages 0–12) was tested locally against last year's data and
synthetic fixtures. Running against a live season — even preseason — catches any remaining
issues before the regular season starts and real picks are on the line.

## How it works

ESPN's scoreboard API uses a `seasontype` parameter:

- `1` = preseason (4 weeks, Hall of Fame game + 3 preseason weeks)
- `2` = regular season (18 weeks, the normal operating mode)
- `3` = postseason

Currently `seasontype` is hardcoded to `2` in `backend/utils/score_sync.py`. The plan
is to make it a config value so it can be toggled between preseason and regular season.

## Implementation (not yet done)

Three small changes — ~5 lines total:

**`backend/utils/settings.py`**
- Add `nfl_season_type: int` field to `Settings`
- Read from `os.getenv("NFL_SEASON_TYPE", "2")`

**`backend/.env`**
- Add `NFL_SEASON_TYPE=2` (comment: `1=preseason, 2=regular season`)

**`backend/utils/score_sync.py`**
- `_fetch_scoreboard` reads `nfl_season_type` from settings instead of the hardcoded `2`
- This is the only call site; all other sync logic is unaffected

No other changes needed. The week range loop (1–18), lock-time calculation, nightly score
sync, email jobs, and leaderboard all operate on whatever game rows are in the DB — they
work correctly against preseason data with no modifications. ESPN returns empty results
for weeks 5–18 under preseason, which the loader already handles gracefully (`continue`
on empty events).

## Preseason run sequence

1. **Implement the config change** above.
2. **Set `NFL_SEASON_TYPE=1`** in `.env` (or the production environment variable).
3. **Run `sync-schedule`** via the CLI. This loads preseason weeks 1–4 into the DB
   (weeks 5–18 return no events and are skipped).
4. **Each commissioner runs "Activate Season"** in League Settings to copy the preseason
   lock times into their tenant.
5. **Play picks normally** for a few preseason weeks. The nightly scheduler syncs scores,
   updates statuses, fires emails, and updates leaderboards — all against preseason games.
6. **Verify** that the full flow works end-to-end: picks entry, lock enforcement, score
   sync, leaderboard rankings, and weekly emails.

## Switching to regular season

Once you are satisfied with preseason testing and the regular-season schedule is available
from ESPN (typically early July):

1. **Set `NFL_SEASON_TYPE=2`** in `.env` / production environment.
2. **Run `reset-season`** via the CLI. This archives picks to CSV, wipes all games
   (cascading to picks), resets `season_status` to `pending` for all players, syncs the
   regular-season schedule, and reseeds `weeks.default_lock_at`.
3. **Each commissioner runs "Activate Season"** again to copy regular-season lock times
   into their tenant.
4. The app is now on regular-season data. Preseason picks are gone (archived to CSV only).

## Notes

- Preseason picks entered during testing are wiped by `reset-season` — this is expected
  and intentional. The CSV archive preserves them if needed.
- ESPN preseason week numbers (1–4) map directly to DB `week_number` 1–4. When regular
  season loads, these rows are overwritten/replaced by `reset-season`.
- If the regular-season schedule is not yet available from ESPN when you run `reset-season`,
  the sync step will import nothing and `weeks.default_lock_at` will be empty. Wait until
  ESPN has the schedule (usually early July) before running `reset-season`.
