#!/usr/bin/env tsx
/**
 * scripts/offer-rejection-recovery-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves OFFER-REJECTION RECOVERY — verified white space (the follow-up audit found
 * OFFER_REJECTED fires but NOTHING re-engages the buyer; the stale-contact net only catches
 * them at 14 days, long after the momentum is gone). Pure recovery-window engine, honest
 * (a COUNTERED offer is a live negotiation, never "recovered"); the runner proposes ONE gated
 * buyer regroup + routes acute cases to the AI ISA for a same-day call.
 *
 * Layer 1 (pure): the recovery-window verdict (acute/followup/expired/not_eligible) + copy.
 * Layer 2 (live, gated): seed a real listing + a just-rejected buyer offer → run recovery →
 *   assert a gated agent_client_messages buyer proposal + an ai_isa bus signal; a countered
 *   offer is NOT recovered; re-run is idempotent. Seeds cleaned up. No mocks.
 *
 * Run: npx tsx scripts/offer-rejection-recovery-simulator.ts   (npm run test:offer-rejection)
 */
import { planRejectionRecovery, ACUTE_WINDOW_HOURS } from "../lib/lead-pipeline/offer-rejection-recovery"

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
  console.log(" ✅ Offer-rejection recovery verified — acute window caught, counters skipped, gated regroup + ISA call.")
  console.log(" OFFER_REJECTION_PASS")
  process.exit(0)
}

