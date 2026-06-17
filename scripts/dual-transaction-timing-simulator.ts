#!/usr/bin/env tsx
/**
 * scripts/dual-transaction-timing-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves DUAL-TRANSACTION TIMING — the move-up choreography. A 'both' contact (selling their current
 * home AND buying the next) gets the Listing Concierge ↔ Shopping Agent timing play: ramp the buyer
 * search as the sale closes, prep a sale-contingent offer, or align close dates — published on the bus.
 *
 * Layer 1 (shell, pure): the timing decisions. Layer 2 (live, creds-gated): seed a 'both' contact +
 * their listing, run the coordinator, assert the bus signal between the two managers, idempotent,
 * clean up.
 *
 * Run: npx tsx scripts/dual-transaction-timing-simulator.ts   (npm run test:dual-transaction-timing)
 */
import { planDualTransactionTiming } from "../lib/intelligence/dual-transaction-timing"

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
  console.log(" ✅ Dual-transaction timing verified — the move-up sides stay in sync; coordinated on the bus.")
  console.log(" DUAL_TRANSACTION_TIMING_PASS")
  process.exit(0)
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Dual-transaction timing simulator")
  console.log("══════════════════════════════════════════════════\n")

  console.log("[Layer 1 · timing decisions]")
  const ramp = planDualTransactionTiming({ sellerStage: "under_contract", sellerCloseInDays: 30, buyerActivelyShopping: false, buyerHasOffer: false })
  check("sale closing soon + buyer not shopping → ramp_buyer_search (concierge → shopping)", ramp.coordinate && ramp.play === "ramp_buyer_search" && ramp.from === "listing_concierge" && ramp.to === "shopping_agent", JSON.stringify(ramp))

  const contingent = planDualTransactionTiming({ sellerStage: "listing_active", sellerCloseInDays: null, buyerActivelyShopping: true, buyerHasOffer: true })
  check("buyer ready to offer but home not sold → prep_sale_contingent_offer", contingent.coordinate && contingent.play === "prep_sale_contingent_offer" && contingent.from === "shopping_agent")

  const align = planDualTransactionTiming({ sellerStage: "closing_soon", sellerCloseInDays: 10, buyerActivelyShopping: true, buyerHasOffer: true })
  check("both live → align_close_dates", align.coordinate && align.play === "align_close_dates")

  const sync = planDualTransactionTiming({ sellerStage: "listing_active", sellerCloseInDays: null, buyerActivelyShopping: false, buyerHasOffer: false })
  check("sides in sync → hold (no coordination)", !sync.coordinate && sync.play === "hold")

  console.log("\n[Layer 2 · live: coordinate a real move-up on the bus]")
  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY && !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) { console.log("  ⏭  Skipped — SUPABASE creds not set (Layer 1 ran)."); return report() }

  const { createServiceClient } = await import("../lib/supabase/service")
  const { coordinateDualTransaction } = await import("../lib/intelligence/dual-transaction-timing-runner")
  const svc = createServiceClient()
  const { data: brokerage } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
  if (!brokerage) { console.log("  ⏭  Skipped — need a real brokerage."); return report() }
  const brokerageId = (brokerage as any).id
  const cleanup: Array<{ table: string; id: string }> = []
  let contactId: string | null = null
  try {
    const { data: c } = await svc.from("contacts").insert({
      brokerage_id: brokerageId, first_name: "ZZMoveUp", last_name: `${Date.now()}`,
      email: `zz-moveup-${Date.now()}@example.com`, contact_type: "both",
    }).select("id").single()
    contactId = (c as any)?.id ?? null
    if (contactId) cleanup.push({ table: "contacts", id: contactId })

    // Seller side: their current home, under contract.
    const { data: l } = await svc.from("listings").insert({
      brokerage_id: brokerageId, seller_contact_id: contactId, address: "3 Maple Dr", status: "under_contract",
    }).select("id").single()
    const listingId = (l as any)?.id
    if (listingId) cleanup.push({ table: "listings", id: listingId })
    // Sale closing in ~30 days.
    const { data: t } = await svc.from("transactions").insert({
      brokerage_id: brokerageId, listing_id: listingId, contact_id: contactId,
      estimated_close_date: new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10), status: "active",
    }).select("id").single()
    if ((t as any)?.id) cleanup.push({ table: "transactions", id: (t as any).id })

    // Buyer side: not actively shopping yet, no offers → should ramp the buyer search.
    const r = await coordinateDualTransaction({ brokerageId, contactId: contactId! }, svc)
    check("a move-up coordination was published", r.coordinated && r.play === "ramp_buyer_search", JSON.stringify(r))

    const { data: sig } = await svc.from("manager_signals")
      .select("from_manager, to_manager, signal_type, payload").eq("brokerage_id", brokerageId).eq("contact_id", contactId).eq("signal_type", "dual_transaction_timing").maybeSingle()
    check("a coordination signal exists (concierge → shopping)", (sig as any)?.from_manager === "listing_concierge" && (sig as any)?.to_manager === "shopping_agent", JSON.stringify(sig))

    const again = await coordinateDualTransaction({ brokerageId, contactId: contactId! }, svc)
    check("re-coordinating the same play in the window is idempotent", again.coordinated === false)
  } finally {
    await svc.from("manager_signals").delete().eq("brokerage_id", brokerageId).eq("contact_id", contactId ?? "none").eq("signal_type", "dual_transaction_timing").then(() => {}, () => {})
    for (const c of [...cleanup].reverse()) await svc.from(c.table).delete().eq("id", c.id).then(() => {}, () => {})
    const { count } = await svc.from("manager_signals").select("id", { count: "exact", head: true }).eq("contact_id", contactId ?? "none").eq("signal_type", "dual_transaction_timing")
    check("cleanup: coordination signals + seeds removed (count == 0)", (count ?? 0) === 0)
  }
  report()
}

main().catch((e) => { console.error(e); process.exit(1) })
