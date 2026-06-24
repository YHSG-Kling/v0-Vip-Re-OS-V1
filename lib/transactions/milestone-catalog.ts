// lib/transactions/milestone-catalog.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE single canonical source of truth for transaction milestones.
//
// Two routes create transaction milestones — direct creation (generateMilestones)
// and the offer→transaction bridge (ensureRequiredMilestones). They used to carry
// their OWN milestone lists, names, visibility rules, and deadline metadata, so the
// milestone set a transaction got depended on HOW it was created (human names vs
// canonical names, all-visible vs curated, deadline-mirrored vs not). That is the
// root milestone drift.
//
// Both routes now build from THIS catalog, so they cannot diverge. Each entry pins:
//   • id            — the canonical milestone identity (drives education/reporting).
//   • name          — the human display label seeded into milestone_name.
//   • clientVisible — the curated is_client_visible default (agent can still override).
//   • deadline      — when the milestone is a date-bearing deadline, the term key +
//                     deadline_type + calendar event type used to mirror it into
//                     transaction_deadlines + calendar_events.
//
// Pure module (no DB / no server-only) — safe to import from seeders, the offer
// bridge, milestone-service, and simulators.

import type { CanonicalMilestoneId } from "./milestone-identity"

export interface MilestoneDeadlineMeta {
  /** key looked up in contractTerms to find the target date (== the canonical id). */
  termKey: string
  /** transaction_deadlines.deadline_type. */
  deadlineType: string
  /** calendar_events.event_type for the deadline-watcher cron (omit = no cal event). */
  calendarEventType?: "inspection" | "appraisal" | "financing_deadline" | "walkthrough" | "closing"
}

export interface MilestoneCatalogEntry {
  id: CanonicalMilestoneId
  name: string
  clientVisible: boolean
  deadline?: MilestoneDeadlineMeta
}

const EARNEST: MilestoneDeadlineMeta   = { termKey: "earnest_money_due",   deadlineType: "earnest_money" }
const INSPECTION: MilestoneDeadlineMeta = { termKey: "inspection_deadline", deadlineType: "inspection",  calendarEventType: "inspection" }
const APPRAISAL: MilestoneDeadlineMeta = { termKey: "appraisal_deadline",  deadlineType: "appraisal",   calendarEventType: "appraisal" }
const FINANCING: MilestoneDeadlineMeta = { termKey: "financing_deadline",  deadlineType: "financing",   calendarEventType: "financing_deadline" }
const CLOSING: MilestoneDeadlineMeta   = { termKey: "closing_date",        deadlineType: "closing",     calendarEventType: "closing" }

/** Buyer-side journey — celebratory + deadline + (hidden) compliance milestones. */
export const BUYER_MILESTONE_JOURNEY: MilestoneCatalogEntry[] = [
  { id: "offer_submitted",            name: "Offer Submitted",        clientVisible: true },
  { id: "offer_accepted",             name: "Offer Accepted",         clientVisible: true },
  { id: "earnest_money_due",          name: "Earnest Money Due",      clientVisible: true,  deadline: EARNEST },
  { id: "inspection_deadline",        name: "Home Inspection",        clientVisible: true,  deadline: INSPECTION },
  { id: "inspection_completed",       name: "Inspection Complete",    clientVisible: true },
  { id: "appraisal_ordered",          name: "Appraisal Ordered",      clientVisible: false },
  { id: "appraisal_deadline",         name: "Appraisal Deadline",     clientVisible: true,  deadline: APPRAISAL },
  { id: "appraisal_completed",        name: "Appraisal Complete",     clientVisible: true },
  { id: "financing_deadline",         name: "Financing Approval",     clientVisible: true,  deadline: FINANCING },
  { id: "loan_approved",              name: "Loan Approved",          clientVisible: true },
  { id: "clear_to_close_received",    name: "Clear to Close",         clientVisible: true },
  { id: "cda_delivered",              name: "Commission Disbursement",clientVisible: false },
  { id: "cd_uploaded",                name: "Closing Disclosure",     clientVisible: false },
  { id: "funding_confirmed",          name: "Funding Confirmed",      clientVisible: false },
  { id: "final_walkthrough_scheduled",name: "Final Walkthrough",      clientVisible: true },
  { id: "closing_date",               name: "Closing Day",            clientVisible: true,  deadline: CLOSING },
  { id: "closed",                     name: "Keys Received",          clientVisible: true },
]

