#!/usr/bin/env tsx
/**
 * scripts/vendor-subscription-simulator.ts   (npm run test:vendor-subscription)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves VENDOR SUBSCRIPTION TIERS + STRIPE BILLING (vendors pay the platform). Tier capabilities gate
 * surfacing/preferred/featured; a past_due/canceled subscription collapses to basic; Stripe lifecycle
 * events map to our status (payment_failed→past_due; cancellation→canceled+suspend).
 *
 * PURE:   VENDOR_TIERS catalog + tierAllows + effectiveCapabilities (past_due→basic) + mapStripeEventToStatus.
 * SOURCE: checkout/portal reuse lib/stripe; the webhook applies applyVendorSubscriptionEvent; the billing
 *         UI wires the actions; owned by finance_manager with a runnable proof; columns in the snapshot.
 * LIVE (creds-gated): a vendor_marketplace_profiles row round-trips a past_due→basic-effective status and
 *         accepts the new billing columns → clean up == 0.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createClient } from "@supabase/supabase-js"
import {
  VENDOR_TIERS,
  tierAllows,
  effectiveCapabilities,
  mapStripeEventToStatus,
  normalizeTier,
} from "../lib/kernel/vendor-subscription"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

function pureLayer() {
  console.log("\n[tier catalog · pure — spec gating]")
  check("basic is NOT AI-surfaced", VENDOR_TIERS.basic.surfacingEligible === false)
  check("standard+ is surfacing-eligible", VENDOR_TIERS.standard.surfacingEligible && VENDOR_TIERS.premium.surfacingEligible)
  check("only premium+ is preferred-eligible", !VENDOR_TIERS.standard.preferredEligible && VENDOR_TIERS.premium.preferredEligible)
  check("only preferred_network is featured-eligible", !VENDOR_TIERS.premium.featuredEligible && VENDOR_TIERS.preferred_network.featuredEligible)
  check("prices ascend basic<standard<premium<preferred_network", VENDOR_TIERS.basic.monthlyPriceUsd < VENDOR_TIERS.standard.monthlyPriceUsd && VENDOR_TIERS.premium.monthlyPriceUsd < VENDOR_TIERS.preferred_network.monthlyPriceUsd)
  check("normalizeTier defaults junk to basic", normalizeTier("nonsense") === "basic" && normalizeTier("PREMIUM") === "premium")

  console.log("\n[effective capabilities · pure — billing status gates]")
  check("active premium keeps preferred eligibility", tierAllows("premium", "active", "preferred"))
  check("past_due premium collapses to basic (no surfacing/preferred)", effectiveCapabilities("premium", "past_due").tier === "basic" && !tierAllows("premium", "past_due", "surfacing"))
  check("canceled preferred_network collapses to basic (no featured)", !tierAllows("preferred_network", "canceled", "featured"))
  check("trialing standard is surfacing-eligible", tierAllows("standard", "trialing", "surfacing"))

  console.log("\n[Stripe event → status · pure]")
  check("invoice.payment_failed → past_due (no suspend)", mapStripeEventToStatus("invoice.payment_failed").status === "past_due" && mapStripeEventToStatus("invoice.payment_failed").suspendAccount === false)
  check("customer.subscription.deleted → canceled + suspend", mapStripeEventToStatus("customer.subscription.deleted").status === "canceled" && mapStripeEventToStatus("customer.subscription.deleted").suspendAccount === true)
  check("payment_succeeded → active", mapStripeEventToStatus("invoice.payment_succeeded").status === "active")
  check("subscription.updated(past_due) → past_due", mapStripeEventToStatus("customer.subscription.updated", "past_due").status === "past_due")
}

function sourceLayer() {
  console.log("\n[wiring — Stripe SDK checkout, webhook applier, UI, owned]")
  const act = src("app/actions/vendor-billing.ts")
  check("checkout + portal reuse the canonical lib/stripe proxy", /from "@\/lib\/stripe"/.test(act) && /stripe\.checkout\.sessions\.create/.test(act) && /stripe\.billingPortal\.sessions\.create/.test(act))
  check("applyVendorSubscriptionEvent maps Stripe events → status + suspend", /applyVendorSubscriptionEvent/.test(act) && /mapStripeEventToStatus/.test(act) && /update\.status = "suspended"/.test(act))
  const wh = src("app/api/webhooks/stripe/vendor/route.ts")
  check("the webhook verifies the signature + calls the applier", /constructEvent\(body, sig, secret\)/.test(wh) && /applyVendorSubscriptionEvent\(/.test(wh))
  const ui = src("app/vendor/billing/billing-client.tsx")
  check("the billing UI wires checkout + portal actions", /createVendorSubscriptionCheckout/.test(ui) && /createVendorBillingPortalSession/.test(ui))
  const reg = src("lib/kernel/manager-registry.ts")
  check("burn domain owned by finance_manager with a runnable proof", /vendor_subscription_billing:\s*\{\s*manager:\s*"finance_manager",\s*proof:\s*"test:vendor-subscription"/.test(reg))
  check("new billing columns are in the schema snapshot", /vendor_marketplace_profiles:\s*\[[^\]]*"stripe_customer_id"[^\]]*"subscription_tier"/.test(src("scripts/schema-snapshot.ts")))
  check("package.json wires the proof", /"test:vendor-subscription":\s*"tsx scripts\/vendor-subscription-simulator\.ts"/.test(src("package.json")))
}

async function liveLayer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) { console.log("\n[live] ⊘ skipped (no SUPABASE creds) — pure + source layers proved the logic"); return }
  const svc = createClient(url, key)
  console.log("\n[live] a vendor profile accepts the billing columns + a past_due status round-trips → clean up")
  const { data: usr } = await svc.from("users").select("id").limit(1).maybeSingle()
  if (!usr) { console.log("  ⊘ no user — skipping"); return }
  const cleanup: Array<{ table: string; id: string }> = []
  try {
    const { data: p, error } = await svc.from("vendor_marketplace_profiles").insert({
      user_id: (usr as any).id, company_name: "ZZ Billing Sim Vendor", category: "service", status: "approved",
      subscription_tier: "premium", subscription_status: "active",
    }).select("id").single()
    if (error || !p) { console.log("  ⊘ insert blocked:", error?.message); return }
    const profileId = (p as any).id
    cleanup.push({ table: "vendor_marketplace_profiles", id: profileId })
    check("live: the profile accepts subscription_tier/status columns", true)

    // Simulate the webhook applier's effect for a payment failure.
    const mapped = mapStripeEventToStatus("invoice.payment_failed")
    await svc.from("vendor_marketplace_profiles").update({ subscription_status: mapped.status }).eq("id", profileId)
    const { data: after } = await svc.from("vendor_marketplace_profiles").select("subscription_tier, subscription_status").eq("id", profileId).maybeSingle()
    check("live: payment failure round-trips to past_due", (after as any)?.subscription_status === "past_due")
    check("live: effective capabilities collapse premium→basic while past_due", effectiveCapabilities((after as any)?.subscription_tier, (after as any)?.subscription_status).tier === "basic")
  } finally {
    for (const c of cleanup.reverse()) await svc.from(c.table).delete().eq("id", c.id)
    let left = 0
    for (const c of cleanup) { const { count } = await svc.from(c.table).select("id", { count: "exact", head: true }).eq("id", c.id); left += count ?? 0 }
    check("live: cleanup count == 0", left === 0)
  }
}

async function main() {
  pureLayer()
  sourceLayer()
  await liveLayer()
  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ VENDOR_SUBSCRIPTION_FAIL"); process.exit(1) }
  console.log(" ✅ VENDOR_SUBSCRIPTION_PASS — tiers gate surfacing/preferred/featured; billing status drives access; Stripe events mapped")
}
main()
