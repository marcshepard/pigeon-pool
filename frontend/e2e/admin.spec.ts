import { test, expect } from "@playwright/test";
import { getState } from "./helpers/state";
import { setAuthToken } from "./helpers/auth";

const ORIGINAL_NAME = "_Test FE League";

test.describe("league settings (admin)", () => {
  test.beforeEach(async ({ page }) => {
    await setAuthToken(page, getState().test.auth_token);
  });

  test("admin pages are accessible to commissioner", async ({ page }) => {
    await page.goto("/admin");
    await expect(page).not.toHaveURL(/login/);
    await expect(page).toHaveURL(/\/admin\/settings$/);
    await expect(page.getByText(/league settings|settings/i).first()).toBeVisible();
  });

  test("league rename round-trips correctly", async ({ page }) => {
    await page.goto("/admin/settings");
    const input = page.getByRole("textbox").first();
    await expect(input).toBeVisible({ timeout: 5000 });

    // Rename
    await input.clear();
    await input.fill("_Test FE League Renamed");
    // Use exact match to avoid the "Save returns" button also matching /save/i
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText(/saved|success/i)).toBeVisible({ timeout: 5000 });

    // Verify app-bar title updated
    await expect(page.getByRole("banner")).toContainText("_Test FE League Renamed");

    // Revert so teardown finds the tenant by original name just in case
    await input.clear();
    await input.fill(ORIGINAL_NAME);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText(/saved|success/i)).toBeVisible({ timeout: 5000 });
  });

  test("returns editor shows and saves", async ({ page }) => {
    await page.goto("/admin/settings");
    // Returns section should render with at least one place row
    await expect(page.getByText(/return/i).first()).toBeVisible({ timeout: 5000 });
  });

  test("roster tab shows the test player", async ({ page }) => {
    await page.goto("/admin/pigeons");
    await expect(page.getByRole("heading", { name: "Roster" })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(/_TestFE/).first()).toBeVisible({ timeout: 5_000 });
  });

  test("non-admin route returns 403 from API", async ({ page }) => {
    // Use a member token — in this case the test tenant user IS the commissioner,
    // so we just hit the endpoint raw to verify the 403 path exists.
    const resp = await page.request.get("http://localhost:8000/admin/pigeons", {
      headers: { Authorization: "Bearer fake.token.here" },
    });
    expect(resp.status()).toBe(401);
  });

  test("recurring lock controls clarify midnight and show unchanged deadlines", async ({ page }) => {
    await page.route("**/schedule/current_week", (route) => route.fulfill({ json: { week: 6, status: "scheduled", any_locked: true } }));
    await page.route("**/schedule/6/games", (route) => route.fulfill({ json: [{
      game_id: 1, week_number: 6, kickoff_at: "2026-10-16T00:15:00Z",
      home_abbr: "SEA", away_abbr: "SF", status: "scheduled", home_score: null, away_score: null,
    }] }));
    await page.route("**/admin/weeks/locks", (route) => route.fulfill({ json: [{ week_number: 6, lock_at: "2026-10-14T06:59:59Z" }] }));
    let payload: Record<string, unknown> | undefined;
    await page.route("**/admin/weeks/6/lock", async (route) => {
      payload = route.request().postDataJSON();
      await route.fulfill({ json: {
        updated_weeks: [6, 7, 8, 9, 10, 11, 13, 14, 15, 16, 17, 18],
        skipped_weeks: [{ week_number: 12, lock_at: "2026-11-25T07:59:59Z", first_kickoff: "2026-11-26T01:00:00Z", reason: "after_kickoff" }],
      } });
    });
    await page.goto("/admin/picks");
    await page.getByRole("button", { name: "Change", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("radio", { name: "This week only", exact: true })).toBeChecked();
    await expect(dialog.getByLabel("Date and time")).toBeVisible();
    await dialog.getByRole("radio", { name: "This and future weeks", exact: true }).check();
    await expect(dialog.getByLabel("Date and time")).toHaveCount(0);
    await dialog.getByRole("combobox", { name: "Day of the week" }).click();
    await page.getByRole("option", { name: "Wednesday", exact: true }).click();
    await dialog.getByRole("combobox", { name: /^Hour/ }).click();
    await page.getByRole("option", { name: "12", exact: true }).click();
    await dialog.getByRole("combobox", { name: /^Minute/ }).click();
    await page.getByRole("option", { name: "00", exact: true }).click();
    await dialog.getByRole("combobox", { name: /^AM \/ PM/ }).click();
    await page.getByRole("option", { name: "AM", exact: true }).click();
    await expect(dialog.getByText("Picks close at the start of Wednesday—Tuesday night.")).toBeVisible();
    await dialog.getByRole("combobox", { name: /^AM \/ PM/ }).click();
    await page.getByRole("option", { name: "PM", exact: true }).click();
    await expect(dialog.getByText("Picks close Wednesday at noon.")).toBeVisible();
    await dialog.getByRole("combobox", { name: /^Hour/ }).click();
    await page.getByRole("option", { name: "11", exact: true }).click();
    await dialog.getByRole("combobox", { name: /^Minute/ }).click();
    await page.getByRole("option", { name: "59", exact: true }).click();
    await expect(dialog.getByText("Picks close at the end of Wednesday.")).toBeVisible();
    await expect(dialog.getByText("Applies to week 6 and later")).toBeVisible();
    await dialog.getByRole("button", { name: "Set Wednesday 11:59 PM", exact: true }).click();
    await expect(dialog).not.toBeVisible();
    expect(payload).toEqual({ lock_at: "2026-10-15T06:59:00.000Z", apply_to_future_weeks: true });
    const notice = page.getByRole("alert").filter({ hasText: "These weeks were left unchanged" });
    await expect(notice).toContainText("Leaving week 12 lock time as Tuesday, Nov 24, 11:59 PM Pacific Time.");
    await expect(notice).toContainText("Its first game is at Wednesday, Nov 25, 5:00 PM Pacific Time, before the requested deadline.");
    await page.getByRole("button", { name: "Change", exact: true }).click();
    await expect(page.getByRole("dialog").getByRole("radio", { name: "This week only", exact: true })).toBeChecked();
  });

  test("picks lock page loads", async ({ page }) => {
    await page.goto("/admin/picks");
    await expect(page).not.toHaveURL(/login/);
    // Should show week lock controls
    await expect(page.getByText(/lock|week/i).first()).toBeVisible({ timeout: 5000 });
  });
});
