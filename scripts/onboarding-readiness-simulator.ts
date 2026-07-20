#!/usr/bin/env tsx
/**
 * scripts/onboarding-readiness-simulator.ts  (suggested npm name: test:onboarding-readiness)
 *   npx tsx scripts/onboarding-readiness-simulator.ts
 *
 * ONBOARDING CRITICAL-SETUP READINESS (owner round 42) — pure, no DB. Locks:
 *
 *  1. REGISTRY HONESTY — every table the facts loader queries exists in the
 *     schema snapshot (real tables only), and every fact field is actually
 *     assigned by the loader (a checker can never read a field nothing loads).
 *  2. PER-ROLE COVERAGE — every critical role has ≥1 item; the brokerage
 *     admin (tenant principal) covers ALL 8 categories
 *     (territory/routing/voice/connections/egress/seats/billing/profile).
 *  3. THE METER MATH — composeSetupReadiness: empty facts ⇒ 0%, full facts ⇒
 *     100%, partial ⇒ correct per-category % + why-lines for every gap;
 *     tier filtering (solo has no seat-invite item); dismissals never enter
 *     the math (the composer has no dismissal input at all).
 *  4. MOUNTS + GAP WIRING — the meter is mounted on the Command Center, the
 *     onboarding surface (as the FIRST step), and the agent dashboard; the
 *     round-42 markets settings surface exists and drives the EXISTING
 *     lead-scraping-config actions (which now stamp the caller's tenancy).
 *  5. NO ASPIRATIONAL ROWS — with empty facts every checker is false and with
 *     fully-configured facts every checker is true: each row is a live,
 *     DB-derived predicate — never a hardcoded pass or an unfillable wish.
 */
