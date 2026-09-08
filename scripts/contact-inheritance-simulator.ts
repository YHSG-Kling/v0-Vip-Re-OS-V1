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
import { readFileSync } from "node:fs"
import { createContactFromLead } from "../lib/contact-promotion/contact-creator"
import { LEAD_DESK_USER_TYPES } from "../lib/auth/lead-visibility"
import { blankComments } from "./strip-comments"

let pass = 0, fail = 0
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; console.log(`  ✗ ${n}`) } }

/**
 * OWNER RULING (2026-09-08, restating CLAUDE.md §5): "agents can't claim leads
 * because they can only see contacts (with access to leads history)."
 *
 * Three properties, none of which the CONVERSION logic above can prove (that
 * proves what a converted contact INHERITS; this proves who may READ the
 * lead-era history afterward):
 *
 *  1. `agent` is NOT in LEAD_DESK_USER_TYPES — an agent cannot read the leads
 *     desk (lib/auth/lead-visibility.ts's resolveLeadVisibility refuses them).
 *  2. The lead-desk roster is UNCHANGED by this lane — every role it admitted
 *     before this lane's build still admits (positive control: a roster that
 *     silently shrank would be as wrong as one that silently grew).
 *  3. The contact-facing lead-history route
 *     (app/api/contacts/[contactId]/lead-history/route.ts) gates on the
 *     GENERIC per-contact/tenant-auth gates (requireAuth +
 *     assertCanActOnContact), NOT on LEAD_DESK_USER_TYPES or any lead-desk
 *     roster — an agent-owned contact must reach it — and its service-client
 *     reads cover every re-pointed history table this lane was asked to wire:
 *     activities, communication_audit_log, isa_outreach_log, assignment_log.
 */
function checkLeadHistoryOnContactSurface(): void {
  console.log("\n[lead history on the contact surface · agent sees it, leads desk stays closed]")

  check("agent is NOT a lead-desk role", !LEAD_DESK_USER_TYPES.has("agent"))

  const KNOWN_LEAD_DESK_ROLES = ["broker", "broker_owner", "admin", "team_lead", "isa"]
  for (const role of KNOWN_LEAD_DESK_ROLES) {
    check(`lead-desk roster still admits '${role}' (unchanged)`, LEAD_DESK_USER_TYPES.has(role))
  }
  check("compliance_officer stays OFF the lead desk (CLAUDE.md §5 + m530)", !LEAD_DESK_USER_TYPES.has("compliance_officer"))

  const routeSrc = blankComments(readFileSync(resolveRoute(), "utf8"))
  check(
    "route gates on requireAuth (generic tenant auth), not a lead-desk roster",
    routeSrc.includes("requireAuth(") && !routeSrc.includes("LEAD_DESK_USER_TYPES") && !routeSrc.includes("resolveLeadVisibility"),
  )
  check(
    "route gates the extended sections with assertCanActOnContact (fail-closed per-contact gate)",
    routeSrc.includes('assertCanActOnContact(contactId, { intent: "read" })'),
  )
  for (const table of ['"activities"', '"communication_audit_log"', '"isa_outreach_log"', '"assignment_log"']) {
    check(`route reads ${table} (a re-pointed/lead-history table this lane was asked to wire)`, routeSrc.includes(table))
  }
  check(
    "route does NOT read leads-desk-only fields (raw_record_id / enrichment_profile / lead_intelligence)",
    !routeSrc.includes("raw_record_id") && !routeSrc.includes("enrichment_profile") && !routeSrc.includes("lead_intelligence"),
  )

  // NEGATIVE CONTROL — a roster/gate this narrow could go green by accident
  // (e.g. every string just happens to be absent from an unrelated file).
  // Prove the finder recognises the defect: a route that DID gate on the
  // lead-desk roster must fail the "generic gate" assertion.
  const decoyRoute = 'import { LEAD_DESK_USER_TYPES } from "@/lib/auth/lead-visibility"\nif (!LEAD_DESK_USER_TYPES.has(userType)) return forbidden()\nrequireAuth(supabase)'
  const decoyStripped = blankComments(decoyRoute)
  check(
    "negative control — a route THAT DOES gate on the lead-desk roster fails the generic-gate assertion",
    !(decoyStripped.includes("requireAuth(") && !decoyStripped.includes("LEAD_DESK_USER_TYPES")),
  )
}

function resolveRoute(): string {
  return `${process.cwd()}/app/api/contacts/[contactId]/lead-history/route.ts`
}

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

  checkLeadHistoryOnContactSurface()

  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ CONTACT_INHERITANCE_FAIL"); process.exit(1) }
  console.log(" ✅ CONTACT_INHERITANCE_PASS — converted contacts inherit the agent's office + team")
}

main().catch((e) => { console.error(e); process.exit(1) })
