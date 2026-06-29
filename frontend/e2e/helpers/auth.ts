import type { Page } from "@playwright/test";

const TOKEN_KEY = "pp_access_token";

/** Inject a pre-minted JWT into localStorage so the app boots as authenticated. */
export async function setAuthToken(page: Page, token: string) {
  await page.addInitScript(
    ({ key, t }: { key: string; t: string }) => {
      localStorage.setItem(key, t);
    },
    { key: TOKEN_KEY, t: token },
  );
}

/** Remove the token so the app boots unauthenticated. */
export async function clearAuthToken(page: Page) {
  await page.addInitScript((key: string) => {
    localStorage.removeItem(key);
  }, TOKEN_KEY);
}
