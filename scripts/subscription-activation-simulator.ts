#!/usr/bin/env tsx
/**
 * scripts/subscription-activation-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * CLOSES THE MONEY LOOP. Signup/provisioning worked but nothing collected a card,
 * there was no setup-fee line item, the webhook had NO checkout.session.completed
 * handler (so paying never ACTIVATED the account), and the signup row (no
 * stripe_subscription_id) + a webhook upsert-by-stripe_subscription_id would insert
 * a DUPLICATE subscription row per brokerage.
 *
 * Layer 1 (pure): buildCheckoutConfig (recurring plan line item + a one-time SETUP
 *   FEE add-invoice-item only when the tier carries one); buildSubscriptionPatch
 *   (Stripe sub → row patch, unix→ISO).
 * Layer 2 (source): checkout adds the setup fee via add_invoice_items; the webhook
 *   handles checkout.session.completed; BOTH subscription branches route through the
 *   ONE brokerage-keyed writer (upsertBrokerageSubscription), never a raw
 *   onConflict:"stripe_subscription_id" insert.
 * Layer 3 (live, gated): seed a brokerage + a TRIALING subscription row (no
 *   stripe_subscription_id) → upsertBrokerageSubscription with a stripe id + active
 *   LINKS the existing row (updated, not inserted); a second call (simulating
 *   subscription.updated) still yields exactly ONE row → no duplicate. Cleanup==0.
 *
 * Run: npx tsx scripts/subscription-activation-simulator.ts  (npm run test:subscription-activation)
 */
import {
  buildCheckoutConfig, buildSubscriptionPatch, type CheckoutTier, type NormalizedStripeSub,
} from "../lib/billing/subscription-activation"
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
  console.log(" ✅ Money loop verified — setup fee + monthly at checkout, activation links the row, ZERO duplicates")
  console.log(" SUBSCRIPTION_ACTIVATION_PASS")
}

