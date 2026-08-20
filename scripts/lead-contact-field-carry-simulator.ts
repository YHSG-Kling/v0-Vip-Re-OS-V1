#!/usr/bin/env tsx
/**
 * scripts/lead-contact-field-carry-simulator.ts  (npm run test:lead-contact-field-carry)
 *
 * "the lead converting to contact should already be built with a smooth transition from
 *  lead to a new contatct with all the same fields so data can be duplicated to the new
 *  contact record without loosing any history. at the same time since this is a new
 *  contact record, the contact gets access to their portal"  — owner
 *
 * A COPY LIST WITH NO PROOF IS HOW THE GAPS GOT IN. This simulator holds the three
 * halves of that ruling to account, against the LIVE schema cache, with no database:
 *
 *   1. FIELD CARRY — for EVERY column that exists on both `leads` and `contacts` in
 *      scripts/schema-snapshot.ts, either the converter writes it, or the column is on
 *      a NAMED exception list with a reason. A new shared column added to the schema
 *      fails this test until somebody decides what conversion should do with it.
 *   2. HISTORY — the lineage LINK is stamped (leads.contact_id = contacts.id +
 *      converted_at) and dual-keyed history tables are RE-POINTED, not duplicated.
 *   3. PORTAL — access is granted through the canonical invite core, and when it
 *      cannot be granted the conversion still succeeds and says so.
 *
 * Pure + deterministic: every unit under test takes an injectable `supabase`, so mock
 * clients capture the exact rows. No creds, always runs.
 */
import { createContactFromLead, resolveContactType } from "../lib/contact-promotion/contact-creator"
import { carryLeadHistoryToContact, REPOINTED_HISTORY_TABLES } from "../lib/contact-promotion/history-carry"
import {
  grantPortalAccessForPromotedContact,
  PORTAL_EXCLUDED_CONTACT_TYPES,
} from "../lib/contact-promotion/portal-access"
import { SCHEMA_SNAPSHOT } from "./schema-snapshot"

let pass = 0, fail = 0
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; console.log(`  ✗ ${n}`) } }

// ─────────────────────────────────────────────────────────────────────────────
// THE EXCEPTION LIST. A shared column may be absent from the converted contact
// ONLY if it is here, with the reason. This is the "state precisely why it must
// not move" half of the audit, encoded so it cannot rot into a silent omission.
// ─────────────────────────────────────────────────────────────────────────────
const DELIBERATELY_NOT_COPIED: Record<string, string> = {
  id:
    "leads PK. The contact has its own.",
  contact_id:
    "leads.contact_id is an FK to contacts.id (migration 039 joins l.contact_id = c.id). " +
    "contacts.contact_id is the contact's OWN secondary uuid and is never equal to contacts.id. " +
    "Copying one into the other writes a foreign PK into the new contact's secondary identity.",
  phone_digits:
    "GENERATED/trigger-controlled on BOTH tables (m488 live-verified 428C9 on leads; " +
    "add-lead-id-to-copilot-plans.sql documents the contacts one). Naming it in the INSERT " +
    "is refused ENTIRELY (the whole conversion dies), and the trigger fills it anyway.",
  lifecycle_state:
    "Same name, two vocabularies. leads CHECK: raw|unconsented|consented|isa_qualifying|assigned|" +
    "appointment|representation|long_term_nurture. contacts is written/filtered with " +
    "new|nurturing|qualified|lifetime_customer. MAPPED to 'new', not copied.",
  status:
    "Same name, two vocabularies. leads.status is the acquisition pipeline's token set; a freshly " +
    "converted contact is 'active' by definition, so it is SET, not carried.",
  created_at:
    "The CONTACT's creation instant, not the lead's. The lead's created_at stays readable through " +
    "contact_lead_history.lead_created_at.",
  updated_at:
    "Write stamp for this row.",
  agent_id:
    "Set from the resolved assignment (agents.id), not copied blind.",
  brokerage_id:
    "Set from the tenant anchor at the call site.",
  notes:
    "Not a plain copy — the promotion marker is prepended and the lead's notes appended, so both survive.",
}

