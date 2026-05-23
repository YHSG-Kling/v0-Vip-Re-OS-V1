import { test, expect } from "@playwright/test"

/**
 * Smoke test: the client portal login page renders its email entry.
 * Unauthenticated + public, so it runs without a seeded session.
 */
test("portal login renders an email field", async ({ page }) => {
  const res = await page.goto("/portal/login")
  expect(res?.ok()).toBeTruthy()
  await expect(page.getByRole("textbox", { name: /email/i }).first()).toBeVisible()
})
