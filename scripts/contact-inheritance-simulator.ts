#!/usr/bin/env tsx
/**
 * scripts/contact-inheritance-simulator.ts  (npm run test:contact-inheritance)
 *
 * Proves the canonical lead→contact converter stamps the assigned agent's OFFICE + TEAM onto the new
 * contact, so converted contacts roll up to the right location/team in scoped reporting and the
 * command center (before this they landed with location_id/team_id = null and a location admin's CRM
 * silently excluded them).
 *
 * Pure + deterministic: createContactFromLead takes an injectable `supabase`, so a mock client returns
 * the agent's office/team and captures the exact row inserted into contacts — no DB, always runs.
 */
import { createContactFromLead } from "../lib/contact-promotion/contact-creator"

let pass = 0, fail = 0
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; console.log(`  ✗ ${n}`) } }

/** Minimal chainable mock: agents lookups return `agentRow`; contacts.insert captures the row. */
function mockSupabase(agentRow: { location_id: string | null; team_id: string | null } | null, captured: { contact?: any }) {
  const make = (table: string) => {
    const b: any = {
      select: () => b,
      eq: () => b,
      insert: (row: any) => { captured.contact = row; return b },
      maybeSingle: async () => ({ data: table === "agents" ? agentRow : null, error: null }),
      single: async () => ({ data: { id: "contact-1" }, error: null }),
    }
    return b
  }
  return { from: (t: string) => make(t) }
}

const baseLead = { first_name: "Dana", last_name: "Buyer", email: "dana@demo.local", phone: "+15125550100", source: "web_form", motivation_type: "buyer" }

async function main(): Promise<void> {
  console.log("\n[contact inheritance · pure — converted contact inherits the agent's office + team]")

  // Agent sits in Office A / Team 1 → the contact inherits both.
  const cap1: { contact?: any } = {}
  const res1 = await createContactFromLead(
    mockSupabase({ location_id: "OFFICE_A", team_id: "TEAM_1" }, cap1),
    { leadId: "lead-1", lead: baseLead, agentId: "agent-1", brokerageId: "brk-1" },
  )
  check("returns the new contactId", res1.contactId === "contact-1")
  check("contact inherits agent.location_id (rolls up to the office)", cap1.contact?.location_id === "OFFICE_A")
  check("contact inherits agent.team_id (rolls up to the team)", cap1.contact?.team_id === "TEAM_1")
  check("agent_id stamped as agents.id (CRM visibility contract)", cap1.contact?.agent_id === "agent-1")
  check("brokerage_id carried", cap1.contact?.brokerage_id === "brk-1")

  // Single-office agent with no team → no fabrication, both null.
  const cap2: { contact?: any } = {}
  await createContactFromLead(
    mockSupabase({ location_id: null, team_id: null }, cap2),
    { leadId: "lead-2", lead: baseLead, agentId: "agent-2", brokerageId: "brk-1" },
  )
  check("no office/team on the agent → null (no fabricated scope)", cap2.contact?.location_id === null && cap2.contact?.team_id === null)

  // Missing agent row entirely → still null, no throw.
  const cap3: { contact?: any } = {}
  const res3 = await createContactFromLead(
    mockSupabase(null, cap3),
    { leadId: "lead-3", lead: baseLead, agentId: "agent-x", brokerageId: "brk-1" },
  )
  check("missing agent row → contact still created, scope null", res3.contactId === "contact-1" && cap3.contact?.location_id === null)

  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ CONTACT_INHERITANCE_FAIL"); process.exit(1) }
  console.log(" ✅ CONTACT_INHERITANCE_PASS — converted contacts inherit the agent's office + team")
}

main().catch((e) => { console.error(e); process.exit(1) })
