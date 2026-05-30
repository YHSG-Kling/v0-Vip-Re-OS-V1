import { defineConfig, devices } from "@playwright/test"

/**
 * Headless E2E harness.
 *
 * Runs where the app environment (NEXT_PUBLIC_SUPABASE_URL / ANON / SERVICE keys)
 * and Playwright browsers are available — i.e. CI or a local dev machine. It does
 * NOT run inside the restricted build/agent container, which has no app Supabase
 * env and cannot download browsers.
 *
 * Set E2E_BASE_URL to test an already-running deployment (preview/staging);
 * otherwise Playwright boots `npm run dev` locally.
 *
 * Authenticated offer→transaction flows need a seeded test user + Supabase
 * session — see e2e/README.md. Public/unauthenticated pages smoke-test as-is.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: "npm run dev",
        url: "http://localhost:3000",
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
})