/** Seller-side journey — same identities, seller-framed names. */
export const SELLER_MILESTONE_JOURNEY: MilestoneCatalogEntry[] = [
  { id: "listing_live",               name: "Property Listed",        clientVisible: true },
  { id: "first_showing",              name: "First Showing",          clientVisible: true },
  { id: "offer_received",             name: "Offer Received",         clientVisible: true },
  { id: "offer_accepted",             name: "Offer Accepted",         clientVisible: true },
  { id: "earnest_money_due",          name: "Earnest Money Received", clientVisible: true,  deadline: EARNEST },
  { id: "inspection_deadline",        name: "Buyer Inspection",       clientVisible: true,  deadline: INSPECTION },
  { id: "inspection_completed",       name: "Inspection Complete",    clientVisible: true },
  { id: "appraisal_deadline",         name: "Appraisal",             clientVisible: true,  deadline: APPRAISAL },
  { id: "appraisal_completed",        name: "Appraisal Complete",     clientVisible: true },
  { id: "financing_deadline",         name: "Buyer Financing",        clientVisible: true,  deadline: FINANCING },
  { id: "loan_approved",              name: "Buyer Financing Approved",clientVisible: true },
  { id: "clear_to_close_received",    name: "Clear to Close",         clientVisible: true },
  { id: "cda_delivered",              name: "Commission Disbursement",clientVisible: false },
  { id: "cd_uploaded",                name: "Closing Disclosure",     clientVisible: false },
  { id: "funding_confirmed",          name: "Funding Confirmed",      clientVisible: false },
  { id: "closing_date",               name: "Closing Day",            clientVisible: true,  deadline: CLOSING },
  { id: "closed",                     name: "Home Sold",              clientVisible: true },
]

/** The journey for a transaction_type ("sale" = seller; everything else = buyer). */
export function milestoneJourneyFor(transactionType: string): MilestoneCatalogEntry[] {
  return transactionType === "sale" ? SELLER_MILESTONE_JOURNEY : BUYER_MILESTONE_JOURNEY
}

/** The deadline-bearing entries (used by the deadline/calendar mirror) for a journey,
 *  de-duplicated by canonical id (buyer + seller share the same deadline identities). */
export function deadlineBearingMilestones(): Array<MilestoneCatalogEntry & { deadline: MilestoneDeadlineMeta }> {
  const seen = new Set<string>()
  const out: Array<MilestoneCatalogEntry & { deadline: MilestoneDeadlineMeta }> = []
  for (const e of BUYER_MILESTONE_JOURNEY) {
    if (e.deadline && !seen.has(e.id)) {
      seen.add(e.id)
      out.push(e as MilestoneCatalogEntry & { deadline: MilestoneDeadlineMeta })
    }
  }
  return out
}

/** The canonical deadline-critical milestone identities ensureRequiredMilestones
 *  guarantees exist on every under-contract transaction (deadlines + compliance). */
export const REQUIRED_MILESTONE_IDS: CanonicalMilestoneId[] = [
  "earnest_money_due",
  "inspection_deadline",
  "inspection_completed",
  "appraisal_ordered",
  "appraisal_deadline",
  "appraisal_completed",
  "financing_deadline",
  "clear_to_close_received",
  "final_walkthrough_scheduled",
  "cda_delivered",
  "cd_uploaded",
  "funding_confirmed",
  "closing_date",
]

/** Look up a catalog entry by canonical id (buyer journey is the superset). */
export function catalogEntry(id: CanonicalMilestoneId): MilestoneCatalogEntry | undefined {
  return BUYER_MILESTONE_JOURNEY.find((e) => e.id === id)
}