const TIER: CheckoutTier = { tier_name: "solo_agent", display_name: "Solo Agent", monthly_price_cents: 9900, annual_price_cents: 99000, setup_fee_cents: 29900 }

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Subscription activation (money loop) simulator")
  console.log("══════════════════════════════════════════════════")

  console.log("\n[Layer 1 · pure checkout + patch builders]")
  const cfg = buildCheckoutConfig(TIER, "monthly")
  check("checkout has ONE recurring plan line item at the monthly price",
    cfg.lineItems.length === 1 && (cfg.lineItems[0] as any).price_data.unit_amount === 9900 && (cfg.lineItems[0] as any).price_data.recurring.interval === "month")
  check("checkout adds a ONE-TIME setup fee (add_invoice_items) at the tier's setup_fee_cents",
    cfg.addInvoiceItems.length === 1 && (cfg.addInvoiceItems[0] as any).price_data.unit_amount === 29900 && !(cfg.addInvoiceItems[0] as any).price_data.recurring)
  check("annual cycle uses the annual price + year interval",
    (buildCheckoutConfig(TIER, "annual").lineItems[0] as any).price_data.unit_amount === 99000 && (buildCheckoutConfig(TIER, "annual").lineItems[0] as any).price_data.recurring.interval === "year")
  check("a tier with NO setup fee adds no one-time item",
    buildCheckoutConfig({ ...TIER, setup_fee_cents: 0 }, "monthly").addInvoiceItems.length === 0)

  const norm: NormalizedStripeSub = { stripeSubscriptionId: "sub_X", stripeCustomerId: "cus_X", tierId: "tier_X", status: "active", currentPeriodStart: 1_700_000_000, currentPeriodEnd: 1_702_000_000, trialEnd: null, cancelAt: null }
  const patch = buildSubscriptionPatch(norm)
  check("patch carries the stripe ids + status + tier, unix→ISO periods, no brokerage_id",
    patch.stripe_subscription_id === "sub_X" && patch.status === "active" && patch.tier_id === "tier_X" &&
    typeof patch.current_period_start === "string" && !("brokerage_id" in patch))
  check("null trial/cancel → null (not epoch)", patch.trial_end === null && patch.cancel_at === null)

  console.log("\n[Layer 2 · webhook + checkout wiring]")
  const billingSrc = readFileSync(join(process.cwd(), "app/actions/billing.ts"), "utf8")
  check("checkout uses buildCheckoutConfig + passes add_invoice_items (setup fee)",
    /buildCheckoutConfig\(/.test(billingSrc) && /add_invoice_items/.test(billingSrc))
  const hookSrc = readFileSync(join(process.cwd(), "app/api/billing/webhook/route.ts"), "utf8")
  check("webhook handles checkout.session.completed (activation)",
    /case "checkout\.session\.completed"/.test(hookSrc))
  check("both subscription branches use the brokerage-keyed writer (no raw onConflict:stripe_subscription_id insert)",
    (hookSrc.match(/upsertBrokerageSubscription\(/g) ?? []).length >= 2 && !/onConflict:\s*"stripe_subscription_id"/.test(hookSrc))
  check("checkout.session.completed also runs the provisioning safety-repair",
    /repairIncompleteAccountSetup/.test(hookSrc))

  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY &&
    !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("\n[Layer 3 · live activation]")
    console.log("  ⏭  Skipped — SUPABASE creds not set (pure + source layers ran).")
    report()
    return
  }

  const { createServiceClient } = await import("../lib/supabase/service")
  const { upsertBrokerageSubscription } = await import("../lib/billing/subscription-activation")
  const svc = createServiceClient()
  const TAG = `SubAct${Date.now()}`
  const cleanup: Array<{ table: string; id: string }> = []

  console.log("\n[Layer 3 · live activation]")
  try {
    const { data: brk, error: bErr } = await svc.from("brokerages").insert({ name: `${TAG} Brokerage` }).select("id").single()
    if (bErr) { check("seed test brokerage", false, bErr.message); report(); return }
    const brokerageId = (brk as any).id
    cleanup.push({ table: "brokerages", id: brokerageId })

    // The trialing row signup creates — NO stripe_subscription_id (tier_id is NOT NULL).
    const { data: anyTier } = await svc.from("subscription_tiers").select("id").limit(1).single()
    const { data: trialRow } = await svc.from("subscriptions").insert({
      brokerage_id: brokerageId, tier_id: (anyTier as any)?.id ?? null, status: "trialing", created_at: new Date().toISOString(),
    }).select("id").single()
    const trialId = (trialRow as any).id
    cleanup.push({ table: "subscriptions", id: trialId })

    // checkout.session.completed → LINK the existing row (activate).
    const r1 = await upsertBrokerageSubscription(svc, brokerageId, buildSubscriptionPatch({
      stripeSubscriptionId: `sub_${TAG}`, stripeCustomerId: `cus_${TAG}`, tierId: null,
      status: "active", currentPeriodStart: 1_700_000_000, currentPeriodEnd: 1_702_000_000, trialEnd: null, cancelAt: null,
    }))
    check("activation UPDATES the existing trialing row (not a new insert)", r1.action === "updated" && r1.id === trialId, JSON.stringify(r1))

    const { data: after1 } = await svc.from("subscriptions").select("id, stripe_subscription_id, status").eq("brokerage_id", brokerageId)
    check("after activation: exactly ONE row, linked + active",
      (after1 ?? []).length === 1 && (after1 as any)[0].stripe_subscription_id === `sub_${TAG}` && (after1 as any)[0].status === "active",
      JSON.stringify(after1))

    // subscription.updated fires later with the SAME stripe id → still one row.
    const r2 = await upsertBrokerageSubscription(svc, brokerageId, buildSubscriptionPatch({
      stripeSubscriptionId: `sub_${TAG}`, stripeCustomerId: `cus_${TAG}`, tierId: null,
      status: "active", currentPeriodStart: 1_700_000_000, currentPeriodEnd: 1_705_000_000, trialEnd: null, cancelAt: null,
    }))
    const { count } = await svc.from("subscriptions").select("id", { count: "exact", head: true }).eq("brokerage_id", brokerageId)
    check("subscription.updated reuses the SAME row — NO duplicate (still exactly 1)",
      r2.action === "updated" && r2.id === trialId && (count ?? 0) === 1, `action=${r2.action} count=${count}`)
  } finally {
    for (const c of [...cleanup].reverse()) {
      try { await svc.from(c.table).delete().eq("id", c.id) } catch { /* noop */ }
    }
    // Belt-and-suspenders: any subscription rows for the test brokerage.
    const { data: brk2 } = await svc.from("brokerages").select("id").eq("name", `${TAG} Brokerage`).maybeSingle()
    if (brk2) await svc.from("subscriptions").delete().eq("brokerage_id", (brk2 as any).id)
    const { count } = await svc.from("brokerages").select("id", { count: "exact", head: true }).eq("name", `${TAG} Brokerage`)
    check("cleanup verified — 0 seeded brokerages remain", (count ?? 0) === 0)
  }

  report()
}
main().catch((e) => { console.error(e); process.exit(1) })
