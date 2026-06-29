/**
 * Analytics page smoke and functional tests.
 *
 * These tests use the TEST tenant (synthetic fixtures) so they run regardless
 * of whether real season data is present. They verify:
 *   - Page loads and core UI elements are present
 *   - Week/pigeon selectors work
 *   - Tab switching between "Your Picks" and "Top 5" works
 *   - The correct tab panel content renders based on game state
 *   - No JS errors or blank panels
 *
 * The Top 5 tab shows Top5Playground when Sunday games are not all final,
 * or MnfOutcomes when they are. For the test tenant (synthetic scored games
 * with status='final'), MnfOutcomes is expected to show.
 */

import { test, expect } from "@playwright/test";
import { getState } from "./helpers/state";
import { setAuthToken } from "./helpers/auth";

test.describe("analytics", () => {
  test.beforeEach(async ({ page }) => {
    await setAuthToken(page, getState().test.auth_token);
  });

  test("analytics page loads with week and pigeon selectors", async ({ page }) => {
    await page.goto("/analytics");
    // MUI Select renders as role=combobox; wait for async data to populate
    await expect(page.getByRole("combobox", { name: /week/i })).toBeVisible({ timeout: 8000 });
    await expect(page.getByRole("combobox", { name: /pigeon/i })).toBeVisible();
  });

  test("tabs are present: Your Picks and Top 5", async ({ page }) => {
    await page.goto("/analytics");
    await expect(page.getByRole("tab", { name: /your picks/i })).toBeVisible({ timeout: 8000 });
    await expect(page.getByRole("tab", { name: /top 5/i })).toBeVisible();
  });

  test("Your Picks tab shows content for a scored week", async ({ page }) => {
    const { scored_week } = getState().test;
    await page.goto("/analytics");

    // Wait for week selector to populate
    const weekCombo = page.getByRole("combobox", { name: /week/i });
    await expect(weekCombo).not.toBeEmpty({ timeout: 10_000 });

    // Select the scored week. If the test tenant has only one locked week it may already
    // be selected; clicking the same option is a no-op but does not cause an error.
    await weekCombo.click();
    await page.getByRole("option", { name: new RegExp(`week ${scored_week}$`, "i") }).click();

    // Your Picks tab is active by default (tab index 0)
    await expect(page.getByRole("tab", { name: /your picks/i })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    // Analytics uses conditional rendering (no role=tabpanel). The "Your Picks"
    // tab renders a DataGridLite which emits a <table> element.
    await expect(page.locator("table").first()).toBeVisible({ timeout: 10_000 });
  });

  test("Top 5 tab switches and renders without errors", async ({ page }) => {
    const { scored_week } = getState().test;
    await page.goto("/analytics");

    const weekCombo = page.getByRole("combobox", { name: /week/i });
    await expect(weekCombo).not.toBeEmpty({ timeout: 10_000 });

    await weekCombo.click();
    await page.getByRole("option", { name: new RegExp(`week ${scored_week}$`, "i") }).click();

    await page.getByRole("tab", { name: /top 5/i }).click();

    // No uncaught error text should be visible
    await expect(page.getByText(/uncaught error|unexpected error/i)).not.toBeVisible({
      timeout: 5000,
    });

    // Analytics uses conditional rendering. MnfOutcomes always renders one of:
    // "MNF Outcomes" (heading for none/check-back states), "best possible rank",
    // or Top5Playground text. Match any of these.
    await expect(
      page.getByText(/mnf outcomes|best possible rank|top five|top 5|check back|no mnf/i).first()
    ).toBeVisible({ timeout: 8_000 });
  });

  test("pigeon selector shows selected player", async ({ page }) => {
    const { scored_week } = getState().test;
    await page.goto("/analytics");

    const weekCombo = page.getByRole("combobox", { name: /week/i });
    await expect(weekCombo).not.toBeEmpty({ timeout: 10_000 });

    await weekCombo.click();
    await page.getByRole("option", { name: new RegExp(`week ${scored_week}$`, "i") }).click();

    // The test tenant has only one player (_TestFE), so the pigeon selector
    // should default to it and show it as the selected option.
    const pigeonCombo = page.getByRole("combobox", { name: /pigeon/i });
    await expect(pigeonCombo).toBeVisible();
    // MUI Select shows the selected label as text content — should not be empty
    await expect(pigeonCombo).not.toBeEmpty({ timeout: 5_000 });
  });

  test("MNF outcomes section visible for weeks with all games final", async ({ page }) => {
    const { scored_week } = getState().test;
    await page.goto("/analytics");

    const weekCombo = page.getByRole("combobox", { name: /week/i });
    await expect(weekCombo).not.toBeEmpty({ timeout: 10_000 });

    await weekCombo.click();
    await page.getByRole("option", { name: new RegExp(`week ${scored_week}$`, "i") }).click();

    await page.getByRole("tab", { name: /top 5/i }).click();

    // MnfOutcomes renders when all Sunday games are final. Matches the heading
    // "MNF Outcomes", "best possible rank", or the no-scenario fallback text.
    await expect(
      page.getByText(/mnf outcomes|best possible rank|no mnf|check back/i).first()
    ).toBeVisible({ timeout: 8_000 });
  });

  test("analytics API: week picks endpoint returns data for scored week", async ({ page }) => {
    const { auth_token, scored_week } = getState().test;
    const resp = await page.request.get(
      `http://localhost:8000/results/weeks/${scored_week}/picks`,
      { headers: { Authorization: `Bearer ${auth_token}` } },
    );
    expect(resp.status()).toBe(200);
    const data = await resp.json();
    expect(Array.isArray(data)).toBe(true);
    // Should have at least one row from the test player's picks (if any) or
    // empty if no picks were submitted — just verify the shape
    if (data.length > 0) {
      const first = data[0];
      expect(typeof first.pigeon_number).toBe("number");
      expect(typeof first.game_id).toBe("number");
    }
  });
});