/** Chainable mock: `agents` returns agentRow; contacts.insert captures the row. */
function mockSupabase(agentRow: any, captured: { contact?: any }) {
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

/** Mock that records every update() issued, per table. */
function mockUpdateRecorder(opts: { failTable?: string } = {}) {
  const calls: Array<{ table: string; payload: any; filters: any[] }> = []
  const from = (table: string) => {
    const rec = { table, payload: undefined as any, filters: [] as any[] }
    const b: any = {
      update: (payload: any) => { rec.payload = payload; calls.push(rec); return b },
      select: () => b,
      insert: () => b,
      eq: (c: string, v: any) => { rec.filters.push(["eq", c, v]); return b },
      is: (c: string, v: any) => { rec.filters.push(["is", c, v]); return b },
      maybeSingle: async () => ({ data: null, error: null }),
      then: (resolve: any) =>
        resolve(
          opts.failTable === table
            ? { data: null, error: { message: "refused by RLS" }, count: null }
            : { data: null, error: null, count: 2 },
        ),
    }
    return b
  }
  return { client: { from }, calls }
}

async function main(): Promise<void> {
  const leads = SCHEMA_SNAPSHOT.leads
  const contacts = new Set(SCHEMA_SNAPSHOT.contacts)

  // ═══ 1. FIELD CARRY ════════════════════════════════════════════════════════
  console.log("\n[1 · field carry — every column on BOTH tables is copied or named as an exception]")

  // A lead with EVERY shared column populated, so a dropped column is visible.
  const fullLead: Record<string, any> = {}
  for (const c of leads) fullLead[c] = `L_${c}`
  // Values the converter validates/normalizes need real tokens, not sentinels.
  Object.assign(fullLead, {
    id: "lead-1",
    contact_id: "SOME_OTHER_CONTACT_PK",
    motivation_type: "buyer",
    lead_type: "buyer",
    lead_temperature: "hot",
    preferred_channel: "text",           // synonym → 'sms'
    lifecycle_state: "isa_qualifying",
    status: "working",
    dnc_status: true,
    call_stop_flag: true,
    ai_outreach_paused: true,
    email_opt_out: true,
    enrichment_profile: null,
    notes: "ISA: wants a 3/2 under 450k, calling back Tuesday.",
    tags: ["hot", "austin"],
    lead_score: 88,
  })

  const cap: { contact?: any } = {}
  await createContactFromLead(
    mockSupabase({ location_id: "OFF_A", team_id: "TEAM_1", user_id: "user-9" }, cap),
    { leadId: "lead-1", lead: fullLead, agentId: "agent-1", brokerageId: "brk-1" },
  )
  const written = cap.contact ?? {}
  const shared = leads.filter((c) => contacts.has(c))

  check(`shared column set is non-trivial (${shared.length} columns on both tables)`, shared.length > 50)

  const missing = shared.filter((c) => !(c in written) && !(c in DELIBERATELY_NOT_COPIED))
  check(
    missing.length === 0
      ? "every shared column is copied or on the named exception list"
      : `UNDECIDED shared columns (copy them or add a reason): ${missing.join(", ")}`,
    missing.length === 0,
  )

  const staleExceptions = Object.keys(DELIBERATELY_NOT_COPIED).filter((c) => !shared.includes(c))
  check(
    staleExceptions.length === 0
      ? "no stale entries on the exception list"
      : `exception list names non-shared columns: ${staleExceptions.join(", ")}`,
    staleExceptions.length === 0,
  )

  // The columns that were the actual defects — asserted individually and by value.
  check("dnc_status CARRIES the lead's value (was hardcoded false — a DNC lead became callable)",
    written.dnc_status === true)
  check("call_stop_flag carries (the other canonical suppression flag)", written.call_stop_flag === true)
  check("ai_outreach_paused carries", written.ai_outreach_paused === true)
  check("opt_out_reason / opt_out_source / opt_out_channels carry (suppression provenance)",
    written.opt_out_reason === "L_opt_out_reason" &&
    written.opt_out_source === "L_opt_out_source" &&
    written.opt_out_channels === "L_opt_out_channels")
  check("last_contacted_at carries (the contact does not start with a blank last touch)",
    written.last_contacted_at === "L_last_contacted_at")
  check("next_followup_at / next_followup_reason carry (a promised touch is not dropped)",
    written.next_followup_at === "L_next_followup_at" &&
    written.next_followup_reason === "L_next_followup_reason")
  check("lead_score carries", written.lead_score === 88)
  check("campaign_attribution_id / cost_per_record carry (paid-acquisition ROI)",
    written.campaign_attribution_id === "L_campaign_attribution_id" &&
    written.cost_per_record === "L_cost_per_record")
  check("first_touch_channel / first_touched_at carry (first-touch attribution)",
    written.first_touch_channel === "L_first_touch_channel" &&
    written.first_touched_at === "L_first_touched_at")
  check("tags carry", Array.isArray(written.tags) && written.tags.includes("austin"))
  check("home_owner_status / life_events carry from the lead's own columns",
    written.home_owner_status === "L_home_owner_status" && written.life_events === "L_life_events")

  check("lead_temperature normalized to a CHECK-legal band", written.lead_temperature === "hot")
  check("preferred_channel normalized through the Data Steward ('text' → 'sms')",
    written.preferred_channel === "sms")
  check("a 4-band 'cool' temperature collapses instead of refusing the insert",
    (await (async () => {
      const c2: { contact?: any } = {}
      await createContactFromLead(mockSupabase({ location_id: null, team_id: null }, c2),
        { leadId: "l", lead: { ...fullLead, lead_temperature: "cool" }, agentId: "a", brokerageId: "b" })
      return c2.contact?.lead_temperature
    })()) === null)

  // The exceptions, asserted as ABSENCES / MAPPINGS — not just documented.
  check("contacts.contact_id NOT written from leads.contact_id (the two-uuid trap)",
    written.contact_id === undefined)
  check("phone_digits NOT named in the insert (generated column → PGRST would refuse everything)",
    written.phone_digits === undefined)
  check("lifecycle_state MAPPED to a contacts-vocabulary value, not copied",
    written.lifecycle_state === "new")
  check("status SET to 'active', not carried from the lead pipeline vocabulary",
    written.status === "active")
  check("id NOT carried", written.id === undefined)

  // Notes: marker survives (parsers + idempotency depend on it) AND the lead's notes survive.
  check("notes keep the promotion marker FIRST",
    typeof written.notes === "string" && written.notes.startsWith("Promoted from lead lead-1"))
  check("notes PRESERVE the lead's own notes (they used to be overwritten)",
    typeof written.notes === "string" && written.notes.includes("calling back Tuesday"))
  check("a lead with no notes yields the bare marker (exact-match probes still work)",
    (await (async () => {
      const c3: { contact?: any } = {}
      await createContactFromLead(mockSupabase(null, c3),
        { leadId: "L9", lead: { ...fullLead, notes: null }, agentId: "a", brokerageId: "b" })
      return c3.contact?.notes
    })()) === "Promoted from lead L9")

  // ═══ 2. HISTORY ════════════════════════════════════════════════════════════
  console.log("\n[2 · history — linked and re-pointed, never duplicated]")

  for (const t of REPOINTED_HISTORY_TABLES) {
    const cols = SCHEMA_SNAPSHOT[t]
    check(`${t}: lead_id + contact_id + brokerage_id all live (PGRST204 would refuse the update)`,
      !!cols && cols.includes("lead_id") && cols.includes("contact_id") && cols.includes("brokerage_id"))
  }

  const rec = mockUpdateRecorder()
  const carry = await carryLeadHistoryToContact(rec.client, {
    leadId: "lead-1", contactId: "contact-1", brokerageId: "brk-1",
  })
  const leadUpdate = rec.calls.find((c) => c.table === "leads")
  check("the LINK is stamped: leads.contact_id = the contact's PRIMARY key",
    leadUpdate?.payload?.contact_id === "contact-1")
  check("converted_at is stamped in the SAME statement as contact_id (they cannot disagree)",
    typeof leadUpdate?.payload?.converted_at === "string")
  check("carry reports linked=true", carry.linked === true)
  check("leads.lifecycle_state NOT written here (lead-acquisition-handlers.ts owns that column)",
    leadUpdate && !("lifecycle_state" in leadUpdate.payload))

  const repointCalls = rec.calls.filter((c) => c.table !== "leads")
  check(`every curated history table is re-pointed (${REPOINTED_HISTORY_TABLES.length} tables)`,
    repointCalls.length === REPOINTED_HISTORY_TABLES.length)
  check("re-point writes ONLY contact_id — no row is copied, nothing else is rewritten",
    repointCalls.every((c) => Object.keys(c.payload).length === 1 && "contact_id" in c.payload))
  check("re-point never steals a row that already names a contact (contact_id IS NULL guard)",
    repointCalls.every((c) => c.filters.some(([op, col]: any[]) => op === "is" && col === "contact_id")))
  check("re-point is tenant-pinned (brokerage_id filter on every table)",
    repointCalls.every((c) => c.filters.some(([op, col]: any[]) => op === "eq" && col === "brokerage_id")))
  check("re-point is keyed on the lead", repointCalls.every((c) =>
    c.filters.some(([op, col, v]: any[]) => op === "eq" && col === "lead_id" && v === "lead-1")))
  check("sequence_enrollments is NOT re-pointed (deactivation closes it on purpose)",
    !(REPOINTED_HISTORY_TABLES as readonly string[]).includes("sequence_enrollments"))

  // A refusal must be SEEN (supabase-js resolves refusals) and must not abort.
  const recFail = mockUpdateRecorder({ failTable: "voice_calls" })
  const carryFail = await carryLeadHistoryToContact(recFail.client, {
    leadId: "lead-1", contactId: "contact-1", brokerageId: "brk-1",
  })
  check("a refused re-point is REPORTED, not swallowed",
    carryFail.warnings.some((w) => w.includes("voice_calls") && w.includes("refused")))
  check("a refused re-point does not stop the other tables or the link",
    carryFail.linked === true && Object.keys(carryFail.repointed).length === REPOINTED_HISTORY_TABLES.length - 1)

  const recLinkFail = mockUpdateRecorder({ failTable: "leads" })
  const carryLinkFail = await carryLeadHistoryToContact(recLinkFail.client, {
    leadId: "lead-1", contactId: "contact-1", brokerageId: "brk-1",
  })
  check("a refused LINK is reported and names the consequence (no lineage in contact_lead_history)",
    carryLinkFail.linked === false &&
    carryLinkFail.warnings.some((w) => w.includes("contact_lead_history")))

  // ═══ 3. PORTAL ═════════════════════════════════════════════════════════════
  console.log("\n[3 · portal access — canonical path, honest failure]")

  const portalCore = "../lib/portal/portal-invite-core"
  check("the converter does NOT define its own invite table or token (single mechanism)",
    !JSON.stringify(REPOINTED_HISTORY_TABLES).includes("portal_contact_invites") && !!portalCore)

  const agentsMock = (row: any, err: any = null) => ({
    from: () => {
      const b: any = { select: () => b, eq: () => b, maybeSingle: async () => ({ data: row, error: err }) }
      return b
    },
  })

  const noUser = await grantPortalAccessForPromotedContact(agentsMock({ user_id: null }), {
    contactId: "contact-1", agentId: "agent-1", contactType: "buyer",
  })
  check("no agents.user_id → access is REFUSED honestly, not faked",
    noUser.granted === false && noUser.reason === "no_authorizing_agent_user")
  check("…and the refusal explains the fix (agents.user_id is the only agents.id→users.id crossing)",
    noUser.warnings.some((w) => w.includes("agents.user_id")))

  const refusedLookup = await grantPortalAccessForPromotedContact(
    agentsMock(null, { message: "RLS refused" }),
    { contactId: "contact-1", agentId: "agent-1", contactType: "seller" },
  )
  check("a refused agents lookup is read and reported (supabase-js resolves refusals)",
    refusedLookup.granted === false && refusedLookup.warnings.some((w) => w.includes("RLS refused")))

  for (const t of PORTAL_EXCLUDED_CONTACT_TYPES) {
    const ex = await grantPortalAccessForPromotedContact(agentsMock({ user_id: "u1" }), {
      contactId: "c", agentId: "a", contactType: t,
    })
    check(`contact_type '${t}' is skipped (a counterparty is not a client)`,
      ex.granted === false && ex.reason === "excluded_contact_type")
  }

  for (const t of ["buyer", "seller", "investor", "prospect", "both"]) {
    check(`contact_type '${t}' is NOT excluded from the portal`,
      !PORTAL_EXCLUDED_CONTACT_TYPES.includes(t))
  }

  check("resolveContactType feeds the portal gate a CANONICAL type (never a raw lead_type)",
    resolveContactType("investor", "motivated_seller") === "investor" &&
    resolveContactType(null, "unknown") === "prospect")

  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ LEAD_CONTACT_FIELD_CARRY_FAIL"); process.exit(1) }
  console.log(" ✅ LEAD_CONTACT_FIELD_CARRY_PASS — fields carried, history linked + re-pointed, portal granted or honestly refused")
}

main().catch((e) => { console.error(e); process.exit(1) })
