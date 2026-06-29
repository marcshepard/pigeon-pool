/**
 * Snapshot tests — compare API responses and rendered page content against
 * golden files to catch regressions in backend output and FE calculation logic.
 *
 * These tests run against the REAL tenant (tenant 1 / the actual pool) so
 * they capture meaningful season data. They are skipped when the DB contains
 * only synthetic fixtures (no real scored games).
 *
 * Update golden files: npx playwright test snapshots --update-snapshots
 */

import { test, expect } from "@playwright/test";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";
import { getState } from "./helpers/state";
import { setAuthToken } from "./helpers/auth";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SNAPSHOTS_DIR = path.resolve(__dirname, "snapshots");
const UPDATE = process.env.UPDATE_SNAPSHOTS === "1";

// ── helpers ───────────────────────────────────────────────────────────────────

function snapshotPath(name: string) {
  return path.join(SNAPSHOTS_DIR, name);
}

function loadSnapshot(name: string): unknown {
  return JSON.parse(readFileSync(snapshotPath(name), "utf-8"));
}

function saveSnapshot(name: string, data: unknown) {
  mkdirSync(SNAPSHOTS_DIR, { recursive: true });
  writeFileSync(snapshotPath(name), JSON.stringify(data, null, 2), "utf-8");
}

function checkSnapshot(name: string, data: unknown) {
  if (UPDATE) {
    saveSnapshot(name, data);
    return;
  }
  if (!existsSync(snapshotPath(name))) {
    throw new Error(
      `Snapshot missing: ${name}. Run with UPDATE_SNAPSHOTS=1 to generate.`,
    );
  }
  expect(data).toEqual(loadSnapshot(name));
}

// ── skip guard ────────────────────────────────────────────────────────────────

test.beforeEach(({}, testInfo) => {
  if (!getState().has_real_games) {
    testInfo.annotations.push({
      type: "skip",
      description: "No real scored games in DB",
    });
    test.skip();
  }
  if (!getState().snapshot.auth_token) {
    testInfo.annotations.push({
      type: "skip",
      description: "No real-tenant commissioner found",
    });
    test.skip();
  }
});

// ── YTD leaderboard ───────────────────────────────────────────────────────────

test("snapshot: YTD leaderboard API response", async ({ page }) => {
  const { auth_token } = getState().snapshot;
  const resp = await page.request.get("http://localhost:8000/results/leaderboard", {
    headers: { Authorization: `Bearer ${auth_token}` },
  });
  expect(resp.status()).toBe(200);
  checkSnapshot("ytd_leaderboard.json", await resp.json());
});

test("snapshot: YTD page renders expected number of rows", async ({ page }) => {
  await setAuthToken(page, getState().snapshot.auth_token!);
  await page.goto("/year-to-date");
  // Wait for table to populate
  const rows = page.locator("table tbody tr, [role=row]");
  await expect(rows.first()).toBeVisible({ timeout: 8000 });
  const count = await rows.count();
  checkSnapshot("ytd_rendered_row_count.json", { row_count: count });
});

// ── week picks + leaderboard ─────────────────────────────────────────────────

const SNAP_WEEKS = [1, 10];

for (const week of SNAP_WEEKS) {
  test(`snapshot: week ${week} picks API response`, async ({ page }) => {
    const { auth_token } = getState().snapshot;
    const resp = await page.request.get(
      `http://localhost:8000/results/weeks/${week}/picks`,
      { headers: { Authorization: `Bearer ${auth_token}` } },
    );
    expect(resp.status()).toBe(200);
    checkSnapshot(`week_${week}_picks.json`, await resp.json());
  });

  test(`snapshot: week ${week} leaderboard API response`, async ({ page }) => {
    const { auth_token } = getState().snapshot;
    const resp = await page.request.get(
      `http://localhost:8000/results/weeks/${week}/leaderboard`,
      { headers: { Authorization: `Bearer ${auth_token}` } },
    );
    expect(resp.status()).toBe(200);
    checkSnapshot(`week_${week}_leaderboard.json`, await resp.json());
  });
}

// ── analytics ─────────────────────────────────────────────────────────────────
// Analytics uses FE-side calculations (useMnfOutcomes, bestPossibleRank, Top5).
// We snapshot the rendered text content for a completed week to catch regressions
// in those calculations when season data is stable.

test("snapshot: analytics page renders for a completed week (week 1)", async ({ page }) => {
  await setAuthToken(page, getState().snapshot.auth_token!);
  await page.goto("/analytics");

  // Wait for both selectors to populate (they load async from API)
  const weekCombo = page.getByRole("combobox", { name: /week/i });
  await expect(weekCombo).not.toBeEmpty({ timeout: 10_000 });
  const pigeonCombo = page.getByRole("combobox", { name: /pigeon/i });
  await expect(pigeonCombo).not.toBeEmpty({ timeout: 5_000 });

  // Select week 1 (MUI Select)
  await weekCombo.click();
  await page.getByRole("option", { name: /week 1$/i }).click();

  // Wait for the Your Picks tab panel content to load (API call for picks data)
  await page.waitForResponse(
    (r) => r.url().includes("/results/weeks/1/picks") && r.status() === 200,
    { timeout: 10_000 },
  );

  // Capture section headings as a structural snapshot.
  const headings = await page.locator("h6, h5, h4").allTextContents();
  checkSnapshot("analytics_week1_headings.json", { headings: headings.filter(Boolean) });
});

test("snapshot: analytics Top 5 tab loads without errors (week 1)", async ({ page }) => {
  await setAuthToken(page, getState().snapshot.auth_token!);
  await page.goto("/analytics");

  // Wait for selectors to populate
  const weekCombo = page.getByRole("combobox", { name: /week/i });
  await expect(weekCombo).not.toBeEmpty({ timeout: 10_000 });
  const pigeonCombo = page.getByRole("combobox", { name: /pigeon/i });
  await expect(pigeonCombo).not.toBeEmpty({ timeout: 5_000 });

  // Select week 1
  await weekCombo.click();
  await page.getByRole("option", { name: /week 1$/i }).click();

  // Wait for picks data to load, then switch to Top 5 tab
  await page.waitForResponse(
    (r) => r.url().includes("/results/weeks/1/picks") && r.status() === 200,
    { timeout: 10_000 },
  );
  await page.getByRole("tab", { name: /top 5/i }).click();

  // Wait for Top5Playground or MnfOutcomes to render — either will contain one of these texts
  await expect(
    page.getByText(/top five|top 5|mnf outcome|check back|no mnf scenarios/i).first()
  ).toBeVisible({ timeout: 10_000 });
});
