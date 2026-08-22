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
 *  3. MOVE (never duplicate). Identical intent to a re-point, but the lead_id is
 *     RELEASED in the same statement, because the table's own CHECK says the row may
 *     name exactly ONE entity. A re-point on such a table sets both columns at once
 *     and the database refuses the UPDATE — and supabase-js RESOLVES that refusal, so
 *     the row would be left behind a retired lead with a warning nobody reads. See
 *     MOVED_HISTORY_TABLES for the one table this applies to and the constraint text.
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
 * ── THE LIST IS CURATED, AND THAT USED TO MEAN "UNCHECKED" ──────────────────
 * A table earns a place by being HISTORY the agent should see on the contact.
 * The omissions below used to live in this comment ALONE, which meant a new
 * dual-keyed table could be added to the schema tomorrow and belong to no list at
 * all — its rows would sit behind a retired lead forever and nothing in the repo
 * could see it. That is an ORPHANED CHILD in the product sense even though its FK
 * is perfectly intact, and it is what `npm run test:orphaned-children` now
 * ratchets: every table carrying BOTH `lead_id` and `contact_id` must appear in
 * EXACTLY ONE of REPOINTED_HISTORY_TABLES / MOVED_HISTORY_TABLES /
 * CONVERSION_CARRY_OMISSIONS, or the census fails. The prose became data so that
 * an omission is a DECISION on the record rather than a gap nobody noticed.
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
  // ── ADDED 2026-08-22 by the orphaned-child census. Each was dual-keyed, in NO
  // list, and therefore stranded behind the retired lead after conversion. ────
  "signal_reactivations",          // lib/kernel/returning-customer.ts:212 selects
                                   // `.not("contact_id","is",null)` — a lead-era
                                   // reactivation signal could NEVER reach the
                                   // returning-customer lane without this.
  "smart_showing_recommendations", // read on the contact page at
                                   // app/crm/contacts/[contactId]/page.tsx:262,
                                   // which today has to re-derive the lead ids and
                                   // build an `.or(...)` to find them.
  "outcome_reconciliations",       // lib/outcomes/reconciliation-ledger.ts writes
                                   // both keys at claim time (:80-:81) and reads
                                   // back on contact_id (:141). Only the forward
                                   // reference is filled; the claim itself — status,
                                   // verdict, timestamps — is never touched.
] as const

/**
 * THE MOVE LIST. Dual-keyed history whose table forbids naming BOTH entities, so
 * the carry must RELEASE the lead in the same statement that names the contact.
 *
 * Live evidence (project hrvaqgvukzxfskkcrwbt, pg_constraint, 2026-08-22) — this is
 * the ONLY exactly-one CHECK among all 30 dual-keyed tables, which is why it is a
 * named list rather than a rule inferred from the schema cache:
 *
 *   motivated_seller_signals_one_entity
 *     CHECK (((lead_id IS NOT NULL) <> (contact_id IS NOT NULL)))
 *
 * The other two entity CHECKs on dual-keyed tables are `OR`, not `<>`, and re-point
 * satisfies them unchanged:
 *   lead_score_history.must_have_scoring_entity            CHECK (lead_id IS NOT NULL OR contact_id IS NOT NULL)
 *   smart_showing_recommendations_target_check             CHECK (lead_id IS NOT NULL OR contact_id IS NOT NULL)
 *
 * WHY THIS TABLE MATTERS MORE THAN THE OTHERS. m517 added `contact_id` here on the
 * owner's ruling that "motivated sellers source is for leads and contacts", and
 * m519 retired the lead-prefixed twin onto it. Two readers —
 * app/actions/ai-predictions.ts:211-212 and app/actions/lead-intelligence.ts:
 * 1390-1391 — already query BOTH columns with the SAME id because they cannot know
 * which kind of row they hold. That works only while the two ids are the same
 * string; after a conversion they are not, so a seller signal detected while the
 * person was a lead disappeared from every contact-keyed read. The signal is the
 * evidence that this person may sell. Losing it is losing the deal.
 *
 * A MOVE IS NOT A DELETION. The row survives with all of its facts; the only change
 * is which entity it hangs from — and it hangs from the one the owner's ruling says
 * is now acted upon.
 */
export const MOVED_HISTORY_TABLES = [
  "motivated_seller_signals",
] as const

/**
 * DUAL-KEYED TABLES DELIBERATELY NOT CARRIED, each with the reason on the record.
 *
 * A name here is a decision, not an oversight — that is the whole point of making
 * the omissions data. `npm run test:orphaned-children` fails on any dual-keyed table
 * that is in none of the three lists, and on any name here that is NOT dual-keyed
 * (a stale entry, which would mean the reason no longer describes anything).
 */
