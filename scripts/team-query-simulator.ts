#!/usr/bin/env tsx
/**
 * scripts/team-query-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * "HEY TEAM—" harness — the bullpen question: ask about a person, every manager
 * answers with what its OWN tables know, one manager-attributed spoken reply.
 *
 * Layer 1 (pure): matchContactByName (exact > last/first > prefix; "the Hendersons"
 *   strips article + plural); composeTeamAnswer (manager-attributed; honest empty).
 * Layer 2 (live, gated): seed a contact with a FOUR-manager footprint (saved home,
 *   live deal with a deadline, pending gate proposal, bus signal), run runTeamQuery,
 *   assert contributions arrive from ≥3 distinct managers with real facts, the
 *   spoken answer attributes by manager label, an unknown name is honest, and the
 *   query is READ-ONLY (writes nothing). Self-cleans.
 *
 * Run: npx tsx scripts/team-query-simulator.ts  (npm run test:team-query)
 */
import { matchContactByName, composeTeamAnswer, runTeamQuery } from "../lib/kernel/team-query"

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
  console.log(" ✅ Hey team— (team query) verified")
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Hey team— (team query) simulator")
  console.log("══════════════════════════════════════════════════")

  console.log("\n[Layer 1 · match + compose]")
  const contacts = [
    { id: "1", first_name: "Jordan", last_name: "Henderson" },
    { id: "2", first_name: "Hendrik", last_name: "Olsen" },
    { id: "3", first_name: "Sam", last_name: "Jordan" },
  ]
  check("'the Hendersons' → Jordan Henderson (article + plural stripped)", matchContactByName(contacts, "the Hendersons")?.id === "1")
  check("'Jordan Henderson' full-name beats partials", matchContactByName(contacts, "Jordan Henderson")?.id === "1")
  check("'Jordan' prefers exact first/last over prefix", ["1", "3"].includes(matchContactByName(contacts, "Jordan")?.id ?? ""))
  check("unknown name → null (no fuzzy fabrication)", matchContactByName(contacts, "Smith") === null)

  const spoken = composeTeamAnswer("Jordan Henderson", [
    { manager: "shopping_agent", line: "they've saved 3 homes." },
    { manager: "deal_coordinator", line: "their deal is under contract." },
  ])
  check("answer: attributed by manager LABEL", spoken.includes("Shopping Agent:") && spoken.includes("Deal Coordinator:"))
  const empty = composeTeamAnswer("Sam", [])
  check("answer: empty team is HONEST (nothing fabricated)", empty.includes("nothing on Sam yet"))

  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY &&
    !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) {
    console.log("\n[Layer 2 · live bullpen]")
    console.log("  ⏭  Skipped — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set (pure layer ran).")
    report()
    return
  }

  const { createServiceClient } = await import("../lib/supabase/service")
  const svc = createServiceClient()
  const TAG = `Teamq${Date.now()}`
  const cleanup: Array<{ table: string; id: string }> = []

  try {
    const { data: agent } = await svc.from("agents").select("id, user_id, brokerage_id").not("user_id", "is", null).not("brokerage_id", "is", null).limit(1).single()
    if (!agent) { console.log("  ⏭  Skipped — need an agent."); report(); return }
    const brokerageId = (agent as any).brokerage_id

    // A contact with a FOUR-manager footprint.
    const { data: con } = await svc.from("contacts").insert({
      brokerage_id: brokerageId, first_name: "Avery", last_name: TAG, contact_type: "buyer",
      intent_score: 88, engagement_score: 75,
    }).select("id").single()
    cleanup.push({ table: "contacts", id: (con as any).id })
    const { data: sp } = await svc.from("saved_properties").insert({
      brokerage_id: brokerageId, contact_id: (con as any).id, user_id: (agent as any).user_id,
      property_address: "44 Birch Lane", dismissed: false,
    }).select("id").single()
    cleanup.push({ table: "saved_properties", id: (sp as any).id })
    const { data: txn } = await svc.from("transactions").insert({
      brokerage_id: brokerageId, deal_name: `${TAG} 44 Birch Lane`, status: "under_contract",
      stage: "FINANCING_PENDING", buyer_contact_id: (con as any).id, agent_id: (agent as any).id,
      financing_deadline: new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10),
    }).select("id").single()
    cleanup.push({ table: "transactions", id: (txn as any).id })
    const { data: prop } = await svc.from("agent_client_messages").insert({
      brokerage_id: brokerageId, agent_kind: "shopping_agent", entity_type: "contact", audience: "buyer",
      channel: "portal", recipient_contact_id: (con as any).id, subject: `${TAG} tour recap`,
      body: "Recap of the homes we walked.", status: "proposed", proposed_at: new Date().toISOString(),
    }).select("id").single()
    cleanup.push({ table: "agent_client_messages", id: (prop as any).id })
    const { data: sig } = await svc.from("manager_signals").insert({
      brokerage_id: brokerageId, from_manager: "ai_isa", to_manager: "shopping_agent",
      signal_type: "note", message: `${TAG} booked Thursday on a dial call.`, contact_id: (con as any).id,
    }).select("id").single()
    cleanup.push({ table: "manager_signals", id: (sig as any).id })

    const before = await svc.from("notifications").select("id", { count: "exact", head: true }).eq("brokerage_id", brokerageId)

    const tq = await runTeamQuery(brokerageId, TAG, {}, svc)
    check("bullpen: contact found by last name", tq.found && tq.contactName === `Avery ${TAG}`)
    const managers = new Set(tq.contributions.map((x) => x.manager))
    check(`bullpen: ≥3 distinct managers answered (got ${managers.size})`, managers.size >= 3)
    check("Shopping Agent: the saved home, by address", tq.spoken.includes("44 Birch Lane"))
    check("Deal Coordinator: the live deal + next deadline", tq.spoken.includes("financing pending") && /next deadline \d{4}-\d{2}-\d{2}/.test(tq.spoken))
    check("Campaign Orchestrator: the pending gate approval", tq.spoken.includes("waiting on your approval"))
    check("the bus: the managers' own talk relayed", tq.spoken.includes("booked Thursday on a dial call"))
    check("AI ISA: propensity read present", tq.contributions.some((x) => x.manager === "ai_isa"))

    const unknown = await runTeamQuery(brokerageId, "Zzyzx Nonexistent", {}, svc)
    check("unknown person: honest answer, no fabricated contact", !unknown.found && unknown.spoken.includes("nobody has a contact matching"))

    // READ-ONLY proof: the team reported without writing anything.
    const after = await svc.from("notifications").select("id", { count: "exact", head: true }).eq("brokerage_id", brokerageId)
    check("read-only: the query wrote zero notifications", (after.count ?? 0) === (before.count ?? 0))
  } finally {
    for (const c of [...cleanup].reverse()) {
      try { await svc.from(c.table).delete().eq("id", c.id) } catch { /* noop */ }
    }
    const { count } = await svc.from("contacts").select("id", { count: "exact", head: true }).eq("last_name", TAG)
    check("cleanup verified — 0 seeded contacts remain", (count ?? 0) === 0)
  }

  report()
}
main().catch((e) => { console.error(e); process.exit(1) })
