#!/usr/bin/env tsx
/**
 * scripts/returning-customer-simulator.ts  (npm run test:returning-customer)
 *
 * Proves RETURNING-CUSTOMER RE-ENGAGEMENT WITH MEMORY — the "lifetime" end of the arc. A past
 * client who becomes active again is re-engaged by the right manager WITH the memory of their
 * prior closed deal (role, price band, area, time since close), gated into the approval queue.
 *
 *  - PURE layer (always): lifetime detection, prior-deal summarization, manager routing, and the
 *    memory-aware draft composition.
 *  - LIVE layer (creds-gated, self-cleaning): seeds a lifetime contact + a closed transaction +
 *    a CONTACT reactivation signal, runs the runner, asserts a memory-aware proposal lands from
 *    the Shopping Agent (returning buyer) with the prior deal recalled, that a non-lifetime
 *    contact is skipped, and that a second run dedups. Deletes every tagged row (cleanup == 0).
 */
import { randomUUID } from "node:crypto"
import {
  isReengageableLifetime, monthsSince, priceBand, summarizePriorDeals, reEngagementManager,
  composeReEngagement, audienceForManager, REENGAGE_TAG, type PriorDealTxn,
} from "../lib/kernel/returning-customer"

let pass = 0, fail = 0
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; console.log(`  ✗ ${n}`) } }

function pureLayer(): void {
  console.log("\n[lifetime detection · pure]")
  check("lifecycle_state lifetime_customer ⇒ reengageable", isReengageableLifetime({ id: "1", lifecycle_state: "lifetime_customer" }))
  check("BUYER_CLOSED ⇒ reengageable", isReengageableLifetime({ id: "1", buyer_stage: "BUYER_CLOSED" }))
  check("contact_type past_client ⇒ reengageable", isReengageableLifetime({ id: "1", contact_type: "past_client" }))
  check("withdrawn ⇒ NOT reengageable (consent honored)", !isReengageableLifetime({ id: "1", lifecycle_state: "lifetime_customer", nurture_status: "withdrawn" }))
  check("an active buyer lead ⇒ NOT reengageable", !isReengageableLifetime({ id: "1", buyer_stage: "BUYER_SEARCHING" }))

  console.log("\n[memory · pure]")
  check("monthsSince ~24 for a 2y-old date", Math.abs(monthsSince(new Date(Date.now() - 730 * 86_400_000).toISOString()) - 24) <= 1)
  check("priceBand 480k ⇒ $300–500k", priceBand(480_000) === "the $300–500k range")
  check("priceBand null ⇒ null", priceBand(null) === null)
  const txns: PriorDealTxn[] = [
    { buyer_contact_id: "C", deal_type: "buyer", status: "closed", purchase_price: 480_000, close_date: new Date(Date.now() - 730 * 86_400_000).toISOString(), property_city: "Oak Park", property_state: "IL" },
  ]
  const mem = summarizePriorDeals(txns, "C")
  check("summarizePriorDeals: buyer role, 1 deal, band + area", mem.role === "buyer" && mem.dealCount === 1 && mem.lastPriceBand === "the $300–500k range" && mem.lastArea === "Oak Park, IL")
  check("no closed deals ⇒ unknown role / 0 deals", summarizePriorDeals([{ buyer_contact_id: "C", status: "active" }], "C").dealCount === 0)

  console.log("\n[routing · pure]")
  check("buyer signal ⇒ shopping_agent", reEngagementManager("returning_buyer_criteria_request", mem) === "shopping_agent")
  check("seller signal ⇒ listing_concierge", reEngagementManager("returning_seller_cma_request", mem) === "listing_concierge")
  check("ambiguous signal + buyer memory ⇒ shopping_agent", reEngagementManager("reactivation", mem) === "shopping_agent")
  check("ambiguous signal + unknown memory ⇒ sphere", reEngagementManager("reactivation", summarizePriorDeals([], "C")) === "sphere_of_influence")
  check("audience: shopping_agent ⇒ buyer", audienceForManager("shopping_agent") === "buyer")
  check("audience: listing_concierge ⇒ seller", audienceForManager("listing_concierge") === "seller")

  console.log("\n[composition · pure — the memory recall]")
  const draft = composeReEngagement({ contactName: "James Carter", memory: mem, signalType: "returning_buyer_criteria_request" })
  check("routes to the Shopping Agent for a returning buyer", draft.managerKey === "shopping_agent")
  check("recalls the prior deal in the body (area + band + months)", /Oak Park/.test(draft.body) && /\$300–500k/.test(draft.body) && /month/.test(draft.body))
  check("rationale carries the dedup tag", draft.rationale.startsWith(REENGAGE_TAG))
  check("no-memory contact still gets a clean (generic) draft", !!composeReEngagement({ contactName: "Pat", memory: summarizePriorDeals([], "C"), signalType: "reactivation" }).body)

  // ── signal PROVENANCE (§1.2, 2026-09-04) ───────────────────────────────────
  // signal_reactivations.signal_strength / .signal_data / .isa_reactivated_at
  // were written and read by nobody; the approver saw the signal's name alone.
  // POSITIVE CONTROL: the line must be ABSENT when the facts are absent, so a
  // passing "it renders" check cannot be satisfied by always printing it.
  const withProvenance = composeReEngagement({
    contactName: "James Carter", memory: mem, signalType: "returning_buyer_criteria_request",
    signalStrength: 80, signalData: { source: "inbound_intent", side: "buyer" },
    lastReactivatedAt: new Date(Date.parse("2026-07-01T00:00:00.000Z") - 3 * 86_400_000).toISOString(),
    now: new Date("2026-07-01T00:00:00.000Z"),
  })
  // `check` in this file takes (name, cond) — a third "detail" argument type-checks
  // nowhere and was the one error `tsc --noEmit` caught on integration. The detail
  // prints on failure, which is where it was useful anyway.
  const provenanceOk =
    /strength 80/.test(withProvenance.rationale) &&
    /via inbound_intent/.test(withProvenance.rationale) &&
    /last re-engaged 3 days ago/.test(withProvenance.rationale)
  if (!provenanceOk) console.log(`      rationale was: ${withProvenance.rationale}`)
  check("rationale carries the signal's strength, source and prior re-engagement age", provenanceOk)

  const noInventedProvenance = !/strength|via |last re-engaged/.test(draft.rationale)
  if (!noInventedProvenance) console.log(`      rationale was: ${draft.rationale}`)
  check("POSITIVE CONTROL — no provenance facts ⇒ NO provenance line invented (an absent strength is never printed as a number)",
    noInventedProvenance)
}

