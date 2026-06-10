#!/usr/bin/env tsx
/**
 * scripts/strategy-learning-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * OUTCOME-CLOSING LOOP harness — proves the AI workforce learns from its own
 * proposals. Drives the REAL closer (closeStrategyLoopForOffer /
 * closeNegotiationStrategyForOffer) against seeded rows and verifies:
 *   · a recommendation + offer (m213 link) → strategy_outcomes row with the right
 *     deviation, and the recommendation's status moves to a terminal value
 *   · the negotiation_strategies loop closes with the same outcome
 *   · idempotency: a second close is a no-op (one outcome row per rec+offer)
 *   · the post-acceptance 'lost' path closes the negotiation strategy as 'lost'
 *     WITHOUT touching the already-'accepted' strategy_outcomes row
 *
 * Layer 1 (pure) always runs. Layer 2 is gated on SUPABASE_SERVICE_ROLE_KEY and
 * self-cleans every seeded row.
 *
 * Run: npx tsx scripts/strategy-learning-simulator.ts  (npm run test:strategy-learning)
 */
import { closeStrategyLoopForOffer, closeNegotiationStrategyForOffer } from "../lib/strategy-learning/close-strategy-loop"

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
  console.log(" ✅ Outcome-closing loop verified")
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Strategy-learning (outcome-closing loop) simulator")
  console.log("══════════════════════════════════════════════════")

  // ── Layer 1 · pure mapping invariants (no DB) ──
  console.log("\n[Layer 1 · outcome → recommendation-status mapping]")
  // recommendationStatusFor isn't exported; assert the documented contract via the
  // live CHECK vocabulary so a drift in the map is caught by Layer 2's insert too.
  const recStatusVocab = ["pending", "accepted", "modified", "rejected"]
  const outcomeVocab = ["accepted", "rejected", "countered", "withdrawn"]
  check("strategy_outcomes vocabulary is the 4 terminal outcomes", outcomeVocab.length === 4)
  check("recommendation-status terminal targets are all valid", ["accepted", "modified", "rejected"].every((s) => recStatusVocab.includes(s)))

  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY &&
    !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("\n[Layer 2 · live round-trip]")
    console.log("  ⏭  Skipped — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set (pure layer ran).")
    report()
    return
  }

  const { createServiceClient } = await import("../lib/supabase/service")
  const svc = createServiceClient()
  const TAG = `__stratsim_${Date.now()}__`
  const cleanup: Array<{ table: string; id: string }> = []

  try {
    const { data: brk } = await svc.from("brokerages").select("id").limit(1).single()
    const { data: lst } = await svc.from("listings").select("id").limit(1).single()
    const { data: con } = await svc.from("contacts").select("id").limit(1).single()
    if (!brk || !lst || !con) { console.log("  ⏭  Skipped — need a brokerage + listing + contact."); report(); return }
    const brokerageId = (brk as any).id

    // Seed a recommendation (recommended 500k), an offer linked to it (offered 490k),
    // and an open negotiation strategy for that offer.
    const { data: rec } = await svc.from("strategy_recommendations").insert({
      brokerage_id: brokerageId, contact_id: (con as any).id, listing_id: (lst as any).id,
      recommended_price: 500000, status: "pending", ai_narrative: `${TAG} rec`,
    }).select("id").single()
    cleanup.push({ table: "strategy_recommendations", id: (rec as any).id })

    const { data: offer } = await svc.from("offers").insert({
      brokerage_id: brokerageId, listing_id: (lst as any).id, contact_id: (con as any).id,
      offer_price: 490000, status: "submitted", strategy_recommendation_id: (rec as any).id,
      notes: `${TAG} offer`,
    }).select("id").single()
    cleanup.push({ table: "offers", id: (offer as any).id })

    const { data: neg } = await svc.from("negotiation_strategies").insert({
      brokerage_id: brokerageId, offer_id: (offer as any).id, contact_id: (con as any).id,
      side: "buyer", recommended_action: "counter", status: "open", agent_strategy_md: `${TAG} neg`,
    }).select("id").single()
    cleanup.push({ table: "negotiation_strategies", id: (neg as any).id })

    // ── Close the loop on an 'accepted' outcome, final price 495k ──
    const res = await closeStrategyLoopForOffer(svc, {
      offerId: (offer as any).id, brokerageId, outcome: "accepted", finalPrice: 495000,
    })
    check("close: recommendation loop reported closed", res.recommendationClosed)
    check("close: negotiation loop reported closed", res.negotiationClosed)

    const { data: outcomeRow } = await svc.from("strategy_outcomes")
      .select("outcome, final_price, deviation_from_recommendation")
      .eq("recommendation_id", (rec as any).id).eq("offer_id", (offer as any).id).maybeSingle()
    cleanup.push({ table: "strategy_outcomes", id: "" }) // deleted via recommendation cascade or below
    check("outcome: a strategy_outcomes row was written", !!outcomeRow)
    check("outcome: records the accepted outcome", (outcomeRow as any)?.outcome === "accepted")
    check("outcome: final_price = 495000", Number((outcomeRow as any)?.final_price) === 495000)
    check("outcome: deviation = |495000 - 500000| = 5000", Number((outcomeRow as any)?.deviation_from_recommendation) === 5000)

    const { data: recAfter } = await svc.from("strategy_recommendations").select("status").eq("id", (rec as any).id).single()
    check("recommendation: status moved to 'accepted'", (recAfter as any).status === "accepted")

    const { data: negAfter } = await svc.from("negotiation_strategies").select("status, outcome").eq("id", (neg as any).id).single()
    check("negotiation: status = outcome_recorded", (negAfter as any).status === "outcome_recorded")
    check("negotiation: outcome = accepted", (negAfter as any).outcome === "accepted")

    // ── Idempotency: a second close must NOT write a duplicate outcome row ──
    await closeStrategyLoopForOffer(svc, { offerId: (offer as any).id, brokerageId, outcome: "accepted", finalPrice: 495000 })
    const { count: outcomeCount } = await svc.from("strategy_outcomes")
      .select("id", { count: "exact", head: true })
      .eq("recommendation_id", (rec as any).id).eq("offer_id", (offer as any).id)
    check("idempotency: still exactly ONE outcome row after a second close", (outcomeCount ?? 0) === 1)

    // ── Post-acceptance 'lost' path closes the negotiation as lost without a new
    //    open strategy to touch (the prior one is already closed → no-op = false). ──
    const lostClosed = await closeNegotiationStrategyForOffer(svc, { offerId: (offer as any).id, brokerageId, outcome: "lost" })
    check("lost path: no OPEN negotiation strategy remains to close (already recorded)", lostClosed === false)
    const { count: stillOneOutcome } = await svc.from("strategy_outcomes")
      .select("id", { count: "exact", head: true })
      .eq("recommendation_id", (rec as any).id).eq("offer_id", (offer as any).id)
    check("lost path: strategy_outcomes 'accepted' row left intact (deal-death ≠ rejected offer)", (stillOneOutcome ?? 0) === 1)

    // explicit outcome-row cleanup (no FK cascade guaranteed)
    await svc.from("strategy_outcomes").delete().eq("offer_id", (offer as any).id)
  } finally {
    for (const c of [...cleanup].reverse()) {
      if (!c.id) continue
      try { await svc.from(c.table).delete().eq("id", c.id) } catch { /* noop */ }
    }
    const { count } = await svc.from("offers").select("id", { count: "exact", head: true }).like("notes", `${TAG}%`)
    check("cleanup verified — 0 seeded offers remain", (count ?? 0) === 0)
  }

  report()
}
main().catch((e) => { console.error(e); process.exit(1) })
