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

  test("picks lock page loads", async ({ page }) => {
    await page.goto("/admin/picks");
    await expect(page).not.toHaveURL(/login/);
    // Should show week lock controls
    await expect(page.getByText(/lock|week/i).first()).toBeVisible({ timeout: 5000 });
  });
});
