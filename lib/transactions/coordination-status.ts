// lib/transactions/coordination-status.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE COORDINATOR'S OPEN-WORK VOCABULARIES — milestones, deadlines, documents,
// and the two e-sign ladders.
//
// WHY THIS MODULE EXISTS. Every surface that answers "what is still open on
// this deal?" had hand-rolled its own status filter, and five of them named a
// value the column's CHECK cannot hold. A filter on an impossible value returns
// zero rows and reads as "nothing outstanding" forever — the most expensive
// possible way to be wrong on a coordination surface, because the failure looks
// exactly like success.
//
//   transaction_milestones.status   pending | completed | overdue | cancelled
//   transaction_deadlines.status    pending | completed | extended | missed | waived
//   transaction_documents.status    missing | requested | uploaded | under_review
//                                   | approved | rejected | pending_signature
//   contract_signatures.esign_status   pending | sent | viewed | agent_signed
//                                      | fully_signed | voided | declined
//   listing_agreements.esign_status    pending | sent | partially_signed
//                                      | fully_signed | voided | declined
//
// NOTHING HERE IS WIDENED. Every defect in this cluster was a value that had no
// business being stored — 'in_progress' on two ladders that have no such state
// and no writer for one, 'at_risk' (a risk BAND, not a lifecycle status),
// 'pending' on a document ladder that says 'requested', 'out_for_signature'
// where the ladder says 'sent', 'executed' where it says 'fully_signed'. The
// code moves onto the database's vocabulary, not the reverse. No migration.

// ── Milestones ───────────────────────────────────────────────────────────────

export const MILESTONE_STATUSES = ["pending", "completed", "overdue", "cancelled"] as const
export type MilestoneStatus = (typeof MILESTONE_STATUSES)[number]

/**
 * Still outstanding. Four surfaces asked for `["pending", "in_progress"]`;
 * 'in_progress' is not a value this column admits and nothing has ever written
 * it, so it was dead weight — but the set was ALSO wrong in a way that hid
 * rows: it omitted 'overdue', so a milestone explicitly stamped overdue
 * vanished from the very list titled "incomplete milestones". Both fixed here.
 */
export const MILESTONE_OPEN_STATUSES = ["pending", "overdue"] as const

export function isMilestoneStatus(v: unknown): v is MilestoneStatus {
  return typeof v === "string" && (MILESTONE_STATUSES as readonly string[]).includes(v)
}

// ── Deadlines ────────────────────────────────────────────────────────────────

export const DEADLINE_STATUSES = ["pending", "completed", "extended", "missed", "waived"] as const
export type DeadlineStatus = (typeof DEADLINE_STATUSES)[number]

/**
 * Still live and still owed. 'extended' is an open deadline with a new date —
 * the coordinator surfaces filtered it out, so extending a deadline made it
 * disappear from the upcoming list rather than move.
 */
export const DEADLINE_OPEN_STATUSES = ["pending", "extended"] as const

export function isDeadlineStatus(v: unknown): v is DeadlineStatus {
  return typeof v === "string" && (DEADLINE_STATUSES as readonly string[]).includes(v)
}

/**
 * "At risk" is DERIVED, never stored.
 *
 * lib/kernel/reporting-autonomy.ts counted at-risk deadlines with
 * `.in("status", ["at_risk", "missed"])`. 'at_risk' is a RISK BAND — the word
 * this codebase uses for computed health on deal_health, listing risk, agent
 * goals and smart-queue segments — and transaction_deadlines.status is a
 * LIFECYCLE column that admits no such value. Nothing has ever written it, so
 * that report told every brokerage it had ZERO deadlines at risk, every time,
 * forever. On an autonomy-governance surface a permanent zero is worse than no
 * number at all.
 *
 * The fix is not to add a state nobody transitions into. It is to compute the
 * band the same way the rest of the product computes bands: an open deadline
 * falling due inside the window is at risk.
 */
export const DEADLINE_AT_RISK_WINDOW_DAYS = 3

export function deadlineAtRisk(
  row: { status?: string | null; deadline_date?: string | null },
  now: Date = new Date(),
): boolean {
  if (!row.deadline_date) return false
  if (!(DEADLINE_OPEN_STATUSES as readonly string[]).includes(row.status ?? "")) return false
  const due = new Date(row.deadline_date).getTime()
  if (Number.isNaN(due)) return false
  const horizon = now.getTime() + DEADLINE_AT_RISK_WINDOW_DAYS * 24 * 60 * 60 * 1000
  // Already past due but not yet stamped 'missed' counts too — that is exactly
  // the deadline a coach needs to hear about.
  return due <= horizon
}

