import { defineConfig, devices } from "@playwright/test"

/**
 * Headless E2E harness.
 *
 * Runs where the app environment (NEXT_PUBLIC_SUPABASE_URL / ANON / SERVICE keys)
 * and Playwright browsers are available — i.e. CI or a local dev machine. It does
 * NOT run inside the restricted build/agent container, which has no app Supabase
 * env and cannot download browsers.
 *
 * Set UI_SMOKE_BASE_URL (the production UI smoke — `.github/workflows/e2e.yml`
 * job `ui-smoke`, wave 142 lane 142I) or E2E_BASE_URL to test an already-running
 * deployment (preview / staging); otherwise Playwright boots `npm run dev` locally.
 *
 * Authenticated offer→transaction flows need a seeded test user + Supabase
 * session — see e2e/README.md. Public/unauthenticated pages smoke-test as-is.
 */
const deployedBaseUrl = process.env.UI_SMOKE_BASE_URL?.trim() || process.env.E2E_BASE_URL?.trim() || null

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: deployedBaseUrl ?? "http://localhost:3000",
    trace: "on-first-retry",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    // The tablet width wave 142 named as missing ("no 820 / 390 viewport project exists"; only the 393 px phone was
    // added). Chromium at an iPad-Air-class 820 × 1180 touch viewport — the width the static mobile census reads as the
    // md breakpoint boundary — so desktop (1280) / tablet (820) / phone (393) are all real Playwright projects (wave 143J).
    { name: "tablet-chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 820, height: 1180 }, hasTouch: true, isMobile: false } },
    // The phone-width project the readiness matrix named as missing (lane 141I finding:
    // "no 820 / 390 viewport project exists for the mobile smoke") — the same specs at 393 px.
    { name: "mobile-chromium", use: { ...devices["Pixel 5"] } },
  ],
  webServer: deployedBaseUrl
    ? undefined
    : {
        command: "npm run dev",
        url: "http://localhost:3000",
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
})