import { readFileSync, existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import {
  CRITICAL_SETUP_ITEMS,
  CRITICAL_ROLES,
  CRITICAL_CATEGORIES,
  composeSetupReadiness,
  emptyCriticalSetupFacts,
  normalizeCriticalRole,
  type CriticalSetupFacts,
  type CriticalRole,
} from "../lib/onboarding/critical-setup"
import { SCHEMA_SNAPSHOT } from "./schema-snapshot"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const src = (p: string) => readFileSync(join(root, p), "utf8")

// ─── Fully-configured facts (everything a real tenant could set, set) ────────
function fullFacts(tier: CriticalSetupFacts["tier"] = "brokerage"): CriticalSetupFacts {
  return {
    tier,
    activeMarkets: 2,
    activeAssignmentRules: 3,
    brandIdentityConfigured: true,
    brandVoiceConfigured: true,
    aiIdentityConfigured: true,
    autonomyPostureReviewed: true,
    emailProviderConfigured: true,
    smsProviderConfigured: true,
    zoomConnected: true,
    accountingConnected: true,
    socialConnected: true,
    workingSeats: 6,
    billingReady: true,
    trialEndsAt: null,
    brokerageProfileComplete: true,
    listingsCount: 4,
    agent: { licenseOnFile: true, voicePrefSet: true, calendarConnected: true, pwaInstalled: true, contactsCount: 25 },
    teamLead: { teamConfigured: true, splitsSet: true, teamBooksConnected: true },
    vendor: { profileComplete: true, payoutConnected: true, booksConnected: true },
  }
}

// ─── 1 · REGISTRY HONESTY ────────────────────────────────────────────────────
console.log("\n[1 · registry honesty — real tables, loaded facts]")
{
  const registrySrc = src("lib/onboarding/critical-setup.ts")
  const tables = Array.from(registrySrc.matchAll(/\.from\("([a-z0-9_]+)"\)/g)).map((m) => m[1])
  const uniqueTables = Array.from(new Set(tables))
  check(`facts loader queries real tables (${uniqueTables.length} distinct)`, uniqueTables.length >= 12)
  for (const t of uniqueTables) {
    check(`table "${t}" exists in the schema snapshot`, t in SCHEMA_SNAPSHOT)
  }

  // Every fact field the checkers can read is assigned by the loader.
  const topLevelFactKeys = Object.keys(emptyCriticalSetupFacts()).filter(
    (k) => !["agent", "teamLead", "vendor", "tier"].includes(k),
  )
  for (const key of topLevelFactKeys) {
    check(`loader assigns facts.${key}`, registrySrc.includes(`facts.${key} =`))
  }
  for (const slice of ["agent", "teamLead", "vendor"]) {
    check(`loader assigns the ${slice} slice`, registrySrc.includes(`facts.${slice} = {`))
  }
  check("loader resolves the tenant tier from brokerages.plan_tier", registrySrc.includes("facts.tier = pt"))

  // The KEEP-ONE decision is documented in the module itself.
  check("keep-one positioning documented (onboarding_steps studied & not reused)",
    registrySrc.includes("onboarding_steps machinery was studied and NOT reused"))
}

// ─── 2 · PER-ROLE COVERAGE ───────────────────────────────────────────────────
console.log("\n[2 · per-role coverage]")
{
  for (const role of CRITICAL_ROLES) {
    const count = CRITICAL_SETUP_ITEMS.filter((i) => i.role === role).length
    check(`role "${role}" has ≥1 critical item (${count})`, count >= 1)
  }
  const adminCategories = new Set(
    CRITICAL_SETUP_ITEMS.filter((i) => i.role === "brokerage_admin").map((i) => i.category),
  )
  for (const cat of CRITICAL_CATEGORIES) {
    check(`brokerage_admin covers category "${cat}"`, adminCategories.has(cat))
  }
  const keys = CRITICAL_SETUP_ITEMS.map((i) => i.key)
  check("item keys are unique", new Set(keys).size === keys.length)
  for (const item of CRITICAL_SETUP_ITEMS) {
    check(`${item.key}: honest why-line + real settingHref`,
      item.why.trim().length >= 30 && item.settingHref.startsWith("/"))
  }
  // Role normalization reaches every registry role from real user_type strings.
  check("normalize: admin/broker → brokerage_admin",
    normalizeCriticalRole("admin") === "brokerage_admin" && normalizeCriticalRole("broker") === "brokerage_admin")
  check("normalize: agent/isa → agent; team_lead; tc; compliance_officer → compliance; vendor",
    normalizeCriticalRole("agent") === "agent" && normalizeCriticalRole("isa") === "agent" &&
    normalizeCriticalRole("team_lead") === "team_lead" && normalizeCriticalRole("tc") === "tc" &&
    normalizeCriticalRole("compliance_officer") === "compliance" && normalizeCriticalRole("vendor") === "vendor")
  check("normalize: contacts / platform staff have no critical-setup role",
    normalizeCriticalRole("contact") === null && normalizeCriticalRole("superadmin") === null)
}

// ─── 3 · THE METER MATH ──────────────────────────────────────────────────────
console.log("\n[3 · meter math]")
{
  const empty = composeSetupReadiness({ role: "brokerage_admin", facts: emptyCriticalSetupFacts("brokerage") })
  check("empty tenant ⇒ 0% overall", empty.overallPct === 0 && empty.configuredItems === 0)
  check("empty tenant ⇒ nextGap is the first registry item", empty.nextGap?.key === "admin_markets")
  check("every category gap carries the why-line + settingHref",
    empty.categories.every((c) => c.gaps.every((g) => g.why.length > 0 && g.settingHref.startsWith("/"))))
  check("empty tenant ⇒ every category at 0%", empty.categories.every((c) => c.pct === 0 && c.done === 0))

  const full = composeSetupReadiness({ role: "brokerage_admin", facts: fullFacts("brokerage") })
  check("fully-configured tenant ⇒ 100% overall, no gaps",
    full.overallPct === 100 && full.nextGap === null && full.categories.every((c) => c.gaps.length === 0))

  // Partial: exactly the territory item configured.
  const partial = emptyCriticalSetupFacts("brokerage"); partial.activeMarkets = 1
  const p = composeSetupReadiness({ role: "brokerage_admin", facts: partial })
  const territory = p.categories.find((c) => c.category === "territory")
  check("one market ⇒ territory category 100%, other categories still gapped",
    territory?.pct === 100 && p.overallPct > 0 && p.overallPct < 100)
  check("overall % is item-derived (round(done/total*100))",
    p.overallPct === Math.round((p.configuredItems / p.totalItems) * 100))

  // Tier filtering — a solo tenant has no seat-invite obligation.
  const solo = composeSetupReadiness({ role: "brokerage_admin", facts: emptyCriticalSetupFacts("solo_agent") })
  check("solo_agent tier excludes the seat-invite item",
    !solo.items.some((i) => i.key === "admin_invite_seats"))
  const org = composeSetupReadiness({ role: "brokerage_admin", facts: emptyCriticalSetupFacts("team") })
  check("team tier includes the seat-invite item", org.items.some((i) => i.key === "admin_invite_seats"))

  // Dismissals can never bend the math: the composer takes no dismissal input.
  const composerSrc = src("lib/onboarding/critical-setup.ts")
  check("composer has no dismissal input (dismissals are UI-only, math stays honest)",
    !/dismiss/i.test(composerSrc.slice(composerSrc.indexOf("export function composeSetupReadiness"))))
  const meterSrc = src("app/components/onboarding/critical-setup-meter.tsx")
  check("meter dismiss is localStorage-only and never recomputes the %",
    meterSrc.includes("localStorage") && !meterSrc.includes("overallPct - ") && meterSrc.includes("NEVER recomputed"))
}

// ─── 4 · MOUNTS + GAP WIRING ─────────────────────────────────────────────────
console.log("\n[4 · mounts + gap wiring]")
{
  const commandCenter = src("app/dashboard/admin/command-center/page.tsx")
  check("Command Center mounts the meter (Finish your setup)",
    commandCenter.includes("CriticalSetupMeter") && commandCenter.includes('heading="Finish your setup"'))
  check("Command Center composes the brokerage_admin registry",
    commandCenter.includes('composeSetupReadiness({ role: "brokerage_admin"'))

  const onboardingPage = src("app/dashboard/onboarding/page.tsx")
  check("onboarding surface mounts the meter as the FIRST step",
    onboardingPage.includes("CriticalSetupMeter") && onboardingPage.includes("Step 1 — critical setup"))
  check("onboarding surface is role-aware (normalizeCriticalRole)",
    onboardingPage.includes("normalizeCriticalRole"))

  const agentDash = src("app/dashboard/agent/page.tsx")
  check("agent dashboard mounts the compact per-agent meter",
    agentDash.includes("CriticalSetupMeterClient") && agentDash.includes('variant="compact"'))

  check("session-gated server action exists (app/actions/critical-setup.ts)",
    src("app/actions/critical-setup.ts").includes("loadCriticalSetupFacts") &&
    src("app/actions/critical-setup.ts").includes('"use server"'))

  // Round-42 gap wire: markets had actions but NO settings surface.
  check("markets settings surface exists (/dashboard/admin/markets)",
    existsSync(join(root, "app/dashboard/admin/markets/page.tsx")))
  const marketsClient = src("app/dashboard/admin/markets/markets-client.tsx")
  check("markets surface drives the EXISTING lead-scraping-config actions (keep-one)",
    marketsClient.includes("createScrapingMarket") && marketsClient.includes("updateScrapingMarket"))
  const marketsPage = src("app/dashboard/admin/markets/page.tsx")
  check("markets surface prefills the /pricing territory-zip carry (suggestion only)",
    marketsPage.includes("loadCarriedTerritoryZip"))
  check("createScrapingMarket stamps the caller's brokerage_id (rows visible to the scrape resolver)",
    src("app/actions/lead-scraping-config.ts").includes("brokerage_id: brokerageId"))
  check("markets surface is reachable from the admin nav",
    src("app/config/navigation-config.ts").includes("/dashboard/admin/markets"))

  // Every settingHref lands on a real page.
  for (const item of CRITICAL_SETUP_ITEMS) {
    const rel = `app${item.settingHref}/page.tsx`
    check(`settingHref ${item.settingHref} → ${rel} exists`, existsSync(join(root, rel)))
  }
}

// ─── 5 · NO-ASPIRATIONAL-ROWS LOCK ───────────────────────────────────────────
console.log("\n[5 · no aspirational rows — every checker flips on real facts]")
{
  const empty = emptyCriticalSetupFacts("multi_location")
  const full = fullFacts("multi_location")
  for (const role of CRITICAL_ROLES) {
    const e = composeSetupReadiness({ role: role as CriticalRole, facts: empty })
    const f = composeSetupReadiness({ role: role as CriticalRole, facts: full })
    check(`${role}: empty facts ⇒ 0 configured / full facts ⇒ all configured (${f.totalItems} items)`,
      e.configuredItems === 0 && f.configuredItems === f.totalItems && f.totalItems === e.totalItems && f.totalItems >= 1)
  }
}

// ─── Result ──────────────────────────────────────────────────────────────────
console.log(`\n${"─".repeat(60)}`)
console.log(`onboarding-readiness simulator: ${passed} passed, ${failed} failed`)
if (failed > 0) {
  console.log("FAILURES:")
  for (const f of failures) console.log(`  • ${f}`)
  process.exit(1)
}
console.log("ALL CHECKS PASSED")
