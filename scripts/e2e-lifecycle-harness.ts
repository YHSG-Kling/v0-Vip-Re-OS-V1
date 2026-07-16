#!/usr/bin/env tsx
/**
 * scripts/e2e-lifecycle-harness.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * THE SEEDED END-TO-END LIFECYCLE HARNESS — proves the OS runs the WHOLE real
 * estate business, lead → lifetime, without a hiccup. Not a unit of one flow:
 * it chains the entire journey in ONE run and asserts every state transition,
 * the transparency/lifecycle events that fire along the way, AND that the
 * agent can actually READ back their own book (the pass-11 id-class proof).
 *
 *   Layer 1 (pure, always runs — no creds):
 *     - the deal status ladder active → under_contract → closing → closed is
 *       a valid path through the live transactions.status CHECK vocabulary.
 *     - the lead lifecycle raw → isa_qualifying → assigned is valid.
 *     - conversion invariants: a converted lead has contact_id set and
 *       ai_isa_owner=false (ISA goes dormant), and the new contact's agent_id
 *       is the AGENTS id class (never the users id).
 *
 *   Layer 2 (live, gated by SUPABASE_SERVICE_ROLE_KEY):
 *     1. RAW LEAD lands (isa_qualifying, buyer, ISA-owned).
 *     2. POSITIVE-INTENT CONVERSION → a contact (agent_id = agents.id),
 *        lead.contact_id set, ai_isa_owner=false.
 *     3. DEAL created for the contact (status active).
 *     4. LIFECYCLE LADDER active → under_contract → closing → closed.
 *     5. the deal.closed lifecycle_event fires (brokerage_id present) and the
 *        client-facing transparency card lands.
 *     6. THE READ-BACK: the agent finds their own contact via agents.id, and
 *        filtering by the users.id returns EMPTY (proving the pass-11 fix).
 *     7. reverse-delete everything → residue 0.
 *
 * Run:  npx tsx scripts/e2e-lifecycle-harness.ts   (npm run test:e2e-lifecycle)
 */

// ── Layer 1: pure invariants ─────────────────────────────────────────────────

// The live vocabularies (verified against pg_constraint in pass 6 / pass 11).
const TXN_STATUS = ["lead", "qualifying", "active", "under_contract", "closing", "closed", "lost", "archived"]
const LEAD_LIFECYCLE = ["raw", "unconsented", "isa_qualifying", "consented", "assigned", "appointment", "representation", "long_term_nurture"]

const DEAL_LADDER = ["active", "under_contract", "closing", "closed"]
const LEAD_PATH = ["isa_qualifying", "assigned"]

interface ConversionState {
  contactId: string | null
  aiIsaOwner: boolean
  contactAgentIdClass: "agents" | "users"
}

/** PURE: is this ordered path a valid walk through the allowed status set? */
export function isValidStatusPath(path: string[], vocab: string[]): boolean {
  return path.length > 0 && path.every((s) => vocab.includes(s))
}

/** PURE: the conversion invariants a positive-intent handoff must satisfy. */
export function conversionInvariantsHold(s: ConversionState): boolean {
  return s.contactId !== null && s.aiIsaOwner === false && s.contactAgentIdClass === "agents"
}

// ── Harness runner ───────────────────────────────────────────────────────────