/**
 * DUAL-KEYED RELATIONS THAT ARE NOT TABLES, so they hold no child rows to carry.
 *
 * scripts/schema-snapshot.ts is built from information_schema.columns, which does
 * not separate tables from views — so a view carrying both keys looks exactly like
 * an uncarried child table to any offline reader. Named here, with the live check
 * that settles it, rather than inferred:
 *
 *   SELECT relkind FROM pg_class … WHERE relname='contact_lead_history'  →  'v'
 *
 * and the same query over ALL views proves this is the only one: it is migration
 * 039's lineage view, joined on `l.contact_id = c.id` — i.e. it is the thing the
 * LINK half of this file exists to populate, not something that needs carrying.
 */
export const DUAL_KEYED_NON_TABLES = ["contact_lead_history"] as const

export const CONVERSION_CARRY_OMISSIONS: Record<string, string> = {
  sequence_enrollments:
    "lib/contact-promotion/lead-deactivator.ts CLOSES these on conversion on purpose " +
    "(status → completed for active AND paused). Re-pointing would hand the new contact " +
    "a lead-era cadence to resume under new consent.",
  lead_enrichment_queue:
    "A work queue, not history. The converter already queues fresh enrichment against the contact.",
  audience_members:
    "Owned by the audience/marketing lane, which promotes membership itself — " +
    "lib/audiences/audience-sync.ts:onLeadConvertedForAudience.",
  campaign_bundle_dispatches:
    "Same owner as audience_members: the audience/marketing lane promotes its own membership.",
  direct_mail_campaigns:
    "Direct-mail lane. A campaign is addressed to a mailing identity at send time; " +
    "re-aiming a sent campaign would rewrite who was mailed.",
  direct_mail_recipients:
    "Direct-mail lane, and a recipient row IS the record of who received a piece of mail.",
  direct_mail_responses:
    "Direct-mail lane. The response belongs to the recipient row it answered.",
  mail_response_tracking:
    "Direct-mail lane, same rationale as direct_mail_responses — it is the ROI ledger " +
    "for a mailing (lib/campaigns/roi-calculator.ts:127) and is aggregated by campaign, " +
    "never by person, so an uncarried forward reference costs no reader anything.",
  ai_autopilot_plans:
    "NOTHING EXECUTES THE PLAN. The only three touches are in app/actions/ai-predictions.ts " +
    "— insert (:752, writes lead_id only, never contact_id), list-by-agent (:789) and " +
    "toggle-by-plan-id (:808). No cron or reactor acts on next_action_at, so an uncarried " +
    "plan produces no lead-keyed action and the conversion ruling is not violated. The " +
    "missing half here is the EXECUTOR, not the carry; carrying it first would make an " +
    "inert row look live. Reported to the one-sided census rather than papered over here.",
  message_threads:
    "UNRESOLVED, deliberately: no `.from(\"message_threads\")` exists anywhere in the tree — " +
    "not one reader, not one writer. Carrying rows into a table nothing queries would " +
    "manufacture data with no consumer. This belongs to the orphan-table sweep, not to " +
    "the conversion lane; named here so it cannot silently rejoin the gap.",
}

export interface HistoryCarryResult {
  /** leads.contact_id + converted_at were stamped — the lineage LINK exists. */
  linked: boolean
  /** table → rows re-pointed at the new contact (lead_id kept). */
  repointed: Record<string, number>
  /** table → rows MOVED to the new contact (lead_id released — exactly-one CHECK). */
  moved: Record<string, number>
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
  const result: HistoryCarryResult = { linked: false, repointed: {}, moved: {}, warnings: [] }
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

  // ── 3. MOVE ────────────────────────────────────────────────────────────────
  // Same intent as a re-point, one difference that the database enforces: the
  // lead_id is RELEASED in the SAME statement, because the row may name exactly
  // one entity (see MOVED_HISTORY_TABLES for the constraint text). Setting both
  // would be refused whole — and supabase-js resolves a refusal, so the row would
  // be silently left behind the retired lead.
  //
  // `.is("contact_id", null)` is kept for symmetry with the re-point even though
  // the CHECK already implies it: a row naming a contact belongs to that contact.
  // Tenant-pinned identically, so a move can never cross a brokerage boundary.
  const moves = await Promise.all(
    MOVED_HISTORY_TABLES.map(async (table) => {
      let q = supabase
        .from(table)
        .update({ contact_id: contactId, lead_id: null }, { count: "exact" })
        .eq("lead_id", leadId)
        .is("contact_id", null)
      if (brokerageId) q = q.eq("brokerage_id", brokerageId)
      const { error, count } = await q
      return { table, error, count: count ?? 0 }
    }),
  )

  for (const m of moves) {
    if (m.error) {
      result.warnings.push(
        `${m.table}: history NOT moved to contact ${contactId} — ${m.error.message}. ` +
          `The signal stays behind the retired lead and no contact-keyed read will find it.`,
      )
    } else if (m.count > 0) {
      result.moved[m.table] = m.count
    }
  }

  return result
}
