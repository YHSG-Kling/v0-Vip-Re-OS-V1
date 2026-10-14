/**
 * scripts/canaries/mobile.ts — MOBILE canary (wave 141, lane 141J):
 *   critical workflows at supported widths — static census (+ Playwright smoke where runnable)
 * Owner (wave 141): "Mobile ADAPTS (table → cards, multi-column → stepper/drawer, side panels → sheets,
 * touch-safe), never merely shrinks … no horizontal overflow at 390px." The installable-PWA posture, the
 * device-width viewport and the role bottom nav are test:mobile-readiness's (not re-proved). This canary
 * measures the OVERFLOW-RISK idioms on the CRITICAL-PATH pages (signup, onboarding, users/invites, contacts,
 * leads, listings, offers, transactions, CDA, settings, billing, provider setup, lead magnets, website) on
 * STRIPPED source: a <table> with no scroll wrapper or card alternative in the file, a fixed width ≥ 480px
 * outside a scroll wrapper, a hard grid of ≥ 3 columns with no responsive prefix anywhere in the file. The
 * count is a RATCHET (shrink-only from the reading at 01a71c3c2) and a positive control proves the finder
 * bites. Playwright is not installed in this environment (no node_modules/.bin/playwright, no Chromium
 * cache) — the smoke step is SKIPPED by name, never faked; lane 141I's test:ui-wiring-census owns the
 * dead-surface census and the runnable smoke.
 */
import { existsSync } from "node:fs"
import { join } from "node:path"
import { canary } from "./_harness"
import { ROOT, listFiles, strippedRepo } from "./_registry"

/** The pages a subscriber / agent cannot do business without (file paths at HEAD; a missing path is a finding). */
export const CRITICAL_PAGES = [
  "app/signup/page.tsx", "app/get-started/page.tsx", "app/dashboard/onboarding/page.tsx",
  "app/dashboard/admin/users/page.tsx", "app/settings/users/page.tsx",
  "app/crm/contacts/page.tsx", "app/crm/contacts/new/page.tsx", "app/leads/page.tsx",
  "app/listings/page.tsx", "app/listings/new/page.tsx", "app/dashboard/listings/page.tsx",
  "app/offers/page.tsx", "app/dashboard/offers/page.tsx",
  "app/transactions/page.tsx", "app/dashboard/transactions/page.tsx", "app/dashboard/transactions/[id]/cda/page.tsx",
  "app/settings/page.tsx", "app/dashboard/settings/page.tsx", "app/settings/billing/page.tsx", "app/dashboard/admin/billing/page.tsx",
  "app/settings/connections/page.tsx", "app/settings/integrations/page.tsx", "app/dashboard/settings/integrations/page.tsx",
  "app/dashboard/marketing/lead-magnets/page.tsx", "app/settings/branding/page.tsx", "app/dashboard/admin/phone-settings/page.tsx",
  "app/dashboard/agent/business-cards/page.tsx",
]

export interface OverflowFinding { file: string; line: number; kind: "bare-table" | "fixed-width" | "hard-grid" }
const WRAPPER = /overflow-x-auto|overflow-auto|overflow-x-scroll|ScrollArea|hidden\s+(sm|md|lg):|(sm|md|lg):hidden/
/** PURE: overflow-risk idioms in ONE stripped module. */
export function overflowFindings(file: string, stripped: string): OverflowFinding[] {
  const out: OverflowFinding[] = []
  const wrapped = WRAPPER.test(stripped)
  const responsiveGrid = /\b(sm|md|lg|xl):grid-cols-/.test(stripped)
  stripped.split("\n").forEach((l, i) => {
    if (/<(table|Table)\b/.test(l) && !wrapped) out.push({ file, line: i + 1, kind: "bare-table" })
    for (const m of l.matchAll(/\b(?:min-)?w-\[(\d{3,4})px\]/g)) if (Number(m[1]) >= 480 && !wrapped) out.push({ file, line: i + 1, kind: "fixed-width" })
    if (/\bgrid-cols-([3-9]|1[0-2])\b/.test(l) && !/\b(sm|md|lg|xl):grid-cols-/.test(l) && !responsiveGrid) out.push({ file, line: i + 1, kind: "hard-grid" })
  })
  return out
}
/** The page plus the client components beside it (one directory) — the module set a route renders. */
function pageModules(page: string): string[] {
  const dir = page.replace(/\/page\.tsx$/, "")
  return listFiles(dir, (f) => /\.tsx$/.test(f) && f.split("/").length === dir.split("/").length + 1)
}

/** RATCHET — overflow-risk findings across the critical pages, read at 01a71c3c2 (2026-10-14): 9 = 8 bare
 *  tables (users-management-client, cda-workflow-client ×2, invoice-history-table, revenue-summary-card,
 *  integrations-client ×2, agent/business-cards) + 1 hard grid (revenue-summary-card). Shrink-only: lane 141I
 *  (mobile adaptation) lowers it; a reading above it is a NEW mobile regression. */
export const MOBILE_OVERFLOW_RATCHET = 9

