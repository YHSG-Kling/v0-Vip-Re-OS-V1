#!/usr/bin/env tsx
/**
 * scripts/plan-catalog-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * SUPERADMIN OWNS THE PLAN CATALOG. subscription_tiers is now the SINGLE source of
 * truth for price, blurb, marketing bullets, highlight, limits, and the Stripe
 * price link — staff create/update/remove tiers (or sync a price from Stripe), and
 * NOTHING in signup/billing hardcodes tier copy or price. A tier with active
 * subscriptions is soft-removed (is_active=false) so no tenant is orphaned.
 *
 * Layer 1 (pure): validatePlanTierInput — canonical-tier enforcement, required
 *   name/display, non-negative prices, annual defaults to monthly×12, bullets
 *   trimmed/capped, normalized output.
 * Layer 2 (source): the CRUD action is superadmin-gated (create/update/remove/sync);
 *   remove is SOFT when subscriptions reference the tier; the signup page loads
 *   description/marketing_bullets/is_featured from the DB and the form has NO
 *   hardcoded blurb/features/highlight.
 * Layer 3 (live, gated): an UPDATE round-trip on a real tier proves the new columns
 *   (description / marketing_bullets / is_featured) persist + read back; the original
 *   values are RESTORED (no lasting change).
 *
 * Run: npx tsx scripts/plan-catalog-simulator.ts   (npm run test:plan-catalog)
 */
import { validatePlanTierInput, CANONICAL_TIERS } from "../lib/billing/plan-catalog"
import { readFileSync } from "node:fs"
import { join } from "node:path"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
function report() {
  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" ✅ Plan catalog verified — superadmin CRUD, DB-driven copy+price, safe soft-remove")
  console.log(" PLAN_CATALOG_PASS")
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Plan-catalog (superadmin tier CRUD) simulator")
  console.log("══════════════════════════════════════════════════")

  console.log("\n[Layer 1 · pure validator]")
  const good = validatePlanTierInput({ tierName: "team", displayName: "Team", monthlyPriceCents: 29900, marketingBullets: [" A ", "", "B"], description: " Lead + team " })
  check("valid tier normalizes (annual defaults monthly×12, bullets trimmed/deduped-empty, description trimmed)",
    good.ok && good.value.annualPriceCents === 29900 * 12 && good.value.marketingBullets.length === 2 && good.value.description === "Lead + team")
  check("setup fee defaults to 0 + isActive defaults true",
    good.ok && good.value.setupFeeCents === 0 && good.value.isActive === true)
  check("empty tier_name → error", !validatePlanTierInput({ tierName: "", displayName: "X", monthlyPriceCents: 1 }).ok)
  check("non-canonical tier_name → error (keeps plan_tier/routing coherent)",
    !validatePlanTierInput({ tierName: "enterprise", displayName: "X", monthlyPriceCents: 1 }).ok)
  check("empty display_name → error", !validatePlanTierInput({ tierName: "team", displayName: "", monthlyPriceCents: 1 }).ok)
  check("negative price → error", !validatePlanTierInput({ tierName: "team", displayName: "X", monthlyPriceCents: -5 }).ok)
  check("CANONICAL_TIERS is the 4 plan keys", CANONICAL_TIERS.length === 4 && CANONICAL_TIERS.includes("solo_agent"))

  console.log("\n[Layer 2 · CRUD wiring + DB-driven signup]")
  const actionSrc = readFileSync(join(process.cwd(), "app/actions/superadmin/plan-catalog.ts"), "utf8")
  check("catalog actions are superadmin-gated (create/update/remove/sync)",
    /requireSuperadmin/.test(actionSrc) && /upsertPlanTierAction/.test(actionSrc) && /removePlanTierAction/.test(actionSrc) && /syncPlanTierFromStripeAction/.test(actionSrc))
  check("remove is SOFT when subscriptions reference the tier (no orphaned tenant)",
    /from\("subscriptions"\)[\s\S]*?eq\("tier_id"/.test(actionSrc) && /is_active: false/.test(actionSrc))
  check("Stripe sync pulls unit_amount from the tier's stripe_price_id",
    /stripe\.prices\.retrieve/.test(actionSrc) && /unit_amount/.test(actionSrc))
  const pageSrc = readFileSync(join(process.cwd(), "app/get-started/page.tsx"), "utf8")
  // Same refactor as the price assertion in billing-access-simulator: the tier
  // columns are selected in lib/platform/public-tiers.ts now, not inline here.
  const tiersSrc = readFileSync(join(process.cwd(), "lib/platform/public-tiers.ts"), "utf8")
  check("signup page loads blurb/bullets/highlight from subscription_tiers",
    /loadPublicTiers/.test(pageSrc) && /description/.test(tiersSrc)
    && /marketing_bullets/.test(tiersSrc) && /is_featured/.test(tiersSrc))
  const formSrc = readFileSync(join(process.cwd(), "app/get-started/trial-funnel-form.tsx"), "utf8")
  check("signup form is DB-driven — NO hardcoded blurb/features/highlight arrays",
    /tiers\.map/.test(formSrc) && !/blurb:\s*"/.test(formSrc) && !/features:\s*\[/.test(formSrc) && !/highlight:\s*(true|false)/.test(formSrc))

  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY &&
    !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("\n[Layer 3 · live column round-trip]")
    console.log("  ⏭  Skipped — SUPABASE creds not set (pure + source layers ran).")
    report()
    return
  }

  const { createServiceClient } = await import("../lib/supabase/service")
  const svc = createServiceClient()

  console.log("\n[Layer 3 · live column round-trip]")
  const { data: tier } = await svc.from("subscription_tiers")
    .select("id, description, marketing_bullets, is_featured").limit(1).maybeSingle()
  if (!tier) { check("a tier exists to round-trip", false); report(); return }
  const id = (tier as any).id
  const orig = { description: (tier as any).description, marketing_bullets: (tier as any).marketing_bullets, is_featured: (tier as any).is_featured }
  const TAG = `PlanCat${Date.now()}`
  try {
    await svc.from("subscription_tiers").update({ description: TAG, marketing_bullets: [`${TAG}-a`, `${TAG}-b`], is_featured: !orig.is_featured }).eq("id", id)
    const { data: after } = await svc.from("subscription_tiers").select("description, marketing_bullets, is_featured").eq("id", id).single()
    check("new columns persist + read back (description / marketing_bullets / is_featured)",
      (after as any).description === TAG && Array.isArray((after as any).marketing_bullets) && (after as any).marketing_bullets[0] === `${TAG}-a` && (after as any).is_featured === !orig.is_featured,
      JSON.stringify(after))
  } finally {
    await svc.from("subscription_tiers").update(orig).eq("id", id)
    const { data: restored } = await svc.from("subscription_tiers").select("description, is_featured").eq("id", id).single()
    check("original tier values RESTORED (no lasting change)",
      (restored as any).description === orig.description && (restored as any).is_featured === orig.is_featured)
  }

  report()
}
main().catch((e) => { console.error(e); process.exit(1) })
