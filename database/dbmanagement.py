"""
Database management utilities for the Pigeon Pool application.
"""

import os
import sys
from pathlib import Path
from getpass import getpass
from typing import Optional, Dict, Any, List
from zoneinfo import ZoneInfo
import datetime as dt

import requests
from dotenv import load_dotenv
import psycopg

PT = ZoneInfo("America/Los_Angeles")

# --------------------------
# Env loading (your pattern)
# --------------------------
def load_env_chain(project_root: Path, env_name: str) -> None:
    """
    Load .env, .env.<env>, .env.<env>.local in order, later files override earlier ones.
    Only .env is required; others are optional.
    """
    backend_dir = project_root / "backend"
    base = backend_dir / ".env"
    env_file = backend_dir / f".env.{env_name}"
    env_local = backend_dir / f".env.{env_name}.local"

    if not base.exists():
        print(f"Error: required env file not found: {base}", file=sys.stderr)
        sys.exit(1)

    for i, f in enumerate([base, env_file, env_local]):
        if f.exists():
            load_dotenv(f, override=True)
            label = "base" if i == 0 else "override"
            print(f"Loaded {label} env file: {f}")
        else:
            if i > 0:
                print(f"Optional env file not found: {f}")

# --------------------------
# DB config & prompting
# --------------------------
def build_db_config() -> Dict[str, Any]:
    """
    Build a psycopg-compatible config dict using POSTGRES_* env vars.
    Prompts interactively for any missing fields (password via getpass).
    """

    host = os.getenv("POSTGRES_HOST")
    port = os.getenv("POSTGRES_PORT")
    db   = os.getenv("POSTGRES_DB")
    user = os.getenv("POSTGRES_USER")
    pwd  = os.getenv("POSTGRES_PASSWORD")

    # Prompt only for missing ones
    if not host:
        host = input("Host [localhost]: ").strip() or "localhost"
    if not port:
        port = input("Port [5432]: ").strip() or "5432"
    if not db:
        db   = input("Database [pigeon_pool]: ").strip() or "pigeon_pool"
    if not user:
        user = input("User [postgres]: ").strip() or "postgres"
    if not pwd:
        pwd  = getpass("Password: ")

    # Validate port
    try:
        port_i = int(port)
    except (TypeError, ValueError):
        print(f"Invalid POSTGRES_PORT '{port}'; must be an integer.", file=sys.stderr)
        sys.exit(2)

    cfg = {
        "host": host,
        "port": port_i,
        "dbname": db,
        "user": user,
        "password": pwd,
    }

    print(f"Connecting to {user}@{host}:{port_i}/{db}")
    return cfg

# --------------------------
# ESPN helpers (unofficial)
# --------------------------
def get_json(url: str, params: Optional[dict] = None) -> dict:
    """ Helper to GET a URL and parse JSON response. """
    r = requests.get(url, params=params, timeout=20)
    r.raise_for_status()
    return r.json()

def iso_to_utc(ts: str) -> dt.datetime:
    """ Convert an ISO 8601 timestamp strings (ESPN format) to a UTC datetime. """
    return dt.datetime.fromisoformat(ts.replace("Z", "+00:00")).astimezone(dt.timezone.utc)

def fetch_teams() -> List[tuple]:
    """ Fetch NFL teams from ESPN API. Returns list of (abbr, name) tuples. """
    url = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/teams"
    data = get_json(url)
    teams = []
    sports = data.get("sports", [])
    if not sports:
        return teams
    leagues = sports[0].get("leagues", [])
    if not leagues:
        return teams
    for item in leagues[0].get("teams", []):
        t = item.get("team", {})
        abbr = t.get("abbreviation")
        name = t.get("displayName")
        if abbr and name:
            teams.append((abbr, name))
    return teams

def fetch_week(year: int, week: int) -> List[Dict[str, Any]]:
    """
    Fetch week schedule using ESPN's scoreboard endpoint (more consistent):
      https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?year=YYYY&week=W&seasontype=2
    seasontype: 1=Pre, 2=Regular, 3=Post
    Returns: list of {kickoff_utc, home_abbr, away_abbr}
    """
    url = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard"
    data = get_json(url, params={"year": year, "week": week, "seasontype": 2})

    out: List[Dict[str, Any]] = []
    events = data.get("events", []) or []
    for ev in events:
        comps = (ev.get("competitions") or [{}])[0]
        competitors = comps.get("competitors") or []
        # Find home/away competitors defensively
        home = next((c for c in competitors if (c.get("homeAway") or "").lower() == "home"), None)
        away = next((c for c in competitors if (c.get("homeAway") or "").lower() == "away"), None)

        # Kickoff timestamp sometimes lives on event, sometimes on competition
        date = ev.get("date") or comps.get("date")
        if not (home and away and date):
            continue

        ha = ((home.get("team") or {}).get("abbreviation") or "").strip()
        aa = ((away.get("team") or {}).get("abbreviation") or "").strip()
        if not ha or not aa:
            continue

        out.append({
            "kickoff_utc": iso_to_utc(date),
            "home_abbr": ha,
            "away_abbr": aa,
        })

    return out

