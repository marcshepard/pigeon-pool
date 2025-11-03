"""
API to submit picks to Andy's Pigeon Pool survey site using Playwright.

For Azure startup:
python -m playwright install chromium && <old startup command>
"""

# pylint: disable=line-too-long,broad-exception-caught, too-many-locals, too-many-statements

from __future__ import annotations

import asyncio
import os
import re
import sys
import threading
import queue
import tempfile
from datetime import datetime, timezone
from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from playwright.async_api import async_playwright

from backend.utils.logger import debug, info, warn

# --- Helper functions for translating the game names on the form with the game names in the database ---"""
def _dbg_log(msg: str) -> None:
    """ Helper to log debug messages from PlayWright """
    try:
        debug(msg)
    except NameError:
        info(msg)

class PickForAndy(BaseModel):
    """ A single pick to submit to Andy's Pigeon Pool survey site. """
    home: str
    away: str
    winner: Literal["home", "away"]
    spread: float


class SubmitBody(BaseModel):
    """ Body for submitting picks to Andy's Pigeon Pool survey site. """
    week: int = Field(..., ge=1, le=18)
    pigeon_number: int = Field(..., ge=1)
    player_name: str
    pin: int = Field(..., ge=0, le=9999)
    picks: List[PickForAndy]


TEAM_LABELS: Dict[str, str] = {
    "ARI": "Arizona",
    "ATL": "Atlanta",
    "BAL": "Baltimore",
    "BUF": "Buffalo",
    "CAR": "Carolina",
    "CHI": "Chicago",
    "CIN": "Cincinnati",
    "CLE": "Cleveland",
    "DAL": "Dallas",
    "DEN": "Denver",
    "DET": "Detroit",
    "GB": "Green Bay",
    "HOU": "Houston",
    "IND": "Indianapolis",
    "JAX": "Jacksonville",
    "JAC": "Jacksonville",
    "KC": "Kansas City",
    "MIA": "Miami",
    "MIN": "Minnesota",
    "NE": "New England",
    "NO": "New Orleans",
    "NYG": "NY Giants",
    "NYJ": "NY Jets",
    "LV": "Las Vegas",
    "LVR": "Las Vegas",
    "LAR": "LA Rams",
    "LAC": "LA Chargers",
    "PHI": "Philadelphia",
    "PIT": "Pittsburgh",
    "SEA": "Seattle",
    "SF": "San Francisco",
    "TB": "Tampa Bay",
    "TEN": "Tennessee",
    "WAS": "Washington",
    "WSH": "Washington",
}


def expand_team(x: str) -> str:
    """ Expands a team abbreviation to the full team name used on Andy's form. """
    return TEAM_LABELS.get(x.strip().upper(), x)


async def build_submit_body_from_db(
    session: AsyncSession,
    *,
    week: int,
    pigeon_number: int,
    pin: int,
) -> SubmitBody:
    """ Builds a SubmitBody by querying the database for the player's picks. """
    r = await session.execute(
        text("SELECT pigeon_name FROM players WHERE pigeon_number=:pn"),
        {"pn": pigeon_number},
    )
    row = r.first()
    if not row:
        raise RuntimeError(f"No player for pigeon_number={pigeon_number}")
    player_name: str = row[0]

    r = await session.execute(
        text(
            """
            SELECT p.game_id, p.picked_home, p.predicted_margin,
                   g.home_abbr, g.away_abbr
            FROM picks p
            JOIN games g ON g.game_id = p.game_id
            WHERE p.pigeon_number=:pn AND g.week_number=:wk
            ORDER BY g.kickoff_at ASC, p.game_id ASC
            """
        ),
        {"pn": pigeon_number, "wk": week},
    )
    rows = r.fetchall()
    if not rows:
        raise RuntimeError(f"No picks for pigeon={pigeon_number} week={week}")

    picks: List[PickForAndy] = []
    for _, picked_home, margin, home_abbr, away_abbr in rows:
        home = expand_team(home_abbr)
        away = expand_team(away_abbr)
        winner = "home" if picked_home else "away"
        picks.append(PickForAndy(home=home, away=away, winner=winner, spread=float(margin)))

    return SubmitBody(
        week=week,
        pigeon_number=pigeon_number,
        player_name=player_name,
        pin=pin,
        picks=picks,
    )


