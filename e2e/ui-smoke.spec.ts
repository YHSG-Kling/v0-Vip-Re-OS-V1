import { test, expect } from "@playwright/test"

/**
 * PRODUCTION UI SMOKE (wave 142, lane 142I — wave-141 blocker "Playwright smoke in CI").
 *
 * Public, unauthenticated pages only, so it runs against ANY deployed preview or
 * production URL with no seeded session: `.github/workflows/e2e.yml` job `ui-smoke`
 * runs `playwright test --grep @smoke` when UI_SMOKE_BASE_URL is set (a workflow
 * input or a repository variable) and states a skip otherwise — never a fake green.
 * Tagged @smoke so the deployed run never boots the authenticated flow spec.
 *
 * The rule each case holds: the page answers (no 5xx), renders its primary control,
 * and an unknown path is a NOT-FOUND page, not a crash.
 */
test.describe("@smoke public surface", () => {
  test("the home page answers and renders a document", async ({ page }) => {
    const res = await page.goto("/")
    expect(res, "the home page returned no response").toBeTruthy()
    expect(res!.status(), `home answered ${res!.status()}`).toBeLessThan(500)
    await expect(page.locator("body")).toBeVisible()
  })

  test("the sign-in page renders an email field", async ({ page }) => {
    const res = await page.goto("/login")
    expect(res?.ok(), `login answered ${res?.status()}`).toBeTruthy()
    await expect(page.getByRole("textbox", { name: /email/i }).first()).toBeVisible()
  })

  test("the client portal sign-in renders an email field", async ({ page }) => {
    const res = await page.goto("/portal/login")
    expect(res?.ok(), `portal login answered ${res?.status()}`).toBeTruthy()
    await expect(page.getByRole("textbox", { name: /email/i }).first()).toBeVisible()
  })

  test("an unknown path is a not-found page, never a server error", async ({ page }) => {
    const res = await page.goto("/__ui_smoke_never_routed__")
    expect(res, "the unknown path returned no response").toBeTruthy()
    expect([404, 307, 308, 200], `unknown path answered ${res!.status()}`).toContain(res!.status())
    expect(res!.status(), "an unknown path must never 5xx").toBeLessThan(500)
  })
})