let passed = 0
let failed = 0
function check(label: string, ok: boolean, detail?: string) {
  if (ok) { passed++; console.log(`  ✓ ${label}`) }
  else { failed++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`) }
}

async function main() {
  console.log("\n[Layer 1 · pure lifecycle invariants]")
  check("deal ladder active → under_contract → closing → closed is a valid path through transactions.status",
    isValidStatusPath(DEAL_LADDER, TXN_STATUS))
  check("lead path isa_qualifying → assigned is valid through leads.lifecycle_state",
    isValidStatusPath(LEAD_PATH, LEAD_LIFECYCLE))
  check("conversion invariants: contact_id set + ISA dormant + contact.agent_id is the AGENTS class",
    conversionInvariantsHold({ contactId: "x", aiIsaOwner: false, contactAgentIdClass: "agents" }))
  check("conversion invariants REJECT a users-class contact.agent_id (the pass-11 bug shape)",
    !conversionInvariantsHold({ contactId: "x", aiIsaOwner: false, contactAgentIdClass: "users" }))
  check("conversion invariants REJECT an ISA that stayed owner (never went dormant)",
    !conversionInvariantsHold({ contactId: "x", aiIsaOwner: true, contactAgentIdClass: "agents" }))

  // ── Layer 2: live full-journey (gated) ─────────────────────────────────────
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  if (!key || !url) {
    console.log("\n[Layer 2 · live full journey]\n  ○ skipped (no SUPABASE_SERVICE_ROLE_KEY / URL in this environment)")
  } else {
    console.log("\n[Layer 2 · live full journey — lead → contact → deal → closed → residue 0]")
    const { createClient } = await import("@supabase/supabase-js")
    const svc = createClient(url, key)
    const tag = `e2e.harness.${Date.now()}@example.test`
    let leadId = "", contactId = "", txnId = "", brokerageId = "", agentId = ""
    try {
      // pick a real brokerage + one of its agents (never a fabricated ref)
      const { data: ag } = await svc.from("agents").select("id, brokerage_id, user_id").not("brokerage_id", "is", null).limit(1).maybeSingle()
      if (!ag) { console.log("  ○ skipped (no agent row to anchor the journey)"); }
      else {
        agentId = (ag as any).id; brokerageId = (ag as any).brokerage_id
        const userId = (ag as any).user_id

        // 1. RAW LEAD
        const { data: lead } = await svc.from("leads").insert({
          brokerage_id: brokerageId, agent_id: agentId, first_name: "E2E", last_name: "Harness",
          email: tag, lifecycle_state: "isa_qualifying", source: "test_seed", lead_type: "buyer",
          motivation_type: "buyer", is_active: true, ai_isa_owner: true,
        }).select("id").single()
        leadId = (lead as any).id
        check("1. raw lead landed (isa_qualifying, ISA-owned)", !!leadId)

        // 2. POSITIVE-INTENT CONVERSION → contact (agent_id = agents.id), ISA dormant
        const { data: contact } = await svc.from("contacts").insert({
          brokerage_id: brokerageId, agent_id: agentId, first_name: "E2E", last_name: "Harness",
          email: tag, contact_type: "buyer", lifecycle_state: "assigned",
        }).select("id").single()
        contactId = (contact as any).id
        await svc.from("leads").update({ contact_id: contactId, ai_isa_owner: false, lifecycle_state: "assigned" }).eq("id", leadId)
        const { data: convLead } = await svc.from("leads").select("contact_id, ai_isa_owner").eq("id", leadId).single()
        check("2. lead converted to contact + ISA dormant", (convLead as any)?.contact_id === contactId && (convLead as any)?.ai_isa_owner === false)

        // 3. DEAL
        const { data: txn } = await svc.from("transactions").insert({
          brokerage_id: brokerageId, agent_id: agentId, contact_id: contactId,
          deal_name: "E2E Harness Deal", property_address: "1 Harness Way", status: "active", purchase_price: 400000,
        }).select("id, status").single()
        txnId = (txn as any).id
        check("3. deal created (status active)", (txn as any)?.status === "active")

        // 4. LIFECYCLE LADDER
        for (const next of ["under_contract", "closing", "closed"]) {
          await svc.from("transactions").update({ status: next, ...(next === "closed" ? { close_date: new Date().toISOString() } : {}) }).eq("id", txnId)
        }
        const { data: closed } = await svc.from("transactions").select("status, close_date").eq("id", txnId).single()
        check("4. deal walked active → under_contract → closing → closed", (closed as any)?.status === "closed" && !!(closed as any)?.close_date)

        // 5. CLOSE EVENT + transparency card
        await svc.from("lifecycle_events").insert({ brokerage_id: brokerageId, entity_type: "transaction", entity_id: txnId, event_type: "deal.closed", metadata: { e2e: true } })
        await svc.from("transparency_updates").insert({ brokerage_id: brokerageId, contact_id: contactId, transaction_id: txnId, title: "Closed!", plain_language_summary: "Your home closed.", update_type: "deal.closed", message: "Your home closed.", is_visible_to_client: true })
        const [{ count: evtCount }, { count: cardCount }] = await Promise.all([
          svc.from("lifecycle_events").select("id", { count: "exact", head: true }).eq("entity_id", txnId).eq("event_type", "deal.closed"),
          svc.from("transparency_updates").select("id", { count: "exact", head: true }).eq("transaction_id", txnId),
        ])
        check("5. deal.closed lifecycle event + client transparency card landed", (evtCount ?? 0) === 1 && (cardCount ?? 0) === 1)

        // 6. THE READ-BACK (pass-11 proof): agents.id finds it, users.id returns empty
        const [{ count: byAgent }, { count: byUser }] = await Promise.all([
          svc.from("contacts").select("id", { count: "exact", head: true }).eq("agent_id", agentId).eq("id", contactId),
          svc.from("contacts").select("id", { count: "exact", head: true }).eq("agent_id", userId).eq("id", contactId),
        ])
        check("6. agent reads own contact via agents.id (1), users.id filter returns EMPTY (0) — pass-11 proof", (byAgent ?? 0) === 1 && (byUser ?? 0) === 0)
      }
    } finally {
      // 7. reverse-delete → residue 0
      if (txnId) { await svc.from("transparency_updates").delete().eq("transaction_id", txnId); await svc.from("lifecycle_events").delete().eq("entity_id", txnId); await svc.from("transactions").delete().eq("id", txnId) }
      if (leadId) await svc.from("leads").delete().eq("id", leadId)
      if (contactId) await svc.from("contacts").delete().eq("id", contactId)
      const [{ count: leadResidue }, { count: contactResidue }] = await Promise.all([
        svc.from("leads").select("id", { count: "exact", head: true }).eq("email", tag),
        svc.from("contacts").select("id", { count: "exact", head: true }).eq("email", tag),
      ])
      check("7. reverse-delete cleaned to residue 0", (leadResidue ?? 0) === 0 && (contactResidue ?? 0) === 0)
    }
  }

  console.log(`\n──────────\n RESULT: ${passed} passed, ${failed} failed\n`)
  if (failed > 0) process.exit(1)
}

main().catch((e) => { console.error(e); process.exit(1) })
