#!/usr/bin/env tsx
/**
 * scripts/dual-intent-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the DUAL-INTENT LINKER: ONE contact who is BOTH a seller AND a buyer
 * (the owner's "must sell to buy" case). The team must work this ONE person across
 * BOTH journeys without losing context, and the buyer journey is gated on /
 * sequenced after the seller's sale closing (the sale funds the purchase).
 *
 * Layer 1 (pure, no I/O):
 *   - detectDualIntent: buyer+seller signal → true; one side only → false.
 *   - sellMustPrecedeBuy: purchase contingent on the sale → gated with reason
 *     'sale_funds_purchase'; a cash buyer not selling → not gated.
 *
 * Layer 2 (live, gated by SUPABASE_SERVICE_ROLE_KEY): a real contact with BOTH a
 *   seller listing + buyer criteria → linkDualJourneys →
 *     · contact_type='both',
 *     · BOTH journey_states rows exist (buyer + seller), cross-linked,
 *     · the dependency stamped on both sides,
 *     · idempotent rerun (no duplicate journeys),
 *     · a single-intent contact → no-op,
 *     · reverse-delete + cleanup count==0.
 *
 * No mocks/stubs/demo data — real Supabase, real rows, full teardown.
 *
 * Run:  npx tsx scripts/dual-intent-simulator.ts   (npm run test:dual-intent)
 */

import {
  detectDualIntent,
  sellMustPrecedeBuy,
  journeyUserKey,
} from "../lib/kernel/dual-intent-linker"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

// ───────────────────────────────────────────────────────────────────────────
// Layer 1 — PURE
// ───────────────────────────────────────────────────────────────────────────
function testPure() {
  console.log("\n[Layer 1 · pure — detectDualIntent]")

  // buyer + seller signal → dual.
  const both = detectDualIntent(
    { contactType: "buyer", buyerStage: "searching" },
    { hasBuyerSignal: true, hasSellerSignal: true },
  )
  check("buyer+seller signal → isDual=true", both.isDual === true, both.reason)
  check("dual verdict reports both sides", both.sides.includes("buyer") && both.sides.includes("seller"))

  // buyer only → not dual.
  const buyerOnly = detectDualIntent(
    { contactType: "buyer", buyerStage: "searching" },
    { hasBuyerSignal: true, hasSellerSignal: false },
  )
  check("buyer signal only → isDual=false", buyerOnly.isDual === false, buyerOnly.reason)

  // seller only → not dual.
  const sellerOnly = detectDualIntent(
    { contactType: "seller", buyerStage: null },
    { hasBuyerSignal: false, hasSellerSignal: true },
  )
  check("seller signal only → isDual=false", sellerOnly.isDual === false, sellerOnly.reason)

  // contact_type='both' alone is enough on both sides.
  const ctBoth = detectDualIntent(
    { contactType: "both", buyerStage: null },
    { hasBuyerSignal: false, hasSellerSignal: false },
  )
  check("contact_type='both' → isDual=true (both sides inferred)", ctBoth.isDual === true, ctBoth.reason)

  // no signal at all → not dual.
  const none = detectDualIntent({ contactType: null, buyerStage: null }, { hasBuyerSignal: false, hasSellerSignal: false })
  check("no signal → isDual=false", none.isDual === false, none.reason)

  console.log("\n[Layer 1 · pure — sellMustPrecedeBuy]")

  // must-sell-to-buy: purchase needs the sale proceeds, sale not yet closed → GATED.
  const gated = sellMustPrecedeBuy(
    { isCashBuyer: false, requiresSaleProceeds: true, hasIndependentFunding: false },
    { lifecycleStage: "MLS_ACTIVE" },
  )
  check("purchase contingent on sale → gated", gated.gated === true, gated.reason)
  check("gated reason = sale_funds_purchase", gated.reason === "sale_funds_purchase", gated.reason)
  check("gated blockingStage = CLOSED", gated.blockingStage === "CLOSED", String(gated.blockingStage))
  check("gated NOT satisfied while listing is only MLS_ACTIVE", gated.satisfied === false, String(gated.satisfied))

  // dependency satisfied once the sale CLOSES.
  const satisfied = sellMustPrecedeBuy(
    { isCashBuyer: false, requiresSaleProceeds: true, hasIndependentFunding: false },
    { lifecycleStage: "CLOSED" },
  )
  check("once the sale is CLOSED the dependency is satisfied", satisfied.gated === true && satisfied.satisfied === true, JSON.stringify(satisfied))

  // cash buyer not selling-to-buy → NOT gated.
  const cash = sellMustPrecedeBuy(
    { isCashBuyer: true, requiresSaleProceeds: false, hasIndependentFunding: false },
    { lifecycleStage: "MLS_ACTIVE" },
  )
  check("cash buyer → not gated", cash.gated === false, cash.reason)
  check("cash buyer reason = cash_buyer_not_gated", cash.reason === "cash_buyer_not_gated", cash.reason)

  // independent funding → NOT gated.
  const indep = sellMustPrecedeBuy(
    { isCashBuyer: false, requiresSaleProceeds: false, hasIndependentFunding: true },
    { lifecycleStage: "MLS_ACTIVE" },
  )
  check("independent funding → not gated", indep.gated === false, indep.reason)

  // composite key helper.
  check("journeyUserKey composes per (contact, side)",
    journeyUserKey("abc", "buyer") === "abc:buyer" && journeyUserKey("abc", "seller") === "abc:seller")
}

