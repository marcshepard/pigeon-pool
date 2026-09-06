"""Verify that the installed Playwright Chromium browser can launch."""

from __future__ import annotations

import asyncio

from playwright.async_api import async_playwright

SMOKE_TEST_TIMEOUT_SECONDS = 15


async def _launch_browser() -> None:
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(args=["--no-sandbox"])
        try:
            page = await browser.new_page()
            await page.goto("about:blank")
        finally:
            await browser.close()


def main() -> None:
    asyncio.run(asyncio.wait_for(_launch_browser(), timeout=SMOKE_TEST_TIMEOUT_SECONDS))
    print("Playwright Chromium launch check passed.")


if __name__ == "__main__":
    main()
