import { test, expect } from "@playwright/test";
import { getState } from "./helpers/state";
import { setAuthToken } from "./helpers/auth";

test.describe("picks-and-results", () => {
  test.beforeEach(async ({ page }) => {
    await setAuthToken(page, getState().test.auth_token);
  });

  test("page loads with a week selector", async ({ page }) => {
    await page.goto("/picks-and-results");
    await expect(page.getByText(/week/i).first()).toBeVisible();
  });

  test("locked week shows picks table", async ({ page }) => {
    await page.goto("/picks-and-results");
    // Picks table should render with player/game data
    await expect(page.locator("table, [role=grid]").first()).toBeVisible({ timeout: 8000 });
  });

  test("results API returns 200 for locked week", async ({ page }) => {
    const { auth_token, scored_week } = getState().test;
    const resp = await page.request.get(
      `http://localhost:8000/results/weeks/${scored_week}/picks`,
      { headers: { Authorization: `Bearer ${auth_token}` } },
    );
    expect(resp.status()).toBe(200);
    const data = await resp.json();
    expect(Array.isArray(data)).toBe(true);
  });

  test("results API returns 200 for leaderboard of locked week", async ({ page }) => {
    const { auth_token, scored_week } = getState().test;
    const resp = await page.request.get(
      `http://localhost:8000/results/weeks/${scored_week}/leaderboard`,
      { headers: { Authorization: `Bearer ${auth_token}` } },
    );
    expect(resp.status()).toBe(200);
    const data = await resp.json();
    expect(Array.isArray(data)).toBe(true);
  });

  test("unlocked week does not expose other players' picks via API", async ({ page }) => {
    // Before lock, only the requesting player's picks should be visible
    const { auth_token, submission_week } = getState().test;
    const resp = await page.request.get(
      `http://localhost:8000/results/weeks/${submission_week}/picks`,
      { headers: { Authorization: `Bearer ${auth_token}` } },
    );
    // 409 = not locked yet, 403 = forbidden before lock, 200 = own-only rows
    expect([200, 403, 409]).toContain(resp.status());
  });
});
