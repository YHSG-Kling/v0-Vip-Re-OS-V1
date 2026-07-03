#!/usr/bin/env tsx
/**
 * scripts/marketplace-earnings-simulator.ts   (npm run test:marketplace-earnings)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the MARKETPLACE TAKE-RATE income stream — a platform fee captured on every completed vendor
 * booking (previously dormant: manual-invoice-only, and $0 from an id-mismatch bug). HONEST: $0 gross
 * earns $0; rate clamped; the platform default keeps the income live even with no vendor profile.
 *
 * PURE:   computeMarketplaceFee (gross → platform_fee + net, clamped, cent-rounded).
 * SOURCE: the capture sweep is idempotent per booking, rides the vendor-orchestration cron, the invoice
 *         path shares the same resolver (bug fixed), the dashboard surfaces platform revenue, owned by
 *         finance_manager.
 * LIVE (creds-gated): seed a completed booking with a cost → capture creates ONE earning with the
 *         platform default fee → idempotent (no double-charge) → revenue sums → clean up == 0.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createClient } from "@supabase/supabase-js"
import { computeMarketplaceFee, PLATFORM_DEFAULT_TAKE_RATE_PCT } from "../lib/vendors/marketplace-fee"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

function pureLayer() {
  console.log("\n[computeMarketplaceFee · pure — honest split]")
  const f = computeMarketplaceFee({ grossAmount: 1000, takeRatePct: 10 })
  check("10% of $1000 → $100 platform fee, $900 vendor net", f.platformFee === 100 && f.net === 900 && f.gross === 1000)
  check("negotiated 20% → $200 / $800", (() => { const x = computeMarketplaceFee({ grossAmount: 1000, takeRatePct: 20 }); return x.platformFee === 200 && x.net === 800 })())
  check("$0 gross earns $0 (honest)", computeMarketplaceFee({ grossAmount: 0, takeRatePct: 10 }).platformFee === 0)
  check("null gross → 0, never NaN", computeMarketplaceFee({ grossAmount: null, takeRatePct: 10 }).platformFee === 0)
  check("rate clamped to [0,100]", computeMarketplaceFee({ grossAmount: 1000, takeRatePct: 250 }).platformFee === 1000 && computeMarketplaceFee({ grossAmount: 1000, takeRatePct: -5 }).platformFee === 0)
  check("cents rounded, no float drift", computeMarketplaceFee({ grossAmount: 333.33, takeRatePct: 10 }).platformFee === 33.33)
  check("platform default is a live, non-zero rate", PLATFORM_DEFAULT_TAKE_RATE_PCT > 0)
}

function sourceLayer() {
  console.log("\n[wiring — idempotent capture, shared resolver, cron, surface, owned]")
  const cap = src("lib/vendors/marketplace-earnings-capture.ts")
  check("captures only COMPLETED bookings with a real cost", /eq\("status", "completed"\)[\s\S]*?not\("cost", "is", null\)[\s\S]*?gt\("cost", 0\)/.test(cap))
  check("idempotent per booking (skips already-earned booking_ids)", /select\("booking_id"\)\.in\("booking_id", ids\)[\s\S]*?earned\.has\(b\.id\)/.test(cap))
  check("computes the fee via the shared resolver + pure split", /resolveVendorRevenueShare/.test(cap) && /computeMarketplaceFee/.test(cap))
  const fee = src("lib/vendors/marketplace-fee.ts")
  check("resolver bridges vendors.id → user_role_assignments → marketplace profile, else platform default", /user_role_assignments[\s\S]*?vendor_marketplace_profiles[\s\S]*?PLATFORM_DEFAULT_TAKE_RATE_PCT/.test(fee))
  const pay = src("app/actions/vendor-payments.ts")
  check("markInvoicePaid consolidated onto the SAME resolver (the $0 bug is fixed)", /resolveVendorRevenueShare\(svc, verify\.vendor_id\)/.test(pay) && !/vendor_marketplace_profiles"\)\s*\.select\("revenue_share_percent"\)\s*\.eq\("id", verify\.vendor_id\)/.test(pay))
  const cron = src("app/api/cron/vendor-orchestration/route.ts")
  check("the daily vendor-orchestration cron runs the capture", /captureCompletedBookingEarningsAll/.test(cron))
  const dash = src("app/dashboard/financials/brokerage/page.tsx")
  check("the finance dashboard surfaces platform marketplace revenue", /Marketplace Revenue/.test(dash) && /marketplaceRevenue\.platformFees/.test(dash))
  const reg = src("lib/kernel/manager-registry.ts")
  check("burn domain owned by finance_manager with a runnable proof", /marketplace_take_rate:\s*\{\s*manager:\s*"finance_manager",\s*proof:\s*"test:marketplace-earnings"/.test(reg))
}

async function liveLayer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) { console.log("\n[live] ⊘ skipped (no SUPABASE creds) — pure + source layers proved the logic"); return }
  const svc = createClient(url, key)
  console.log("\n[live] seed a completed booking → capture creates ONE earning at the platform rate → idempotent → clean up")
  const { data: brk } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
  if (!brk) { console.log("  ⊘ no brokerage — skipping"); return }
  const brokerageId = (brk as any).id
  const { data: vend } = await svc.from("vendors").select("id").eq("brokerage_id", brokerageId).limit(1).maybeSingle()
  if (!vend) { console.log("  ⊘ no vendor — skipping"); return }
  const vendorId = (vend as any).id
  const cleanup: Array<{ table: string; id: string }> = []
  try {
    const { data: bk } = await svc.from("vendor_bookings").insert({ brokerage_id: brokerageId, vendor_id: vendorId, cost: 1000, status: "completed", service_type: "inspection" }).select("id").single()
    const bookingId = (bk as any).id
    cleanup.push({ table: "vendor_bookings", id: bookingId })

    const { captureCompletedBookingEarnings } = await import("../lib/vendors/marketplace-earnings-capture")
    const r1 = await captureCompletedBookingEarnings(svc as any, { brokerageId })
    check("live: captured at least our seeded booking", r1.captured >= 1 && r1.platformRevenue >= 100)

    const { data: earn } = await svc.from("vendor_earnings").select("id, gross_amount, platform_fee, net_amount, booking_id").eq("booking_id", bookingId).maybeSingle()
    if (earn) cleanup.push({ table: "vendor_earnings", id: (earn as any).id })
    check("live: earning is gross $1000, platform fee = default rate, net = remainder", !!earn && Number((earn as any).gross_amount) === 1000 && Number((earn as any).platform_fee) === 1000 * PLATFORM_DEFAULT_TAKE_RATE_PCT / 100 && Number((earn as any).net_amount) === 1000 - 1000 * PLATFORM_DEFAULT_TAKE_RATE_PCT / 100)

    const r2 = await captureCompletedBookingEarnings(svc as any, { brokerageId })
    const { count } = await svc.from("vendor_earnings").select("id", { count: "exact", head: true }).eq("booking_id", bookingId)
    check("live: idempotent — the same booking is never double-charged", count === 1 && r2.captured === 0)
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
  if (fail > 0) { console.log(" ❌ MARKETPLACE_EARNINGS_FAIL"); process.exit(1) }
  console.log(" ✅ MARKETPLACE_EARNINGS_PASS — the marketplace take-rate is a real, idempotent, surfaced income stream")
}
main()
