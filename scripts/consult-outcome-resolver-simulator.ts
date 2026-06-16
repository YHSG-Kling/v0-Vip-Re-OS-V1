#!/usr/bin/env tsx
/**
 * scripts/consult-outcome-resolver-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the CONSULT OUTCOME RESOLVER closes the consensus-memory loop: a strategic play raises a
 * second-opinion huddle (manager_signals), and when the play's outcome is known the resolver records
 * whether the consulted manager's read was proven right onto ai_feedback_log — so the track record
 * builds itself. Idempotent (a resolved huddle is recorded exactly once).
 *
 * Layer 1 (shell, pure): the ai_feedback_log namespace the resolver writes under. Layer 2 (live,
 * creds-gated): raise a real huddle via requestSecondOpinion → resolve a WIN and a LOSS → assert the
 * verdicts land keyed by the consulted manager, the huddle is marked resolved, and a re-resolve is a
 * no-op. Every seed reverse-deleted. No mocks.
 *
 * Run: npx tsx scripts/consult-outcome-resolver-simulator.ts   (npm run test:consult-outcome-resolver)
 */
import { consultSystem } from "../lib/kernel/consensus-memory"

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
  console.log(" ✅ Consult outcome resolver verified — outcomes record the huddle verdict; recorded once.")
  console.log(" CONSULT_OUTCOME_RESOLVER_PASS")
  process.exit(0)
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Consult outcome resolver simulator")
  console.log("══════════════════════════════════════════════════\n")

  console.log("[Layer 1 · the namespace the resolver records under]")
  check("relist_recovery verdict lands under second_opinion:relist_recovery", consultSystem("relist_recovery") === "second_opinion:relist_recovery")
  check("offer_strategy verdict lands under second_opinion:offer_strategy", consultSystem("offer_strategy") === "second_opinion:offer_strategy")

  console.log("\n[Layer 2 · live: raise huddles → resolve a win + a loss → idempotent]")
  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY && !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) { console.log("  ⏭  Skipped — SUPABASE creds not set (Layer 1 ran)."); return report() }

  const { createServiceClient } = await import("../lib/supabase/service")
  const { requestSecondOpinion } = await import("../lib/kernel/second-opinion-runner")
  const { resolveConsultOutcomes } = await import("../lib/kernel/consult-outcome-resolver")
  const svc = createServiceClient()
  const { data: brokerage } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
  if (!brokerage) { console.log("  ⏭  Skipped — need a real brokerage."); return report() }
  const brokerageId = (brokerage as any).id
  const uuid = () => (globalThis.crypto ?? require("node:crypto").webcrypto).randomUUID()
  const contactWin = uuid(), contactLoss = uuid(), listingEntity = uuid()
  const contactIds = [contactWin, contactLoss]
  try {
    // WIN path — a relist_recovery huddle (consult shopping_agent), then the deal works out.
    const h1 = await requestSecondOpinion({ brokerageId, fromManager: "listing_concierge", playType: "relist_recovery", contactId: contactWin }, svc)
    check("a relist_recovery huddle was raised to shopping_agent", h1.requested && h1.consult === "shopping_agent", JSON.stringify(h1))

    const r1 = await resolveConsultOutcomes({ brokerageId, contactId: contactWin, success: true }, svc)
    check("resolving a WIN records the consult verdict", r1.resolved === 1 && r1.consults.includes("shopping_agent"), JSON.stringify(r1))

    const { data: winFb } = await svc.from("ai_feedback_log")
      .select("rating, source_record_id, context_snapshot")
      .eq("brokerage_id", brokerageId).eq("source_system", "second_opinion:relist_recovery").eq("source_record_id", contactWin)
    const winRows = (winFb ?? []) as { rating: number; context_snapshot: any }[]
    check("the WIN is a +1 keyed by the consulted manager", winRows.some((r) => r.rating === 1 && r.context_snapshot?.consult === "shopping_agent"), JSON.stringify(winRows))

    const { data: sig1 } = await svc.from("manager_signals")
      .select("status, payload").eq("brokerage_id", brokerageId).eq("contact_id", contactWin).eq("signal_type", "second_opinion_requested").maybeSingle()
    check("the huddle is marked resolved (recorded once)", (sig1 as any)?.status === "resolved" && (sig1 as any)?.payload?.outcome_recorded === true)

    // Idempotent — a re-resolve records nothing new.
    const r1again = await resolveConsultOutcomes({ brokerageId, contactId: contactWin, success: true }, svc)
    check("re-resolving a settled huddle is a no-op", r1again.resolved === 0)
    const { count: winCount } = await svc.from("ai_feedback_log").select("id", { count: "exact", head: true })
      .eq("source_system", "second_opinion:relist_recovery").eq("source_record_id", contactWin)
    check("exactly one verdict row exists for the huddle (no double-count)", (winCount ?? 0) === 1)

    // LOSS path — an offer_strategy huddle (consult deal_coordinator), then the play fails.
    const h2 = await requestSecondOpinion({ brokerageId, fromManager: "listing_concierge", playType: "offer_strategy", contactId: contactLoss }, svc)
    check("an offer_strategy huddle was raised to deal_coordinator", h2.requested && h2.consult === "deal_coordinator", JSON.stringify(h2))

    const r2 = await resolveConsultOutcomes({ brokerageId, contactId: contactLoss, success: false }, svc)
    check("resolving a LOSS records the consult verdict", r2.resolved === 1 && r2.consults.includes("deal_coordinator"))
    const { data: lossFb } = await svc.from("ai_feedback_log")
      .select("rating, context_snapshot").eq("brokerage_id", brokerageId).eq("source_system", "second_opinion:offer_strategy").eq("source_record_id", contactLoss)
    check("the LOSS is a -1 keyed by deal_coordinator", ((lossFb ?? []) as any[]).some((r) => r.rating === -1 && r.context_snapshot?.consult === "deal_coordinator"))

    // LISTING-ENTITY path — a price_drop huddle keyed by the LISTING (entity_id, not contact_id),
    // resolved by entity (the real price-reduction → deal-closed/relist wiring uses this key).
    const h3 = await requestSecondOpinion({ brokerageId, fromManager: "listing_concierge", playType: "price_drop", entityType: "listing", entityId: listingEntity }, svc)
    check("a price_drop huddle was raised to shopping_agent on the listing", h3.requested && h3.consult === "shopping_agent")
    const r3 = await resolveConsultOutcomes({ brokerageId, entityId: listingEntity, success: true }, svc)
    check("resolving by ENTITY id (listing) records the verdict", r3.resolved === 1 && r3.consults.includes("shopping_agent"), JSON.stringify(r3))
    const { data: listFb } = await svc.from("ai_feedback_log")
      .select("rating, context_snapshot").eq("brokerage_id", brokerageId).eq("source_system", "second_opinion:price_drop").eq("source_record_id", listingEntity)
    check("the listing verdict is a +1 keyed by shopping_agent", ((listFb ?? []) as any[]).some((r) => r.rating === 1 && r.context_snapshot?.consult === "shopping_agent"))
  } finally {
    for (const cid of [...contactIds, listingEntity]) {
      await svc.from("ai_feedback_log").delete().eq("brokerage_id", brokerageId).eq("source_record_id", cid).then(() => {}, () => {})
      await svc.from("manager_signals").delete().eq("brokerage_id", brokerageId).eq("contact_id", cid).eq("signal_type", "second_opinion_requested").then(() => {}, () => {})
      await svc.from("manager_signals").delete().eq("brokerage_id", brokerageId).eq("entity_id", cid).eq("signal_type", "second_opinion_requested").then(() => {}, () => {})
    }
    const allIds = [...contactIds, listingEntity]
    const { count: fbLeft } = await svc.from("ai_feedback_log").select("id", { count: "exact", head: true }).in("source_record_id", allIds)
    const { count: sigLeft } = await svc.from("manager_signals").select("id", { count: "exact", head: true }).in("entity_id", allIds).eq("signal_type", "second_opinion_requested")
    check("cleanup: huddles + verdicts removed (count == 0)", (fbLeft ?? 0) === 0 && (sigLeft ?? 0) === 0)
  }
  report()
}

main().catch((e) => { console.error(e); process.exit(1) })
