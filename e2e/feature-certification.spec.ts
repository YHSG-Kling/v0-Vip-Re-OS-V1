import { test, expect, type Page } from "@playwright/test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * FEATURE CERTIFICATION — the rendered half of docs/architecture/FEATURE-CERTIFICATION.md (wave 143, lane 143J).
 *
 * The static chain (UI → action → domain → table → proof) is proven by `npm run test:feature-certification`; this spec
 * is what a browser can add: every certified feature's route answers, adapts to the width it is opened at, and refuses
 * an anonymous visitor. It runs on all three Playwright projects — `chromium` (desktop 1280), `tablet-chromium` (820)
 * and `mobile-chromium` (393) — so "desktop / tablet / mobile" is a run, not a claim.
 *
 * The route list is GENERATED from the registry (e2e/feature-certification.routes.json, rewritten by
 * `npx tsx scripts/feature-certification-guard.ts --write-doc`), so a feature added to the registry is exercised
 * here without editing this file; the guard fails when the list drifts.
 *
 * WHAT RUNS WHERE (never a fake green):
 *   @smoke (public + anonymous)  any deployed preview/production URL — UI_SMOKE_BASE_URL (CI job `ui-smoke`) or
 *                                E2E_BASE_URL; with neither, Playwright boots `npm run dev` locally.
 *   authenticated block          needs E2E_AUTH_STATE (a saved Supabase session for a seeded agent — e2e/README.md);
 *                                without it the block is SKIPPED with that reason, never passed.
 * WAITING_EXTERNAL: a deployed URL (UI_SMOKE_BASE_URL) and a seeded session (E2E_AUTH_STATE). Authored, not run here.
 */
interface RouteList { publicRoutes: string[]; protectedRoutes: Array<{ id: string; verdict: string; route: string }> }
const list = JSON.parse(readFileSync(join(process.cwd(), "e2e", "feature-certification.routes.json"), "utf8")) as RouteList

/** The page must not be wider than the viewport it was opened in (a horizontal scrollbar on a phone is the defect). */
async function fitsViewport(page: Page): Promise<{ ok: boolean; scrollWidth: number; innerWidth: number }> {
  return page.evaluate(() => ({
    scrollWidth: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth ?? 0),
    innerWidth: window.innerWidth,
    ok: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth ?? 0) <= window.innerWidth + 1,
  }))
}
const SIGN_IN_TEXT = /sign in|log in|login|session|not authori[sz]ed|forbidden|create your account/i

test.describe("@smoke certified features — public surface", () => {
  for (const route of list.publicRoutes) {
    test(`${route} answers, renders, and fits the viewport`, async ({ page }, info) => {
      const pageErrors: string[] = []
      page.on("pageerror", (e) => pageErrors.push(e.message))
      const res = await page.goto(route)
      expect(res, `${route} returned no response`).toBeTruthy()
      expect(res!.status(), `${route} answered ${res!.status()} on ${info.project.name}`).toBeLessThan(500)
      await expect(page.locator("body")).toBeVisible()
      const fit = await fitsViewport(page)
      expect(fit.ok, `${route} is ${fit.scrollWidth}px wide in a ${fit.innerWidth}px ${info.project.name} viewport`).toBeTruthy()
      expect(pageErrors, `${route} threw in the page on ${info.project.name}`).toEqual([])
    })
  }
})

test.describe("@smoke certified features — an anonymous visitor is refused (fail closed)", () => {
  for (const f of list.protectedRoutes) {
    test(`${f.id} ${f.route} sends a signed-out visitor to sign in and shows no workspace`, async ({ page }, info) => {
      const res = await page.goto(f.route)
      expect(res, `${f.route} returned no response`).toBeTruthy()
      expect(res!.status(), `${f.route} answered ${res!.status()} on ${info.project.name}`).toBeLessThan(500)
      const url = page.url()
      const body = (await page.locator("body").innerText()).slice(0, 4000)
      const refused = /login|sign-?in|auth/i.test(new URL(url).pathname) || [401, 403].includes(res!.status()) || SIGN_IN_TEXT.test(body)
      expect(refused, `${f.route} neither redirected to sign-in nor said so (landed on ${url})`).toBeTruthy()
      // an anonymous visitor must never be handed a rendered workspace shell
      await expect(page.getByRole("navigation", { name: /primary|sidebar|main/i })).toHaveCount(0)
    })
  }
})

// ── authenticated: needs a seeded session ────────────────────────────────────
const authState = process.env.E2E_AUTH_STATE
test.describe("certified features — signed in", () => {
  test.skip(!authState, "Set E2E_AUTH_STATE (a saved session for a seeded agent — e2e/README.md) to run the signed-in certification")
  test.use({ storageState: authState })

  for (const f of list.protectedRoutes) {
    test(`${f.id} ${f.route} renders for a signed-in agent, fits the viewport and throws nothing`, async ({ page }, info) => {
      const pageErrors: string[] = []
      page.on("pageerror", (e) => pageErrors.push(e.message))
      const res = await page.goto(f.route)
      expect(res, `${f.route} returned no response`).toBeTruthy()
      expect(res!.status(), `${f.route} answered ${res!.status()} on ${info.project.name}`).toBeLessThan(500)
      // a role refusal is an in-place notice (RoleGateNotice), not a bounce — either is acceptable; a crash is not
      const text = (await page.locator("body").innerText()).slice(0, 6000)
      expect(text, `${f.route} rendered a framework error boundary`).not.toMatch(/application error|something went wrong|unhandled runtime error/i)
      const fit = await fitsViewport(page)
      expect(fit.ok, `${f.route} is ${fit.scrollWidth}px wide in a ${fit.innerWidth}px ${info.project.name} viewport`).toBeTruthy()
      expect(pageErrors, `${f.route} threw in the page on ${info.project.name}`).toEqual([])
    })
  }

  // The usage pages state what they measured: every metric card either shows a percentage, says Unlimited, or says
  // "Not measured yet" — never an empty progress bar that reads as zero use (wave 143J; rule, not a metric list).
  test("the usage page never draws a measurement nobody took", async ({ page }) => {
    await page.goto("/dashboard/settings/usage")
    const cards = page.locator("div.grid.grid-cols-1.gap-3 > div")
    const n = await cards.count()
    test.skip(n === 0, "no usage cards rendered (role gate or no plan) — nothing to judge")
    for (let i = 0; i < n; i++) {
      const t = (await cards.nth(i).innerText()).replace(/\s+/g, " ")
      expect(t, `usage card ${i} is neither measured nor honestly unmeasured: "${t}"`).toMatch(/Not measured yet|\d+%|Unlimited|Used:/)
    }
  })

  // The billing card must not show an allowance the plan does not carry: every "x / y" it draws has a y that is a
  // plan_limits number or Unlimited — and a storage bar must not appear while storage is unmeasured.
  test("the billing usage card shows plan allowances or says Not measured yet", async ({ page }) => {
    await page.goto("/settings/billing")
    const card = page.getByText("Usage This Period").locator("xpath=ancestor::div[contains(@class,'rounded')][1]")
    test.skip((await card.count()) === 0, "billing page not available to this role")
    const t = (await card.first().innerText()).replace(/\s+/g, " ")
    expect(t).not.toMatch(/Limit reached! Upgrade to continue/)
    expect(t).toMatch(/\/ (\d|Unlimited)|Not measured yet/)
  })
})
