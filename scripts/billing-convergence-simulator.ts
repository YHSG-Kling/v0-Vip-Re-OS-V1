#!/usr/bin/env tsx
/**
 * scripts/billing-convergence-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * BILLING CONVERGENCE (keep-two-stores, share-the-brains). Investigation confirmed
 * the two billing paths are CORRECTLY separate entities — a brokerage tenant pays
 * (subscriptions, brokerage-keyed) vs a marketplace vendor pays (vendor_marketplace_
 * profiles, profile-keyed) — so they keep separate stores. But they must NOT diverge
 * on the pieces they share: the Stripe status vocabulary and the billing portal.
 *
 * Layer 1 (pure): normalizeStripeStatus (past_due←unpaid, canceled←cancelled,
 *   incomplete_expired→incomplete, active/trialing/paused, empty/other→unknown);
 *   isCurrentStatus / isDelinquentStatus; the vendor mapStripeEventToStatus now
 *   routes through the shared normalizer (past_due / canceled+suspend / trialing /
 *   active) incl. checkout.session.completed.
 * Layer 2 (source): BOTH the vendor billing action and the brokerage billing action
 *   open the portal through the ONE shared createBillingPortalUrl; tenants now have
 *   a self-serve portal (parity); the vendor status mapper imports the shared
 *   normalizer; the portal button is wired into the tenant billing page.
 *
 * Run: npx tsx scripts/billing-convergence-simulator.ts   (npm run test:billing-convergence)
 */
import { normalizeStripeStatus, isCurrentStatus, isDelinquentStatus } from "../lib/billing/stripe-status"
import { mapStripeEventToStatus } from "../lib/kernel/vendor-subscription"
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
  console.log(" ✅ Billing convergence verified — one Stripe-status vocab + one portal, two correct stores")
  console.log(" BILLING_CONVERGENCE_PASS")
}

function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Billing convergence simulator")
  console.log("══════════════════════════════════════════════════")

  console.log("\n[Layer 1 · shared status normalizer]")
  check("unpaid → past_due; cancelled → canceled (spelling unified)",
    normalizeStripeStatus("unpaid") === "past_due" && normalizeStripeStatus("cancelled") === "canceled" && normalizeStripeStatus("canceled") === "canceled")
  check("incomplete_expired → incomplete; active/trialing/paused map through",
    normalizeStripeStatus("incomplete_expired") === "incomplete" && normalizeStripeStatus("active") === "active" &&
    normalizeStripeStatus("trialing") === "trialing" && normalizeStripeStatus("paused") === "paused")
  check("empty / unknown → unknown", normalizeStripeStatus("") === "unknown" && normalizeStripeStatus("weird") === "unknown")
  check("isCurrentStatus: active/trialing true, past_due/canceled false",
    isCurrentStatus("active") && isCurrentStatus("trialing") && !isCurrentStatus("past_due") && !isCurrentStatus("canceled"))
  check("isDelinquentStatus: past_due/canceled/incomplete true, active false",
    isDelinquentStatus("past_due") && isDelinquentStatus("canceled") && isDelinquentStatus("incomplete") && !isDelinquentStatus("active"))

  console.log("\n[Layer 1b · vendor mapper routes through the shared normalizer]")
  check("payment_failed → past_due (no suspend)", mapStripeEventToStatus("invoice.payment_failed").status === "past_due")
  check("subscription.deleted → canceled + suspend", (() => { const r = mapStripeEventToStatus("customer.subscription.deleted"); return r.status === "canceled" && r.suspendAccount })())
  check("subscription.updated unpaid → past_due", mapStripeEventToStatus("customer.subscription.updated", "unpaid").status === "past_due")
  check("subscription.updated cancelled → canceled + suspend",
    (() => { const r = mapStripeEventToStatus("customer.subscription.updated", "cancelled"); return r.status === "canceled" && r.suspendAccount })())
  check("checkout.session.completed → active", mapStripeEventToStatus("checkout.session.completed", "complete").status === "active")
  check("trialing → trialing (no suspend)", mapStripeEventToStatus("customer.subscription.updated", "trialing").status === "trialing")

  console.log("\n[Layer 2 · one portal, shared normalizer wiring]")
  const portalSrc = readFileSync(join(process.cwd(), "lib/billing/stripe-portal.ts"), "utf8")
  check("shared createBillingPortalUrl exists", /export async function createBillingPortalUrl/.test(portalSrc))
  const vendorBillingSrc = readFileSync(join(process.cwd(), "app/actions/vendor-billing.ts"), "utf8")
  check("vendor portal uses the shared helper (no inline billingPortal.sessions.create)",
    /createBillingPortalUrl\(/.test(vendorBillingSrc) && !/stripe\.billingPortal\.sessions\.create/.test(vendorBillingSrc))
  const tenantBillingSrc = readFileSync(join(process.cwd(), "app/actions/billing.ts"), "utf8")
  check("brokerage tenants now have a self-serve portal action (parity) via the shared helper",
    /createBrokerageBillingPortalAction/.test(tenantBillingSrc) && /createBillingPortalUrl\(/.test(tenantBillingSrc))
  const vendorSubSrc = readFileSync(join(process.cwd(), "lib/kernel/vendor-subscription.ts"), "utf8")
  check("vendor status mapper imports the shared normalizer (no drift)",
    /from ['"]@\/lib\/billing\/stripe-status['"]/.test(vendorSubSrc) && /normalizeStripeStatus\(/.test(vendorSubSrc))
  const pageSrc = readFileSync(join(process.cwd(), "app/dashboard/admin/billing/page.tsx"), "utf8")
  check("the Manage-billing button is wired into the tenant billing page", /ManageBillingButton/.test(pageSrc))

  report()
}
main()
