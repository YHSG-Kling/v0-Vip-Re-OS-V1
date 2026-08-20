/**
 * lib/contact-promotion/history-carry.ts
 *
 * "…so data can be duplicated to the new contact record without losing any history."
 *
 * Copying columns moves the lead's FACTS. This moves the lead's HISTORY — the rows
 * that were written ABOUT the lead while it was still a lead: ISA activities and
 * calls, the qualification record, the outreach ledger, score history, consent
 * events, chat transcripts, notes, searches, visits.
 *
 * TWO MECHANISMS, and the choice between them is deliberate:
 *
 *  1. LINK (never duplicate). `leads.contact_id = contacts.id` + `converted_at`.
 *     This single stamp is what makes the whole lead-side history reachable at all:
 *     the `contact_lead_history` view (migration 039) joins EXACTLY on
 *     `l.contact_id = c.id`, and it is the only surface through which an agent may
 *     read lead lineage (migration 034 locks `leads` away from agents). Without the
 *     stamp the view returns nothing and every lead-keyed table
 *     (lead_conversation_history, lead_intelligence, lead_osint_data, …) is orphaned
 *     behind a lead the agent cannot see.
 *
 *  2. RE-POINT (never duplicate). For history tables that carry BOTH `lead_id` and
 *     `contact_id`, the contact_id is filled in where it is still NULL. Nothing is
 *     copied, nothing is rewritten: the row keeps its lead_id, and a forward
 *     reference that was unknowable when the row was written becomes known. This is
 *     what makes the ISA history sheet, the contact detail pane and conversation
 *     memory show the lead-phase conversation instead of an empty contact.
 *
 * DUPLICATION IS NOT USED ANYWHERE. Copying rows would double every count, split
 * every audit trail in two, and give the same conversation two created_at truths.
 *
 * EVERY STEP IS BEST-EFFORT AND EVERY REFUSAL IS SEEN. supabase-js RESOLVES a
 * refusal rather than throwing, so every call here destructures `{ error }` and
 * reports it as a warning. A history-carry failure must never roll back or abort a
 * conversion that has already created the contact.
 */

/**
 * History tables that carry BOTH `lead_id` and `contact_id`.
 *
 * EVERY NAME AND BOTH COLUMNS VERIFIED PRESENT IN scripts/schema-snapshot.ts — a
 * PostgREST UPDATE naming a column the table does not have is refused entirely
 * (PGRST204), and this list runs on the automatic conversion path.
 *
 * The list is curated, not exhaustive: a table earns a place by being HISTORY the
 * agent should see on the contact. Deliberate omissions, with reasons:
 *   sequence_enrollments  — lead-deactivator.ts CLOSES these on conversion on
 *                           purpose; re-pointing would hand the new contact a
 *                           lead-era cadence to resume under new consent.
 *   lead_enrichment_queue — a work queue, not history. The converter already
 *                           queues fresh enrichment against the contact.
 *   audience_members,
 *   direct_mail_*,
 *   campaign_bundle_dispatches — owned by the audience/marketing lane, which
 *                           promotes membership itself (audience-sync's
 *                           onLeadConvertedForAudience).
 */
export const REPOINTED_HISTORY_TABLES = [
  "ai_isa_activities",       // ISA activity feed  (read by ContactDetailPane, conversation-memory)
  "ai_isa_calls",            // ISA call log       (read by contact-history-sheet, team-query)
  "ai_isa_qualifications",   // the qualification  (read by app/crm, contact-history-sheet)
  "ai_isa_engagement_tracking",
  "isa_outreach_log",        // outreach ledger    (read by managers/deliberation)
  "voice_calls",             // recordings/transcripts (read by UnifiedInboxTab, communications)
  "lead_score_history",      // score trail        (read by ai-lead-scoring, signal-extensions)
  "communication_audit_log", // compliance comms trail
  "contact_consent_events",  // consent ledger — the consent itself is carried onto the contact
  "ai_assistant_notes",
  "chat_sessions",
  "calculator_history",
  "property_search_log",
  "website_visitors",
  "unified_lead_profile",
  "copilot_plans",
] as const

export interface HistoryCarryResult {
  /** leads.contact_id + converted_at were stamped — the lineage LINK exists. */
  linked: boolean
  /** table → rows re-pointed at the new contact. */
  repointed: Record<string, number>
  /** Human-readable refusals. Never thrown — the conversion outlives them. */
  warnings: string[]
}

export interface HistoryCarryParams {
  leadId: string
  /** contacts.id — the PRIMARY key, NOT contacts.contact_id. */
  contactId: string
  brokerageId: string | null
}

export async function carryLeadHistoryToContact(
  supabase: any,
  params: HistoryCarryParams,
): Promise<HistoryCarryResult> {
  const { leadId, contactId, brokerageId } = params
  const result: HistoryCarryResult = { linked: false, repointed: {}, warnings: [] }
  const now = new Date().toISOString()

  // ── 1. THE LINK ────────────────────────────────────────────────────────────
  // `contact_id` here is the leads-side FK, and migration 039 joins it to
  // contacts.id — so this MUST be the contact's PRIMARY key. Stamped together with
  // converted_at in one statement so the pair can never disagree about whether (and
  // when) this lead converted.
  //
  // NOT written here: leads.lifecycle_state. lib/kernel/lead-acquisition-handlers.ts
  // declares itself the only writer of that column ("RULE: Only this file writes
  // leads.lifecycle_state. No other file may do so."), and the terminal value a
  // conversion deserves is 'representation' (lib/lead-pipeline/lead-lifecycle.ts:
  // LEAD_CONVERTED_STATE). Leads converted through this service therefore keep their
  // pre-conversion lifecycle_state — reported, not quietly patched from here.
  {
    const { error } = await supabase
      .from("leads")
      .update({ contact_id: contactId, converted_at: now, updated_at: now })
      .eq("id", leadId)

    if (error) {
      result.warnings.push(
        `lead→contact LINK not stamped (leads.contact_id/converted_at): ${error.message}. ` +
          `contact_lead_history will show no lineage for contact ${contactId}.`,
      )
    } else {
      result.linked = true
    }
  }

  // ── 2. RE-POINT ────────────────────────────────────────────────────────────
  // `contact_id IS NULL` guard: a row that already names a contact belongs to that
  // contact and is never re-aimed. Tenant-pinned where the table carries the column
  // (all of these do — verified in the snapshot) so a re-point can never cross a
  // brokerage boundary. Run in parallel; each failure is independent.
  const repoints = await Promise.all(
    REPOINTED_HISTORY_TABLES.map(async (table) => {
      let q = supabase
        .from(table)
        .update({ contact_id: contactId }, { count: "exact" })
        .eq("lead_id", leadId)
        .is("contact_id", null)
      if (brokerageId) q = q.eq("brokerage_id", brokerageId)
      const { error, count } = await q
      return { table, error, count: count ?? 0 }
    }),
  )

  for (const r of repoints) {
    if (r.error) {
      result.warnings.push(`${r.table}: history NOT re-pointed at contact ${contactId} — ${r.error.message}`)
    } else if (r.count > 0) {
      result.repointed[r.table] = r.count
    }
  }

  return result
}