async function liveLayer(): Promise<void> {
  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY && !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("\n[returning-customer · live]  ⊘ skipped (no SUPABASE creds) — pure layer proved the logic")
    return
  }
  console.log("\n[returning-customer · live — seed → run → assert → self-clean]")
  const { createServiceClient } = await import("../lib/supabase/service")
  const { runReturningCustomerReengagement } = await import("../lib/kernel/returning-customer")
  const svc = createServiceClient()

  const tag = `rc-sim-${randomUUID().slice(0, 8)}`
  const brokerageId = randomUUID()
  const lifetimeId = randomUUID()
  const regularId = randomUUID()
  const txnId = randomUUID()

  try {
    await svc.from("brokerages").insert({ id: brokerageId, name: `${tag} (returning-customer test)` })
    await svc.from("contacts").insert([
      { id: lifetimeId, brokerage_id: brokerageId, first_name: "James", last_name: tag, lifecycle_state: "lifetime_customer", contact_type: "lifetime_customer" },
      { id: regularId, brokerage_id: brokerageId, first_name: "Active", last_name: tag, lifecycle_state: "unconsented", contact_type: "lead" },
    ])
    await svc.from("transactions").insert({
      id: txnId, brokerage_id: brokerageId, deal_name: `${tag} purchase`, buyer_contact_id: lifetimeId, contact_id: lifetimeId,
      deal_type: "buyer", status: "closed", purchase_price: 480_000,
      close_date: new Date(Date.now() - 730 * 86_400_000).toISOString(), property_city: "Oak Park", property_state: "IL",
    })
    await svc.from("signal_reactivations").insert([
      { contact_id: lifetimeId, brokerage_id: brokerageId, signal_type: "returning_buyer_criteria_request", isa_reactivated: false, triggered_at: new Date().toISOString() },
      { contact_id: regularId, brokerage_id: brokerageId, signal_type: "returning_buyer_criteria_request", isa_reactivated: false, triggered_at: new Date().toISOString() },
    ])

    const r1 = await runReturningCustomerReengagement(brokerageId, {}, svc)
    check("run proposes for the lifetime customer", r1.proposed >= 1)
    check("run skips the non-lifetime contact", r1.skippedNotLifetime >= 1)

    const { data: msg } = await svc.from("agent_client_messages")
      .select("agent_kind, status, rationale, body, audience").eq("recipient_contact_id", lifetimeId).maybeSingle()
    check("proposal from the Shopping Agent, gated (status=proposed)", !!msg && msg.agent_kind === "shopping_agent" && msg.status === "proposed")
    check("proposal recalls the prior deal (Oak Park + band)", !!msg && /Oak Park/.test(msg.body ?? "") && /\$300–500k/.test(msg.body ?? ""))
    check("rationale carries the dedup tag", !!msg && (msg.rationale ?? "").startsWith(REENGAGE_TAG))

    const { data: sig } = await svc.from("signal_reactivations").select("isa_reactivated").eq("contact_id", lifetimeId).maybeSingle()
    check("reactivation signal marked processed", !!sig && sig.isa_reactivated === true)

    // Dedup: a fresh signal in-window must NOT produce a second proposal.
    await svc.from("signal_reactivations").insert({ contact_id: lifetimeId, brokerage_id: brokerageId, signal_type: "returning_buyer_showing_request", isa_reactivated: false, triggered_at: new Date().toISOString() })
    const r2 = await runReturningCustomerReengagement(brokerageId, {}, svc)
    check("second run dedups (no duplicate re-engagement)", r2.deduped >= 1 && r2.proposed === 0)
  } finally {
    await svc.from("agent_client_messages").delete().eq("brokerage_id", brokerageId)
    await svc.from("signal_reactivations").delete().eq("brokerage_id", brokerageId)
    await svc.from("transactions").delete().eq("id", txnId)
    await svc.from("contacts").delete().in("id", [lifetimeId, regularId])
    await svc.from("brokerages").delete().eq("id", brokerageId)
    const { count } = await svc.from("agent_client_messages").select("id", { count: "exact", head: true }).eq("brokerage_id", brokerageId)
    check("cleanup complete — zero tagged rows remain", (count ?? 0) === 0)
  }
}

async function main(): Promise<void> {
  pureLayer()
  await liveLayer()
  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ RETURNING_CUSTOMER_FAIL"); process.exit(1) }
  console.log(" ✅ RETURNING_CUSTOMER_PASS — past clients are re-engaged with prior-deal memory by the right manager")
}

main().catch((e) => { console.error(e); process.exit(1) })
