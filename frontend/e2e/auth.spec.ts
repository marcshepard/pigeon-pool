import { test, expect } from "@playwright/test";
import { getState } from "./helpers/state";
import { setAuthToken, clearAuthToken } from "./helpers/auth";

test.describe("auth", () => {
  test("mobile browsers show platform-specific Home Screen instructions", async ({ browser }) => {
    const iosContext = await browser.newContext({
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
      viewport: { width: 390, height: 844 },
    });
    const iosPage = await iosContext.newPage();
    await iosPage.goto("/login");
    await expect(iosPage.getByText(/Tap Share/i)).toBeVisible();
    await expect(iosPage.getByTitle("Share icon")).toBeVisible();
    await expect(iosPage.getByText(/tap the app icon on your Home Screen/i)).toBeVisible();
    await iosContext.close();

    const androidContext = await browser.newContext({
      userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
      viewport: { width: 412, height: 915 },
    });
    const androidPage = await androidContext.newPage();
    await androidPage.goto("/login");
    await expect(androidPage.getByText(/Tap Menu/i)).toBeVisible();
    await expect(androidPage.getByTitle("Menu icon")).toBeVisible();
    await androidContext.close();

    const installedIosContext = await browser.newContext({
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
      viewport: { width: 390, height: 844 },
    });
    await installedIosContext.addInitScript(() => {
      Object.defineProperty(navigator, "standalone", { value: true });
    });
    const installedIosPage = await installedIosContext.newPage();
    await installedIosPage.goto("/login");
    await expect(installedIosPage.getByText(/install this app on your Home Screen/i)).toHaveCount(0);
    await installedIosContext.close();
  });

  test("desktop browsers do not show Home Screen instructions", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByText(/install this app on your Home Screen/i)).toHaveCount(0);
  });

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