def calc_lock_at_pacific(kickoffs_utc: List[dt.datetime]) -> dt.datetime:
    """
    Lock = Wednesday 23:59:59 PT before the earliest game of that week.
    """
    earliest = min(kickoffs_utc).astimezone(PT)
    # Find Wednesday of that calendar week before/at earliest kickoff week.
    # We want the Wednesday BEFORE the earliest game; if earliest is Thu, we go to the previous day.
    # weekday(): Mon=0 ... Sun=6 ; Wed=2
    days_since_wed = (earliest.weekday() - 2) % 7
    if days_since_wed == 0:
        # earliest is Wednesday → lock previous Wed
        days_since_wed = 7
    wed = earliest - dt.timedelta(days=days_since_wed)
    lock_pt = dt.datetime(wed.year, wed.month, wed.day, 23, 59, 59, tzinfo=PT)
    return lock_pt.astimezone(dt.timezone.utc)

# --------------------------
# Seeding
# --------------------------
def seed_all(db_cfg: Dict[str, Any], year: int) -> None:
    """ Seed teams, weeks, and games for the given year into the database. """
    with psycopg.connect(**db_cfg) as conn:
        conn.execute("SET TIME ZONE 'UTC';")
        with conn.cursor() as cur:
            # Teams
            teams = fetch_teams()
            print(f"Inserting {len(teams)} teams...")
            cur.executemany(
                "INSERT INTO teams (abbr, name) VALUES (%s, %s) ON CONFLICT (abbr) DO NOTHING",
                teams,
            )

            # Weeks + Games
            for week in range(1, 19):
                week_games = fetch_week(year, week)
                if not week_games:
                    print(f"Week {week}: no games found")
                    continue

                lock_at = calc_lock_at_pacific([g["kickoff_utc"] for g in week_games])
                cur.execute(
                    """
                    INSERT INTO weeks (week_number, lock_at, locked)
                    VALUES (%s, %s, FALSE)
                    ON CONFLICT (week_number) DO NOTHING
                    """,
                    (week, lock_at),
                )

                inserted = 0
                for g in week_games:
                    cur.execute(
                        """
                        INSERT INTO games (week_number, kickoff_at, home_abbr, away_abbr, status)
                        VALUES (%s, %s, %s, %s, 'scheduled')
                        ON CONFLICT (week_number, home_abbr, away_abbr) DO NOTHING
                        """,
                        (week, g["kickoff_utc"], g["home_abbr"], g["away_abbr"]),
                    )
                    inserted += cur.rowcount
                print(f"Week {week}: inserted {inserted}/{len(week_games)} games")

        conn.commit()
    print("✅ Seeding complete.")

# --------------------------
# CLI
# --------------------------
def populate_from_espn(env: str, year: int):
    """ Load env, build DB config, and run seeding for given year. """
    project_root = Path(__file__).parent.parent.resolve()
    load_env_chain(project_root, env)
    db_cfg = build_db_config()
    seed_all(db_cfg, year)

def display_help():
    """ Display help message. """
    print("\nOptions:")
    print("  h - help (this message)")
    print("  q - quit")
    print("  p - populate schedule data from ESPN\n")

def populate_schedule_data():
    """Wrapper that prompts for year/env and runs the seeding logic."""
    while True:
        env = input("Environment ([d]evelopment or [p]roduction): ").strip().lower()
        if env in ("d", "p"):
            env = "development" if env in ("d", "") else "production"
            break
    year = "2025"
    populate_from_espn(env=env, year=int(year))

def main():
    """ Simple CLI to run DB management tasks. """
    options = {
        "h": display_help,
        "q": exit,
        "p": populate_schedule_data,
    }
    display_help()
    while True:
        choice = input("What do you want to do: ").strip().lower()[:1]
        action = options.get(choice)
        if action:
            action()
        else:
            print(f"Invalid option: {choice}")
            display_help()

if __name__ == "__main__":
    main()