// ───────────────────────────────────────────────────────────────────────────
// Layer 2 — LIVE
// ───────────────────────────────────────────────────────────────────────────
async function testLive() {
  console.log("\n[Layer 2 · live — linkDualJourneys on ONE contact with both sides]")
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) {
    console.log("  ⏭  Skipped — SUPABASE_SERVICE_ROLE_KEY not set.")
    return
  }

  const { createServiceClient } = await import("../lib/supabase/service")
  const { linkDualJourneys } = await import("../lib/kernel/dual-intent-linker")
  const svc = createServiceClient()

  const TAG = `__dualintent_${Date.now()}__`
  const cleanup: Array<{ table: string; column: string; value: string }> = []

  try {
    const { data: agent } = await svc
      .from("agents")
      .select("id, brokerage_id")
      .not("brokerage_id", "is", null)
      .eq("is_active", true)
      .limit(1)
      .single()
    if (!agent) { console.log("  ⏭  Skipped — need an active agent with brokerage_id."); return }
    const brokerageId = (agent as any).brokerage_id as string
    const agentId = (agent as any).id as string

    // ── Seed the DUAL contact: a buyer-type person who ALSO sells a home. ──────
    const { data: contact, error: cErr } = await svc.from("contacts").insert({
      brokerage_id: brokerageId,
      agent_id: agentId,
      first_name: TAG,
      last_name: "DualIntent",
      email: `${TAG}@example.com`,
      contact_type: "buyer",        // mono-typed at seed — the gap the linker closes
      contact_persona: "downsizing_senior",
      buyer_stage: "searching",
      status: "active",
    }).select("id").single()
    check("seed dual-intent contact (mono-typed 'buyer' at seed)", !cErr && !!contact, cErr?.message)
    if (!contact) throw new Error("contact seed failed")
    const contactId = (contact as any).id as string
    cleanup.push({ table: "journey_states", column: "contact_id", value: contactId })
    cleanup.push({ table: "transparency_updates", column: "contact_id", value: contactId })
    cleanup.push({ table: "property_preferences", column: "contact_id", value: contactId })
    cleanup.push({ table: "buyer_financial_profiles", column: "contact_id", value: contactId })
    cleanup.push({ table: "listings", column: "seller_contact_id", value: contactId })
    cleanup.push({ table: "contacts", column: "id", value: contactId })

    // Buyer side: a saved search (criteria). Non-cash → must-sell-to-buy.
    const { error: prefErr } = await svc.from("property_preferences").insert({
      contact_id: contactId, brokerage_id: brokerageId, agent_id: agentId,
      preferred_price_min: 400000, preferred_price_max: 600000,
    })
    check("seed buyer-side criteria (property_preferences)", !prefErr, prefErr?.message)

    const { error: finErr } = await svc.from("buyer_financial_profiles").insert({
      contact_id: contactId, brokerage_id: brokerageId,
      finance_type: "conventional", is_cash_buyer: false, verified: false,
    })
    check("seed buyer-side financial profile (non-cash)", !finErr, finErr?.message)

    // Seller side: an active listing the contact is SELLING (the home to sell first).
    const { data: listing, error: lErr } = await svc.from("listings").insert({
      brokerage_id: brokerageId, agent_id: agentId, seller_contact_id: contactId,
      address: `${TAG} 88 Maple Dr`, status: "active", lifecycle_stage: "MLS_ACTIVE",
    }).select("id").single()
    check("seed seller-side listing (MLS_ACTIVE, not yet sold)", !lErr && !!listing, lErr?.message)
    const listingId = (listing as any)?.id as string | undefined

    // ════════════════════════════════════════════════════════════════════════
    // LINK — the one contact's two journeys.
    // ════════════════════════════════════════════════════════════════════════
    console.log("\n  ── linkDualJourneys ──")
    const r = await linkDualJourneys(contactId, svc)
    check("linkDualJourneys returns linked=true", r.linked === true, r.reason)
    check("contact_type set to 'both'", r.contactType === "both", String(r.contactType))

    const { data: contactAfter } = await svc.from("contacts").select("contact_type").eq("id", contactId).maybeSingle()
    check("contacts.contact_type persisted as 'both' (both concierges now wake)",
      (contactAfter as any)?.contact_type === "both", String((contactAfter as any)?.contact_type))

    // BOTH journey_states rows exist for the ONE contact.
    const { data: journeys } = await svc.from("journey_states")
      .select("id, user_id, persona, contact_id, listing_id, current_stage, metadata_json")
      .eq("contact_id", contactId)
    const jList = (journeys ?? []) as Array<any>
    check("exactly TWO journey_states rows for the one contact", jList.length === 2, `got ${jList.length}`)

    const buyerJourney = jList.find(j => j.user_id === journeyUserKey(contactId, "buyer"))
    const sellerJourney = jList.find(j => j.user_id === journeyUserKey(contactId, "seller"))
    check("buyer-side journey row exists (keyed `${contactId}:buyer`)", !!buyerJourney)
    check("seller-side journey row exists (keyed `${contactId}:seller`)", !!sellerJourney)
    check("buyer journey current_stage honest (real buyer_stage 'searching')",
      buyerJourney?.current_stage === "searching", String(buyerJourney?.current_stage))
    check("seller journey current_stage honest (real lifecycle_stage 'MLS_ACTIVE')",
      sellerJourney?.current_stage === "MLS_ACTIVE", String(sellerJourney?.current_stage))
    check("seller journey carries the listing_id", sellerJourney?.listing_id === listingId, String(sellerJourney?.listing_id))

    // Cross-link: each side points at the other.
    const buyerMeta = buyerJourney ? JSON.parse(buyerJourney.metadata_json) : {}
    const sellerMeta = sellerJourney ? JSON.parse(sellerJourney.metadata_json) : {}
    check("buyer side cross-links to the seller journey",
      buyerMeta.counterpart_user_id === journeyUserKey(contactId, "seller") && buyerMeta.counterpart_side === "seller")
    check("seller side cross-links to the buyer journey",
      sellerMeta.counterpart_user_id === journeyUserKey(contactId, "buyer") && sellerMeta.counterpart_side === "buyer")

    // The dependency is stamped on both sides.
    check("dependency stamped: buyer side is GATED on the sale",
      buyerMeta.gated_on_counterpart === true && buyerMeta.dependency?.reason === "sale_funds_purchase",
      JSON.stringify(buyerMeta.dependency))
    check("dependency stamped: seller side GATES the buyer side",
      sellerMeta.gates_counterpart === true && sellerMeta.dependency?.blockingStage === "CLOSED")
    check("returned dependency is the sale-funds-purchase gate",
      r.dependency?.gated === true && r.dependency?.reason === "sale_funds_purchase" && r.dependency?.satisfied === false,
      JSON.stringify(r.dependency))

    // The dependency is surfaced as an idempotent portal/agent-visible card.
    check("dependency surfaced (transparency_updates card pushed)", r.dependencyCardPushed === true, String(r.dependencyCardPushed))
    const { count: cardCount } = await svc.from("transparency_updates")
      .select("id", { count: "exact", head: true })
      .eq("contact_id", contactId).eq("update_type", "dual_intent_dependency")
    check("exactly ONE dual_intent_dependency card", (cardCount ?? 0) === 1, `got ${cardCount}`)

    // ── IDEMPOTENT rerun — no duplicate journeys, no duplicate card ───────────
    const r2 = await linkDualJourneys(contactId, svc)
    check("rerun returns linked=true (idempotent)", r2.linked === true, r2.reason)
    const { count: journeyCount2 } = await svc.from("journey_states")
      .select("id", { count: "exact", head: true }).eq("contact_id", contactId)
    check("rerun did NOT duplicate journeys (still 2)", (journeyCount2 ?? 0) === 2, `got ${journeyCount2}`)
    const { count: cardCount2 } = await svc.from("transparency_updates")
      .select("id", { count: "exact", head: true })
      .eq("contact_id", contactId).eq("update_type", "dual_intent_dependency")
    check("rerun did NOT duplicate the dependency card (still 1)", (cardCount2 ?? 0) === 1, `got ${cardCount2}`)

    // ════════════════════════════════════════════════════════════════════════
    // SINGLE-INTENT contact → NO-OP (honest).
    // ════════════════════════════════════════════════════════════════════════
    console.log("\n  ── single-intent contact → no-op ──")
    const { data: soloContact } = await svc.from("contacts").insert({
      brokerage_id: brokerageId, agent_id: agentId,
      first_name: `${TAG}solo`, last_name: "BuyerOnly",
      email: `${TAG}solo@example.com`, contact_type: "buyer", buyer_stage: "searching", status: "active",
    }).select("id").single()
    const soloId = (soloContact as any)?.id as string | undefined
    if (soloId) {
      cleanup.push({ table: "journey_states", column: "contact_id", value: soloId })
      cleanup.push({ table: "property_preferences", column: "contact_id", value: soloId })
      cleanup.push({ table: "transparency_updates", column: "contact_id", value: soloId })
      cleanup.push({ table: "contacts", column: "id", value: soloId })
      // Buyer criteria only — NO listing, so NOT dual.
      await svc.from("property_preferences").insert({ contact_id: soloId, brokerage_id: brokerageId, agent_id: agentId, preferred_price_max: 500000 })

      const solo = await linkDualJourneys(soloId, svc)
      check("single-intent contact → linked=false, reason=not_dual",
        solo.linked === false && solo.reason === "not_dual", JSON.stringify(solo))
      check("single-intent contact_type untouched (stays 'buyer')", solo.contactType === "buyer", String(solo.contactType))
      const { count: soloJourneys } = await svc.from("journey_states")
        .select("id", { count: "exact", head: true }).eq("contact_id", soloId)
      check("single-intent contact got NO journey rows", (soloJourneys ?? 0) === 0, `got ${soloJourneys}`)
    }
  } finally {
    // Reverse-delete teardown.
    for (let i = cleanup.length - 1; i >= 0; i--) {
      const { table, column, value } = cleanup[i]
      try { await svc.from(table).delete().eq(column, value) } catch { /* noop */ }
    }
    let remaining = 0
    for (const { table, column, value } of cleanup) {
      const { count } = await svc.from(table).select("id", { count: "exact", head: true }).eq(column, value)
      remaining += count ?? 0
    }
    check("cleanup verified — 0 seeded rows remain", remaining === 0, `remaining=${remaining}`)
  }
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Dual-Intent Linker (one contact, BOTH journeys — 'must sell to buy') simulator")
  console.log("══════════════════════════════════════════════════")
  testPure()
  await testLive()
  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" ✅ DUAL_INTENT verified — ONE contact carried across BOTH journeys (contact_type='both', two cross-linked journey_states rollups), the sale→buy dependency computed + stamped + surfaced; idempotent + honest no-op on single-intent")
}
main().catch((e) => { console.error(e); process.exit(1) })
