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

`backend/utils/score_sync.py` never sends `seasontype` (or `week`) directly to ESPN —
see the module docstring note above `_fetch_scoreboard` for why: passing `week=` is
unreliable for a season that hasn't started yet (it silently ignores `year` and resolves
against whatever season ESPN currently considers "current"). Instead, `load_schedule()`
reads per-week date ranges from ESPN's own `leagues[0].calendar` block — which contains
*both* seasontype sub-arrays (preseason and regular season) in a single response — and
fetches each week by `dates=YYYYMMDD-YYYYMMDD` range, using `Settings.nfl_season_type`
as the calendar block selector.

## Implementation (done)

**`backend/utils/settings.py`**
- `nfl_season_type: str` field on `Settings` (string, matching ESPN's `value` field —
  not an int), read from `os.getenv("NFL_SEASON_TYPE", "2")`

**`backend/.env`**
- `NFL_SEASON_TYPE=2` (comment: `1=preseason, 2=regular season`) — the committed
  default; production relies on this and must never override it

**`backend/.env.development.local`** (gitignored)
- Set `NFL_SEASON_TYPE=1` here to test against preseason data locally. Never edit
  `score_sync.py` or `backend/.env` to do this — this file is the only place it
  should be toggled, so there's nothing to accidentally check in.

**`backend/utils/score_sync.py`**
- `load_schedule()` reads `get_settings().nfl_season_type` instead of a hardcoded
  constant when calling `_calendar_week_ranges`. This is the only call site; all
  other sync logic is unaffected.

**Preseason week-numbering quirk** (still unresolved) — ESPN's preseason calendar entries don't number 1–4
the way you'd expect. Their `entries[].value` for `seasontype="1"` is a sequential index
over labeled blocks, not a "preseason week number":

| `value` | `label` |
|---|---|
| `1` | Hall of Fame Weekend |
| `2` | Preseason Week 1 |
| `3` | Preseason Week 2 |
| `4` | Preseason Week 3 |

Since `_calendar_week_ranges` uses `entries[].value` directly as the DB `week_number`,
toggling to preseason as-is would load Hall of Fame Weekend into `week_number=1`, not
"real" Preseason Week 1. Decide (and document here) whether that's acceptable or whether
`load_schedule` needs a preseason-specific offset/skip before this is turned on.

No other changes needed. Lock-time calculation, nightly score sync, email jobs, and
leaderboard all operate on whatever game rows are in the DB — they work correctly against
preseason data with no modifications. Unlike the old `week=`-based loop, the calendar-driven
approach naturally stops after however many entries the preseason calendar block actually
has (4) — it doesn't depend on ESPN returning "empty" for out-of-range weeks as a stopping
signal.

## Preseason run sequence

1. **Decide on the week-numbering quirk** above (still open).
2. **Set `NFL_SEASON_TYPE=1`** in `backend/.env.development.local` (never `.env` or production).
3. **Run `sync-schedule`** via the CLI. This loads the preseason calendar's weeks into the DB.
4. **Each commissioner runs "Activate Season"** in League Settings to copy the preseason
   lock times into their tenant.
5. **Play picks normally** for a few preseason weeks. The nightly scheduler syncs scores,
   updates statuses, fires emails, and updates leaderboards — all against preseason games.
6. **Verify** that the full flow works end-to-end: picks entry, lock enforcement, score
   sync, leaderboard rankings, and weekly emails.

## Switching to regular season

Once you are satisfied with preseason testing and the regular-season schedule is available
from ESPN:

1. **Remove `NFL_SEASON_TYPE=1`** from `backend/.env.development.local` (or set it back to `2`).
   Production is untouched — it was never overridden, and the committed default in
   `backend/.env` is already `2`.
2. **Run `reset-season`** via the CLI. This archives picks to CSV, wipes all games
   (cascading to picks), resets `season_status` to `pending` for all players, syncs the
   regular-season schedule, and reseeds `weeks.default_lock_at`.
3. **Each commissioner runs "Activate Season"** again to copy regular-season lock times
   into their tenant.
4. The app is now on regular-season data. Preseason picks are gone (archived to CSV only).

## Notes

- Preseason picks entered during testing are wiped by `reset-season` — this is expected
  and intentional. The CSV archive preserves them if needed.
- When regular season loads, the preseason `week_number` rows (however numbered per the
  quirk above) are overwritten/replaced by `reset-season`.
- "Is the regular-season schedule available yet" is no longer a *sync returns empty vs.
  non-empty* check — that was only ever a symptom of the `week=` bug and isn't a reliable
  signal now that fetches are date-range based. To check availability directly: call ESPN's
  scoreboard with no query params and look for a `"Regular Season"` (`value: "2"`) block
  in `leagues[0].calendar` with real entries. When we last verified this (mid-July), the
  full regular-season calendar was already published — don't assume "early July" as a firm
  date; check directly instead.
