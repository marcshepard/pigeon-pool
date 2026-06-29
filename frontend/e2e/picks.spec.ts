import { test, expect } from "@playwright/test";
import { getState } from "./helpers/state";
import { setAuthToken } from "./helpers/auth";

test.describe("picks", () => {
  test.beforeEach(async ({ page }) => {
    await setAuthToken(page, getState().test.auth_token);
  });

  test("enter-picks page loads and shows unlocked game", async ({ page }) => {
    await page.goto("/enter-picks");
    await expect(page.getByText(/week/i).first()).toBeVisible({ timeout: 8000 });
    // Radio buttons appear once games are loaded for the current unlocked week.
    await expect(page.getByRole("radio").first()).toBeVisible({ timeout: 8000 });
  });

  test("submit picks for unlocked game succeeds", async ({ page }) => {
    await page.goto("/enter-picks");

    // Wait for games to load (radio buttons appear)
    await expect(page.getByRole("radio").first()).toBeVisible({ timeout: 10_000 });

    // Use the double-click easter egg to auto-fill all games as home by 3.
    // This avoids the per-game validation that requires every game to have a pick.
    // Target the h6 heading (not the nav button which also contains "Enter Picks").
    await page.getByRole("heading", { name: "Enter picks" }).dblclick();
    await page.getByRole("button", { name: "Yes" }).click();

    // Wait briefly for dialog to close and draft state to apply
    await page.waitForTimeout(400);

    // Click the main Submit button
    await page.getByRole("button", { name: "Submit", exact: true }).click();

    // Expect success snackbar
    await expect(page.getByText(/picks submitted/i)).toBeVisible({ timeout: 10_000 });
    // Teardown deletes the entire test tenant, so picks created here are cleaned up automatically.
  });

  test("picks are rejected for a locked game (API)", async ({ page }) => {
    // Test via direct API call — EnterPicks hides locked games in the UI.
    const { auth_token, scored_game_ids, scored_week } = getState().test;
    const response = await page.request.post("http://localhost:8000/picks/", {
      headers: {
        Authorization: `Bearer ${auth_token}`,
        "Content-Type": "application/json",
      },
      data: {
        week_number: scored_week,
        picks: [{ game_id: scored_game_ids[0], picked_home: true, predicted_margin: 7 }],
      },
    });
    // 409 = week locked (app-layer guard), 423 = DB trigger, 422 = validation (all valid rejections)
    expect([409, 422, 423]).toContain(response.status());
  });

  test("commissioner can enter picks for another player (alt-player via API)", async ({ page }) => {
    // Verify the alt-player API path by submitting with an explicit player_id query param.
    const { auth_token, player_id, submission_game_id, submission_week } = getState().test;
    const response = await page.request.post(
      `http://localhost:8000/picks/?player_id=${player_id}`,
      {
        headers: {
          Authorization: `Bearer ${auth_token}`,
          "Content-Type": "application/json",
        },
        data: {
          week_number: submission_week,
          picks: [{ game_id: submission_game_id, picked_home: false, predicted_margin: 3 }],
        },
      },
    );
    expect(response.status()).toBe(201);

    // Clean up
    await page.request.delete(
      `http://localhost:8000/picks/${player_id}/${submission_game_id}`,
      { headers: { Authorization: `Bearer ${auth_token}` } },
    );
  });
});