export async function run() {
  const c = canary("Mobile: critical workflows at supported widths (static overflow census + Playwright smoke where runnable)")
  const missing = CRITICAL_PAGES.filter((p) => !existsSync(join(ROOT, p)))
  c.step(`critical pages exist at HEAD (${CRITICAL_PAGES.length - missing.length}/${CRITICAL_PAGES.length})`, missing.length === 0, missing.join(",") || "all present")
  const modules = [...new Set(CRITICAL_PAGES.filter((p) => existsSync(join(ROOT, p))).flatMap(pageModules))]
  const findings = modules.flatMap((f) => overflowFindings(f, strippedRepo(f) ?? ""))
  const byKind = (k: OverflowFinding["kind"]) => findings.filter((x) => x.kind === k).length
  console.log(`    census: ${modules.length} modules on ${CRITICAL_PAGES.length} critical routes — ${findings.length} overflow-risk findings (bare-table ${byKind("bare-table")}, fixed-width ${byKind("fixed-width")}, hard-grid ${byKind("hard-grid")})`)
  for (const f of findings) console.log(`      ${f.file}:${f.line} ${f.kind}`)
  c.step(`overflow ratchet: ${findings.length} ≤ ${MOBILE_OVERFLOW_RATCHET} (shrink-only; lane 141I lowers it)`, findings.length <= MOBILE_OVERFLOW_RATCHET, findings.map((f) => `${f.file}:${f.line}`).join(", ").slice(0, 300))
  c.step("POSITIVE CONTROL: a bare <table> with no wrapper, a w-[720px] and a hard grid-cols-4 are caught; the same table inside overflow-x-auto, a w-[320px] and md:grid-cols-4 are not",
    overflowFindings("spec.tsx", `<div><table><tr/></table></div>\n<div className="w-[720px]"/>\n<div className="grid grid-cols-4"/>`).length === 3 &&
    overflowFindings("spec.tsx", `<div className="overflow-x-auto"><table><tr/></table></div>\n<div className="w-[320px]"/>\n<div className="grid grid-cols-2 md:grid-cols-4"/>`).length === 0)
  const viewport = strippedRepo("app/layout.tsx") ?? ""
  c.step("supported widths: the root viewport is device-width with viewport-fit cover (test:mobile-readiness holds the PWA + bottom-nav posture)", /device-width/.test(viewport) && /viewportFit:\s*['"]cover['"]/.test(viewport), "")
  // WHERE RUNNABLE: a Playwright runner (node resolution walks up to the checkout's node_modules) + a browser
  // under PLAYWRIGHT_BROWSERS_PATH + an app to drive (E2E_BASE_URL, or the config's webServer — which needs the
  // Supabase env the e2e workflow injects from secrets). The chained canary never starts a dev server: the
  // smoke is SKIPPED by name with the half that is missing, never faked.
  const runnerAt = ["node_modules/.bin/playwright", "../node_modules/.bin/playwright", "../../node_modules/.bin/playwright", "../../../node_modules/.bin/playwright"].map((p) => join(ROOT, p)).find((p) => existsSync(p)) ?? null
  const browsersAt = process.env.PLAYWRIGHT_BROWSERS_PATH && existsSync(process.env.PLAYWRIGHT_BROWSERS_PATH) ? process.env.PLAYWRIGHT_BROWSERS_PATH : null
  const appAt = process.env.E2E_BASE_URL || (process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY ? "webServer (supabase env present)" : null)
  const config = strippedRepo("playwright.config.ts") ?? ""
  c.step(`Playwright smoke: ${runnerAt && browsersAt && appAt ? "RUNNABLE here — driven by lane 141I's test:ui-wiring-census / the e2e workflow, not by the chained canary" : `SKIPPED by name — ${[runnerAt ? null : "no runner", browsersAt ? null : "no browser (PLAYWRIGHT_BROWSERS_PATH)", appAt ? null : "no app to drive (E2E_BASE_URL / Supabase env)"].filter(Boolean).join(", ")}`}`, existsSync(join(ROOT, ".github/workflows/e2e.yml")) && config.length > 0, `runner=${runnerAt ? "yes" : "no"} browser=${browsersAt ?? "no"} app=${appAt ?? "no"}`)
  const projects = [...config.matchAll(/name:\s*["']([^"']+)["']/g)].map((m) => m[1])
  const mobileProject = /devices\[["'](iPhone|Pixel|Galaxy|iPad)[^"']*["']\]|viewport:\s*\{\s*width:\s*(390|412|430|820)/.test(config)
  console.log(`    finding (lane 141I): playwright.config.ts projects = [${projects.join(", ")}]; mobile/tablet viewport project: ${mobileProject ? "yes" : "NO — the 820 / 390 smoke has no project at HEAD"}`)
  c.blind(`Static census only: a table that overflows because of long content, or a sheet that renders off-screen, is not an idiom this finder sees — the Playwright smoke at 390px is the real proof (lane 141I); playwright.config.ts carries ${mobileProject ? "a" : "NO"} mobile viewport project at HEAD.`)
  c.blind(`BLIND SPOT, published: a scroll wrapper ANYWHERE in the file clears every table in it (a file-level heuristic); ${modules.length} modules scanned, page + same-directory client components only.`)
  return c.report([], 0)
}
