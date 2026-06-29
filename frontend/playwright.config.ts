import { defineConfig, devices } from "@playwright/test";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  globalTeardown: "./e2e/global-teardown.ts",
  fullyParallel: false, // tests share DB state; run sequentially
  reporter: "list",
  use: {
    baseURL: "http://localhost:5173",
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  // Assumes `pigeon pool` VS Code task (BE + FE) is already running.
  // reuseExistingServer means CI can start them; local dev reuses them.
  webServer: [
    {
      command: "conda run -n pigeon uvicorn backend.main:app --port 8000",
      url: "http://localhost:8000/docs",
      reuseExistingServer: true,
      cwd: path.resolve(__dirname, ".."),
      timeout: 30_000,
    },
    {
      command: "npm run dev",
      url: "http://localhost:5173",
      reuseExistingServer: true,
      cwd: __dirname,
      timeout: 30_000,
    },
  ],
});