async def _enter_form(page) -> None:
    if await page.locator("body.survey-start").count() > 0:
        btn = page.locator('input[type="submit"][value*="Start Survey" i]')
        if await btn.count() > 0:
            await btn.click(timeout=6000)
        else:
            await page.get_by_role("button", name=re.compile(r"start\s+survey", re.I)).click(timeout=6000)
    await page.wait_for_selector("body.survey-page-1", timeout=8000)
    await page.wait_for_function(
        "typeof window.survey==='object' && Array.isArray(window.survey.pages)",
        timeout=8000,
    )

    # Extra assert + context for logs if form isn't present
    if await page.locator("form#page-1").count() == 0:
        html_snip = (await page.content())[:600]
        _dbg_log("[submit] Did not find form#page-1; first 600 chars of HTML:\n" + html_snip)
        raise RuntimeError("expected survey form not found")

async def submit_to_andy(body: SubmitBody, deadline_sec: int = 20) -> Dict[str, Any]:
    """ Submits picks to Andy's Pigeon Pool survey site using Playwright. """
    url = f"https://pigeonpool.survey.fm/week{str(body.week).zfill(2)}-25"
    info(f"Submitting picks to Andy's Pigeon Pool: {url}")
    shot = os.path.join(
        tempfile.gettempdir(),
        f"andy-w{body.week}-p{body.pigeon_number}-{datetime.now(timezone.utc):%Y%m%d-%H%M%S}.png",
    )

    async def _run() -> Dict[str, Any]:
        async with async_playwright() as pw:
            browser = await pw.chromium.launch(args=["--no-sandbox"])
            page = await browser.new_page()

            # Pipe page console/errors into your logs
            page.on("console", lambda m: debug(f"[PAGE CONSOLE] {m.type}: {m.text}"))
            page.on("pageerror", lambda e: warn(f"[PAGE ERROR] {e}"))

            try:
                await page.goto(url, wait_until="domcontentloaded")
                await _enter_form(page)

                # --- Survey JSON & index (same as before) ---
                survey = await page.evaluate("window.survey")
                q_by_title: Dict[str, Dict[str, Any]] = {}
                for pg in survey["pages"]:
                    for q in pg.get("questions", []):
                        t = (q.get("title") or "").strip()
                        if t:
                            q_by_title[t] = q

                debug(f"[submit] Indexed {len(q_by_title)} questions. First few: "
                      + ", ".join(list(q_by_title.keys())[:5]))

                def pref(title: str) -> Optional[str]:
                    m = re.match(r"^(.*?):\s*(WINNER|SPREAD)\s*$", title)
                    return m.group(1) if m else None

                winners: Dict[str, Dict[str, Any]] = {}
                spreads: Dict[str, Dict[str, Any]] = {}
                for t, q in q_by_title.items():
                    pfx = pref(t)
                    if not pfx:
                        continue
                    if t.endswith("WINNER"):
                        winners[pfx] = q
                    elif t.endswith("SPREAD"):
                        spreads[pfx] = q

                debug(f"[submit] WINNER questions: {len(winners)}; SPREAD questions: {len(spreads)}")

                # --- NEW: normalized lookup tables for 'vs' and '(...)' ---
                parens_re = re.compile(r"\s*\(.*?\)\s*")
                def _norm_key(s: str) -> str:
                    # strip parentheticals, unify vs->at, collapse spaces, lowercase
                    s2 = parens_re.sub(" ", s)
                    s2 = re.sub(r"\bvs\b", "at", s2, flags=re.I)
                    s2 = re.sub(r"\s+", " ", s2).strip().lower()
                    return s2

                winners_norm = { _norm_key(k): v for k, v in winners.items() }
                spreads_norm = { _norm_key(k): v for k, v in spreads.items() }

                # --- Fill identity fields (unchanged) ---
                async def fill_text(title: str, val: str) -> None:
                    q = q_by_title.get(title)
                    if not q:
                        warn(f"[submit] Missing question titled '{title}'")
                        raise RuntimeError(f"Missing question: {title}")
                    qid = str(q["question_id"])
                    qtype = int(q.get("question_type") or 0)
                    suffix = "text" if qtype == 100 else "value"  # 100=text, 1100=value
                    sel = f'input[name="q_{qid}[{suffix}]"]'
                    if await page.locator(sel).count() == 0:
                        warn(f"[submit] Expected input not found for '{title}' selector='{sel}'")
                        raise RuntimeError(f"Input field not found: {title}")
                    await page.fill(sel, val)
                    debug(f"[submit] Filled '{title}'")

                await fill_text("Pigeon Number:", str(body.pigeon_number))
                await fill_text("Player Name:", body.player_name)
                await fill_text("Please enter your 4-digit PIN:", str(body.pin).zfill(4))

                # --- Fill each pick (now with normalized fallback for titles only) ---
                for pick in body.picks:
                    # literal candidates first (unchanged behavior)
                    cands = [
                        f"{pick.away} at {pick.home}",
                        f"{pick.home} at {pick.away}",
                    ]
                    wq = None
                    sq = None
                    key_used = None
                    used_normalized = False

                    # Try literal
                    for c in cands:
                        wq = winners.get(c)
                        sq = spreads.get(c)
                        if wq and sq:
                            key_used = c
                            break

                    # Try normalized (handles 'vs' and '(...)')
                    if not (wq and sq):
                        for c in cands:
                            nk = _norm_key(c)
                            wq = winners_norm.get(nk)
                            sq = spreads_norm.get(nk)
                            if wq and sq:
                                key_used = c
                                used_normalized = True
                                break

                    if not (wq and sq):
                        sample_w = list(winners.keys())[:5]
                        sample_s = list(spreads.keys())[:5]
                        warn(f"[submit] Could not find WINNER/SPREAD for '{cands[0]}'. "
                             f"Sample WINNER keys: {sample_w} | SPREAD keys: {sample_s}")
                        raise RuntimeError(f"Could not find WINNER/SPREAD for '{cands[0]}'")

                    if used_normalized:
                        debug(f"[submit] Matched via normalized key: '{key_used}'")

                    winner_team = pick.home if pick.winner == "home" else pick.away

                    ans_id = None
                    for ans in wq.get("answers", []):
                        if ans.get("text", "").strip().lower() == winner_team.lower():
                            ans_id = str(ans["id"])
                            break
                    if not ans_id:
                        opts = [a.get("text", "") for a in wq.get("answers", [])]
                        warn(f"[submit] No radio answer for team '{winner_team}' in '{key_used}'. "
                             f"Available answers: {opts}")
                        raise RuntimeError(f"No radio answer for team '{winner_team}' in '{key_used}'")

                    qid_w = str(wq["question_id"])
                    await page.check(f'#q_{qid_w}_{ans_id}', timeout=8000)
                    qid_s = str(sq["question_id"])
                    await page.fill(f'input[name="q_{qid_s}[value]"]', str(pick.spread))
                    debug(f"[submit] Filled: {key_used} → winner '{winner_team}', spread {pick.spread}")

                # Pre-submit sanity
                checked = await page.evaluate(
                    "Array.from(document.querySelectorAll('input[type=radio]:checked')).length"
                )
                debug(f"[submit] Checked radio count: {checked}; expected={len(body.picks)}")

                # --- Click Finish and REQUIRE the success text (unchanged) ---
                await page.get_by_role("button", name=re.compile(r"finish\s+survey", re.I)).click(timeout=8000)

                success_selector = "text=Your picks have been recorded."
                error_selector = ".PDF_error, .error, .qError, .PDF_mand ~ .error"
                try:
                    await page.wait_for_selector(success_selector, timeout=10000)
                    submitted_ok = True
                except Exception:
                    submitted_ok = False

                await page.screenshot(path=shot, full_page=True)

                if not submitted_ok:
                    err_count = await page.locator(error_selector).count()
                    if err_count:
                        texts = await page.locator(error_selector).all_inner_texts()
                        warn(f"[submit] Submit failed due to validation. Errors ({err_count}): {texts[:5]}")
                        raise RuntimeError("submit_failed:validation")
                    warn(f"[submit] Submit failed: success text not found. Current URL: {page.url}")
                    raise RuntimeError("submit_failed:unknown")

                await browser.close()
                return {"ok": True, "screenshot_path": shot}

            except Exception:
                await browser.close()
                raise

    # Windows worker thread wrapper (unchanged semantics)
    if sys.platform.startswith("win"):
        def _run_in_proactor_thread(coro: "asyncio.Future[Dict[str, Any]]") -> Dict[str, Any]:
            q: "queue.Queue[tuple[str, object]]" = queue.Queue()
            def _worker() -> None:
                try:
                    asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())  # type: ignore[attr-defined]
                    result = asyncio.run(coro)
                    q.put(("ok", result))
                except Exception as e:
                    q.put(("err", e))
            t = threading.Thread(target=_worker, daemon=True)
            t.start()
            t.join(deadline_sec)
            if t.is_alive():
                warn("[submit] Timed out waiting for Playwright worker thread")
                raise RuntimeError("timeout")
            kind, payload = q.get_nowait()
            if kind == "ok":
                return payload  # type: ignore[return-value]
            raise payload  # type: ignore[misc]

        return _run_in_proactor_thread(_run())

    try:
        return await asyncio.wait_for(_run(), timeout=deadline_sec)
    except asyncio.TimeoutError:
        warn("[submit] Timed out waiting for Playwright submit coroutine")
        raise
