"""
API to submit picks to Andy's Pigeon Pool survey site using Playwright.

For Azure startup:
python -m playwright install chromium && <old startup command>
"""

# pylint: disable=missing-module-docstring,missing-class-docstring,missing-function-docstring,line-too-long,broad-exception-caught,pointless-string-statement
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

from backend.utils.logger import info


class PickForAndy(BaseModel):
    home: str
    away: str
    winner: Literal["home", "away"]
    spread: float


class SubmitBody(BaseModel):
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
    return TEAM_LABELS.get(x.strip().upper(), x)


async def build_submit_body_from_db(
    session: AsyncSession,
    *,
    week: int,
    pigeon_number: int,
    pin: int,
) -> SubmitBody:
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


async def submit_to_andy(body: SubmitBody, deadline_sec: int = 20) -> Dict[str, Any]:
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
            try:
                await page.goto(url, wait_until="domcontentloaded")
                await _enter_form(page)

                survey = await page.evaluate("window.survey")
                q_by_title: Dict[str, Dict[str, Any]] = {}
                for pg in survey["pages"]:
                    for q in pg.get("questions", []):
                        t = (q.get("title") or "").strip()
                        if t:
                            q_by_title[t] = q

                async def fill_text(title: str, val: str) -> None:
                    q = q_by_title.get(title)
                    if not q:
                        raise RuntimeError(f"Missing question: {title}")
                    qid = str(q["question_id"])
                    qtype = int(q.get("question_type") or 0)
                    suffix = "text" if qtype == 100 else "value"  # 100=text, 1100=value
                    sel = f'input[name="q_{qid}[{suffix}]"]'
                    await page.wait_for_selector(sel, timeout=8000)
                    await page.fill(sel, val)

                await fill_text("Pigeon Number:", str(body.pigeon_number))
                await fill_text("Player Name:", body.player_name)
                await fill_text("Please enter your 4-digit PIN:", str(body.pin).zfill(4))

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

                for pick in body.picks:
                    pre = f"{pick.away} at {pick.home}"
                    if pre not in winners:
                        pre = f"{pick.home} at {pick.away}"

                    wq = winners.get(pre)
                    sq = spreads.get(pre)
                    if not wq or not sq:
                        raise RuntimeError(f"Could not find WINNER/SPREAD for '{pre}'")

                    winner_team = pick.home if pick.winner == "home" else pick.away
                    ans_id = None
                    for ans in wq.get("answers", []):
                        if ans.get("text", "").strip().lower() == winner_team.lower():
                            ans_id = str(ans["id"])
                            break
                    if not ans_id:
                        raise RuntimeError(f"No radio answer for team '{winner_team}' in '{pre}'")

                    qid_w = str(wq["question_id"])
                    await page.check(f'#q_{qid_w}_{ans_id}', timeout=8000)

                    qid_s = str(sq["question_id"])
                    await page.fill(f'input[name="q_{qid_s}[value]"]', str(pick.spread))

                await page.get_by_role("button", name=re.compile(r"finish\s+survey", re.I)).click(timeout=8000)
                await page.wait_for_load_state("networkidle", timeout=8000)
                await page.screenshot(path=shot, full_page=True)
                await browser.close()
                return {"ok": True, "screenshot_path": shot}
            except Exception as exc:  # pylint: disable=broad-exception-caught
                try:
                    await page.screenshot(path=shot, full_page=True)
                except Exception:
                    pass
                await browser.close()
                return {"ok": False, "error": str(exc), "screenshot_path": shot}

    # --- Run path selection ---
    # On Windows, uvicorn/watch reload can leave the app on a Selector loop.
    # Playwright needs subprocess support → guaranteed by Proactor.
    # To be bullet-proof, always run the coroutine in a Proactor loop inside a worker thread on Windows.
    if sys.platform.startswith("win"):
        def _run_in_proactor_thread(coro: "asyncio.Future[Dict[str, Any]]") -> Dict[str, Any]:
            q: "queue.Queue[tuple[str, object]]" = queue.Queue()

            def _worker() -> None:
                try:
                    asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())  # type: ignore[attr-defined]
                    result = asyncio.run(coro)
                    q.put(("ok", result))
                except Exception as e:  # pylint: disable=broad-exception-caught
                    q.put(("err", e))

            t = threading.Thread(target=_worker, daemon=True)
            t.start()
            t.join(deadline_sec)
            if t.is_alive():
                return {"ok": False, "error": "timeout", "screenshot_path": shot}
            kind, payload = q.get_nowait()
            if kind == "ok":
                return payload  # type: ignore[return-value]
            raise payload  # type: ignore[misc]

        return _run_in_proactor_thread(_run())

    # Non-Windows: normal await with timeout
    try:
        return await asyncio.wait_for(_run(), timeout=deadline_sec)
    except asyncio.TimeoutError:
        return {"ok": False, "error": "timeout", "screenshot_path": shot}