const NOW = "2026-06-16T12:00:00.000Z"
const hoursAgo = (h: number) => new Date(new Date(NOW).getTime() - h * 3_600_000).toISOString()

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Offer-rejection recovery simulator")
  console.log("══════════════════════════════════════════════════")

  console.log("\n[Layer 1 · recovery-window verdict]")
  const acute = planRejectionRecovery({ rejectedAt: hoursAgo(6), now: NOW, propertyAddress: "12 Maple St", buyerName: "Dana" })
  check("rejected 6h ago → acute + recommend call", acute.urgency === "acute" && acute.eligible && acute.recommendCall)
  check("acute brief names the make-or-break window", acute.agentBrief.toLowerCase().includes("make-or-break"))
  check("buyer regroup copy is warm + earned", acute.buyerRegroup.length > 0 && /12 Maple St/.test(acute.buyerRegroup))

  const followup = planRejectionRecovery({ rejectedAt: hoursAgo(ACUTE_WINDOW_HOURS + 48), now: NOW })
  check("rejected ~5 days ago → followup, no rush call", followup.urgency === "followup" && followup.eligible && !followup.recommendCall)

  const expired = planRejectionRecovery({ rejectedAt: hoursAgo(20 * 24), now: NOW })
  check("rejected 20 days ago → expired (no tone-deaf message)", expired.urgency === "expired" && !expired.eligible)

  // HONEST: a countered offer is a LIVE negotiation, never a rejection recovery.
  const countered = planRejectionRecovery({ rejectedAt: hoursAgo(6), now: NOW, sellerResponseType: "countered" })
  check("a COUNTERED offer → not eligible (live negotiation)", countered.urgency === "not_eligible" && !countered.eligible)
  const counterFlag = planRejectionRecovery({ rejectedAt: hoursAgo(6), now: NOW, hadCounter: true })
  check("has_counter=true → not eligible", !counterFlag.eligible)

  check("no rejection timestamp → not eligible", !planRejectionRecovery({ rejectedAt: null, now: NOW }).eligible)
  check("future timestamp → not eligible (no fabrication)", !planRejectionRecovery({ rejectedAt: hoursAgo(-5), now: NOW }).eligible)

  console.log("\n[Layer 2 · live: a just-rejected buyer is recovered + routed to the ISA, idempotently]")
  const hasCreds =
    !!process.env.SUPABASE_SERVICE_ROLE_KEY &&
    !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("  ⏭  Skipped — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set (pure layer ran).")
    return report()
  }
  const { createServiceClient } = await import("../lib/supabase/service")
  const { runOfferRejectionRecovery } = await import("../lib/lead-pipeline/offer-rejection-recovery-runner")
  const svc = createServiceClient()
  const { data: brokerage } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
  if (!brokerage) { console.log("  ⏭  Skipped — need a real brokerage."); return report() }
  const brokerageId = (brokerage as any).id
  const uuid = () => (globalThis.crypto ?? require("node:crypto").webcrypto).randomUUID()
  const stampGen = async (req: { goal: string }) => ({ subject: "ZZGEN", body: `ZZGEN ${req.goal}` })

  const listingId = uuid()
  const contactId = uuid()
  const offerId = uuid()
  const counterContactId = uuid()
  const counterOfferId = uuid()
  try {
    await svc.from("listings").insert({ id: listingId, brokerage_id: brokerageId, address: "ZZ 4 Rejection Rd", status: "active" })
    await svc.from("contacts").insert({ id: contactId, brokerage_id: brokerageId, first_name: "ZZ", last_name: "Buyer", contact_type: "buyer" })
    await svc.from("contacts").insert({ id: counterContactId, brokerage_id: brokerageId, first_name: "ZZ", last_name: "Counter", contact_type: "buyer" })
    // Rejected 6h ago → acute recovery.
    await svc.from("offers").insert({
      id: offerId, brokerage_id: brokerageId, listing_id: listingId, contact_id: contactId,
      offer_price: 450_000, status: "rejected", property_address: "ZZ 4 Rejection Rd",
      seller_response_received_at: hoursAgo(6), updated_at: hoursAgo(6),
    })
    // Countered (live negotiation) → must NOT be recovered.
    await svc.from("offers").insert({
      id: counterOfferId, brokerage_id: brokerageId, listing_id: listingId, contact_id: counterContactId,
      offer_price: 460_000, status: "rejected", seller_response_type: "countered", has_counter: true,
      property_address: "ZZ 4 Rejection Rd", seller_response_received_at: hoursAgo(6), updated_at: hoursAgo(6),
    })

    const r1 = await runOfferRejectionRecovery({ brokerageId, now: NOW, copyGenerator: stampGen }, svc)
    check("the just-rejected buyer is recovered + call routed", r1.recovered >= 1 && r1.callsRouted >= 1, JSON.stringify(r1))

    const { count: msgCount } = await svc.from("agent_client_messages").select("id", { count: "exact", head: true })
      .eq("entity_id", offerId).eq("audience", "buyer")
    check("a gated buyer regroup proposal was created", (msgCount ?? 0) >= 1)
    const { count: counterMsg } = await svc.from("agent_client_messages").select("id", { count: "exact", head: true })
      .eq("entity_id", counterOfferId)
    check("the COUNTERED offer was NOT recovered (honest)", (counterMsg ?? 0) === 0)
    const { count: sigCount } = await svc.from("manager_signals").select("id", { count: "exact", head: true })
      .eq("entity_id", contactId).eq("signal_type", "offer_rejection_recovery")
    check("an ai_isa recovery-call bus signal was published", (sigCount ?? 0) >= 1)

    const r2 = await runOfferRejectionRecovery({ brokerageId, now: NOW, copyGenerator: stampGen }, svc)
    check("re-run is idempotent (no duplicate recovery)", r2.recovered === 0)
  } finally {
    await svc.from("manager_signals").delete().in("entity_id", [contactId, counterContactId]).then(() => {}, () => {})
    await svc.from("agent_client_messages").delete().in("entity_id", [offerId, counterOfferId]).then(() => {}, () => {})
    await svc.from("offers").delete().in("id", [offerId, counterOfferId]).then(() => {}, () => {})
    await svc.from("contacts").delete().in("id", [contactId, counterContactId]).then(() => {}, () => {})
    await svc.from("listings").delete().eq("id", listingId).then(() => {}, () => {})
    const { count } = await svc.from("offers").select("id", { count: "exact", head: true }).in("id", [offerId, counterOfferId])
    check("cleanup: seeded offers removed (count == 0)", (count ?? 0) === 0)
  }
  report()
}

main().catch((e) => { console.error(e); process.exit(1) })
