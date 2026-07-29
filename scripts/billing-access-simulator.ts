#!/usr/bin/env tsx
/**
 * scripts/billing-access-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * THE HANDS-OFF PAYWALL. A lapsed-trial / past-due / cancelled tenant is routed to
 * billing at login, so the money loop closes itself with no human in the loop —
 * while NEVER locking out a legacy / no-subscription account (fail-open). Also
 * proves pricing is NOT hardcoded in signup (subscription_tiers is the source of
 * truth, so a production price bump is a DB update, not a code change).
 *
 * Layer 1 (pure): resolveBillingAccess across every state (active / trialing-with-
 *   time-left / trial-expired / past_due / cancelled / no-sub / unknown).
 * Layer 2 (source): the login resolver has the paywall gate (blocked → billing,
 *   staff exempt, fail-open on error); the signup page loads subscription_tiers and
 *   the form renders priceByTier (no hardcoded "$99/$299/..." price strings).
 * Layer 3 (live, gated): seed a brokerage + a trialing subscription whose trial_end
 *   is in the PAST → loadBillingAccess is blocked/expired; flip to active → not
 *   blocked. Cleanup==0.
 *
 * Run: npx tsx scripts/billing-access-simulator.ts   (npm run test:billing-access)
 */
import { resolveBillingAccess } from "../lib/billing/billing-access"
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
  console.log(" ✅ Paywall verified — lapsed tenants routed to billing, legacy accounts never locked out, prices DB-driven")
  console.log(" BILLING_ACCESS_PASS")
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Billing access (hands-off paywall) simulator")
  console.log("══════════════════════════════════════════════════")

  const now = new Date("2026-07-06T00:00:00.000Z")
  const future = new Date("2026-07-20T00:00:00.000Z").toISOString()
  const past = new Date("2026-07-01T00:00:00.000Z").toISOString()

  console.log("\n[Layer 1 · pure access classifier]")
  check("active → NOT blocked", (() => { const a = resolveBillingAccess({ status: "active", trial_end: null }, now); return !a.blocked && a.state === "active" })())
  check("trialing with time left → NOT blocked, trialDaysLeft > 0",
    (() => { const a = resolveBillingAccess({ status: "trialing", trial_end: future }, now); return !a.blocked && (a.trialDaysLeft ?? 0) > 0 })())
  check("trialing but trial_end in the PAST → BLOCKED (expired) — the core enforcement",
    (() => { const a = resolveBillingAccess({ status: "trialing", trial_end: past }, now); return a.blocked && a.state === "expired" && a.trialDaysLeft === 0 })())
  check("past_due → BLOCKED", (() => { const a = resolveBillingAccess({ status: "past_due", trial_end: null }, now); return a.blocked && a.state === "past_due" })())
  check("cancelled / canceled → BLOCKED (expired)",
    resolveBillingAccess({ status: "cancelled", trial_end: null }, now).blocked && resolveBillingAccess({ status: "canceled", trial_end: null }, now).blocked)
  check("NO subscription row → NOT blocked (fail-open, never lock out a legacy account)",
    (() => { const a = resolveBillingAccess(null, now); return !a.blocked && a.state === "none" })())
  check("unknown status → NOT blocked (fail-open)", !resolveBillingAccess({ status: "weird", trial_end: null }, now).blocked)

  console.log("\n[Layer 2 · gate + de-hardcoded pricing wiring]")
  const onboardingSrc = readFileSync(join(process.cwd(), "lib/kernel/onboarding.ts"), "utf8")
  check("login resolver has the paywall gate (blocked → /dashboard/admin/billing)",
    /loadBillingAccess/.test(onboardingSrc) && /billing_required/.test(onboardingSrc) && /\/dashboard\/admin\/billing/.test(onboardingSrc))
  check("gate exempts platform staff + fails open on error",
    /\["superadmin", "support"\]\.includes\(userType\)/.test(onboardingSrc) && /fail-open/.test(onboardingSrc))
  // These two used to grep for an inline from("subscription_tiers") in page.tsx
  // and a priceByTier[t.id] lookup in the form. Both were refactored into
  // lib/platform/public-tiers.ts (loadPublicTiers + formatTierPrice, shared with
  // /pricing) and the assertions kept failing on code that was CORRECT — they
  // pinned the shape of the implementation, not the promise. The promise is:
  // prices come from the DB and no dollar figure is written into the page.
  const pageSrc = readFileSync(join(process.cwd(), "app/get-started/page.tsx"), "utf8")
  const tiersSrc = readFileSync(join(process.cwd(), "lib/platform/public-tiers.ts"), "utf8")
  check("signup page loads prices from subscription_tiers (source of truth)",
    /loadPublicTiers/.test(pageSrc) && /from\("subscription_tiers"\)/.test(tiersSrc)
    && /monthly_price_cents/.test(tiersSrc))
  const formSrc = readFileSync(join(process.cwd(), "app/get-started/trial-funnel-form.tsx"), "utf8")
  check("signup form renders DB prices, NO hardcoded price strings",
    /monthlyCents/.test(formSrc) && !/price:\s*"\$/.test(formSrc)
    && !/\$\d{2,}/.test(formSrc))

  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY &&
    !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("\n[Layer 3 · live paywall]")
    console.log("  ⏭  Skipped — SUPABASE creds not set (pure + source layers ran).")
    report()
    return
  }

  const { createServiceClient } = await import("../lib/supabase/service")
  const { loadBillingAccess } = await import("../lib/billing/billing-access")
  const svc = createServiceClient()
  const TAG = `BillAcc${Date.now()}`
  const cleanup: Array<{ table: string; id: string }> = []

  console.log("\n[Layer 3 · live paywall]")
  try {
    const { data: brk } = await svc.from("brokerages").insert({ name: `${TAG} Brokerage` }).select("id").single()
    const brokerageId = (brk as any).id
    cleanup.push({ table: "brokerages", id: brokerageId })
    const { data: anyTier } = await svc.from("subscription_tiers").select("id").limit(1).single()

    // Trialing with an EXPIRED trial → blocked.
    const { data: sub } = await svc.from("subscriptions").insert({
      brokerage_id: brokerageId, tier_id: (anyTier as any)?.id ?? null, status: "trialing",
      trial_end: new Date(Date.now() - 86_400_000).toISOString(), created_at: new Date().toISOString(),
    }).select("id").single()
    cleanup.push({ table: "subscriptions", id: (sub as any).id })

    const blocked = await loadBillingAccess(svc, brokerageId)
    check("live: expired-trial tenant is BLOCKED (routes to the paywall)", blocked.blocked && blocked.state === "expired", JSON.stringify(blocked))

    // Pay → active → access restored.
    await svc.from("subscriptions").update({ status: "active" }).eq("id", (sub as any).id)
    const active = await loadBillingAccess(svc, brokerageId)
    check("live: after activation the tenant has ACCESS (paywall lifts)", !active.blocked && active.state === "active", JSON.stringify(active))
  } finally {
    for (const c of [...cleanup].reverse()) {
      try { await svc.from(c.table).delete().eq("id", c.id) } catch { /* noop */ }
    }
    const { count } = await svc.from("brokerages").select("id", { count: "exact", head: true }).eq("name", `${TAG} Brokerage`)
    check("cleanup verified — 0 seeded brokerages remain", (count ?? 0) === 0)
  }

  report()
}
main().catch((e) => { console.error(e); process.exit(1) })
