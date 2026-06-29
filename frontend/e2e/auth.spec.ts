import { test, expect } from "@playwright/test";
import { getState } from "./helpers/state";
import { setAuthToken, clearAuthToken } from "./helpers/auth";

test.describe("auth", () => {
  test("login with valid credentials succeeds", async ({ page }) => {
    const { user_email, user_password } = getState().test;
    await page.goto("/login");
    // Use role=textbox for email (avoids matching the "Remember my email" checkbox)
    await page.getByRole("textbox", { name: /email/i }).fill(user_email);
    // type="password" inputs don't have role=textbox — locate by type attribute
    await page.locator('input[type="password"]').fill(user_password);
    await page.getByRole("button", { name: /sign in/i }).click();
    // Successful login redirects away from /login and shows the app
    await expect(page).not.toHaveURL(/\/login/, { timeout: 8000 });
    // App bar is a <header> (role=banner), always visible after successful login
    await expect(page.getByRole("banner")).toBeVisible({ timeout: 5000 });
  });

  test("invalid credentials shows error", async ({ page }) => {
    await clearAuthToken(page);
    await page.goto("/login");
    await page.getByRole("textbox", { name: /email/i }).fill("nobody@example.com");
    await page.locator('input[type="password"]').fill("wrongpassword");
    await page.getByRole("button", { name: /sign in/i }).click();
    // MUI Snackbar/Alert appears with error message
    await expect(page.getByRole("alert")).toBeVisible({ timeout: 5000 });
    await expect(page).toHaveURL(/\/login/);
  });

  test("unauthenticated user is redirected to login", async ({ page }) => {
    await clearAuthToken(page);
    await page.goto("/picks-and-results");
    await expect(page).toHaveURL(/\/login/);
  });

  test("authenticated user sees tenant name in app bar", async ({ page }) => {
    await setAuthToken(page, getState().test.auth_token);
    // Wait for auth/me to resolve before checking for tenant name
    const authDone = page.waitForResponse(
      (r) => r.url().includes("/auth/me") && r.status() === 200,
    );
    await page.goto("/");
    await authDone;
    // Use first() — the home page also shows "Welcome to _Test FE League" heading
    await expect(page.getByText("_Test FE League").first()).toBeVisible({ timeout: 5000 });
  });

  test("tenant switcher is visible when user has multiple tenants", async ({ page }) => {
    const snap = getState().snapshot;
    if (!snap.auth_token) {
      test.skip();
      return;
    }
    await setAuthToken(page, snap.auth_token);
    const authDone = page.waitForResponse(
      (r) => r.url().includes("/auth/me") && r.status() === 200,
    );
    await page.goto("/");
    await authDone;
    // MUI Avatar renders as div.MuiAvatar-root inside the IconButton
    const avatarBtn = page.locator("button:has(.MuiAvatar-root)");
    await avatarBtn.click({ timeout: 8000 });
    await expect(page.getByText(/switch to/i)).toBeVisible({ timeout: 5000 });
  });
});