// ── Documents ────────────────────────────────────────────────────────────────

export const DOCUMENT_STATUSES = [
  "missing", "requested", "uploaded", "under_review", "approved", "rejected", "pending_signature",
] as const
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number]

/** Nothing further is owed on the document. */
export const DOCUMENT_TERMINAL_STATUSES = ["approved", "rejected"] as const

/**
 * Someone still owes something. Defined as the COMPLEMENT of terminal so a
 * status added later is treated as open by default — the safe direction for a
 * compliance checklist, and the direction that would have prevented this bug.
 *
 * Both readers previously filtered `status = 'pending'`, which this ladder has
 * never had (the writer inserts 'requested'). The pending-documents count and
 * the pending-documents list were therefore always zero and always empty.
 */
export const DOCUMENT_OPEN_STATUSES = DOCUMENT_STATUSES.filter(
  (s) => !(DOCUMENT_TERMINAL_STATUSES as readonly string[]).includes(s),
) as readonly DocumentStatus[]

// ── E-sign: contract_signatures ──────────────────────────────────────────────

export const CONTRACT_ESIGN_STATUSES = [
  "pending", "sent", "viewed", "agent_signed", "fully_signed", "voided", "declined",
] as const
export type ContractEsignStatus = (typeof CONTRACT_ESIGN_STATUSES)[number]

/** The envelope is complete. Was a file-local const in closing-war-room.ts. */
// The derived sets below are `satisfies`-checked against their ladder's type (2026-08-31): the
// two Esign vocabularies had no consumer while their subsets were hand-spelled, which is exactly
// how the portal's phantom 'out_for_signature' (documented below) survived — a subset value
// outside the ladder now fails to compile instead of silently matching nothing.
export const CONTRACT_ESIGN_DONE_STATUSES = ["fully_signed"] as const satisfies readonly ContractEsignStatus[]

/**
 * OUT WITH A SIGNER and not back — the set lib/kernel/signature-chase.ts
 * chases. Deliberately excludes 'pending', which means the envelope was never
 * sent: there is nothing to chase, and nudging on it would be a lie.
 */
export const CONTRACT_ESIGN_SENT_AWAITING_STATUSES = ["sent", "viewed", "agent_signed"] as const satisfies readonly ContractEsignStatus[]

/**
 * EVERYTHING still awaiting a signature, including the not-yet-sent envelope —
 * what a client portal should show under "documents you need to sign".
 *
 * The portal asked for `["sent", "pending", "out_for_signature"]`. Two of those
 * are real, so the list was not empty — which is precisely why nobody noticed
 * it was wrong. 'out_for_signature' is not a value the ladder has, and the set
 * silently omitted 'viewed' and 'agent_signed': a contact who OPENED the
 * envelope without signing, or whose agent had already signed, dropped off
 * their own to-sign list at the moment they engaged with it.
 */
export const CONTRACT_ESIGN_AWAITING_STATUSES = [
  "pending", ...CONTRACT_ESIGN_SENT_AWAITING_STATUSES,
] as const satisfies readonly ContractEsignStatus[]

// ── E-sign: listing_agreements (a DIFFERENT ladder — do not cross the two) ───

export const LISTING_AGREEMENT_ESIGN_STATUSES = [
  "pending", "sent", "partially_signed", "fully_signed", "voided", "declined",
] as const
export type ListingAgreementEsignStatus = (typeof LISTING_AGREEMENT_ESIGN_STATUSES)[number]

/**
 * Signed by every party. The seller-listing execution engine wrote 'executed'
 * here — not a value the column admits, and it is a REQUIRED column on that
 * insert path, so the whole listing_agreements insert was rejected and the
 * action returned its error: signing a listing agreement through the execution
 * engine could not record one. The e-sign webhook that completes the very same
 * row already writes 'fully_signed' (lib/esign-webhooks/finalize-packet.ts), so
 * this is the value the rest of the system agreed on.
 */
export const LISTING_AGREEMENT_EXECUTED_STATUS = "fully_signed" as const satisfies ListingAgreementEsignStatus
