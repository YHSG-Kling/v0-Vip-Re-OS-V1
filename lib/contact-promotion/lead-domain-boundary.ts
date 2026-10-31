/**
 * lib/contact-promotion/lead-domain-boundary.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * WAVE 145 CONTRACT C2 — THE LEAD / CONTACT BOUNDARY, as the two names every
 * lane that evaluates a lead calls (lane 145F's signals, this lane's speed-to-lead
 * and life-change responder).
 *
 * OWNER RULING 15 (2026-10-27), verbatim: "Leads are only evaluated without a
 * contact_id; if a contact_id is present, then communication ends in the lead
 * table and continues in the contact table as a contact."
 *
 * NO SECOND RULE. The boundary already exists and is proven:
 * lib/contact-promotion/conversion-finality.ts `conversionVerdictForRow` (THE one
 * conversion guard, `npm run test:conversion-finality`) keys on `leads.contact_id`
 * — the one marker every converter writes — and FAILS CLOSED on an unreadable
 * row. This module only names the two questions the wave-145 contract asks of it
 * and answers both FROM that verdict, so the boundary cannot drift into a second
 * spelling (CLAUDE.md §6):
 *
 *   isInLeadDomain(lead)     may a LEAD-keyed evaluation / queue / send run?
 *                            true only for a readable lead row with no contact_id.
 *   canonicalPartyFor(lead)  who does the journey continue on? the lead while it
 *                            is open; its CONTACT once converted (history and
 *                            attribution stay on the lead row as provenance —
 *                            nothing here writes); `unresolved` (never "the
 *                            lead") when the row could not be read.
 *
 * The batch shape (a sweep that SELECTS leads) stays conversion-finality's
 * `excludeConvertedLeads` — the `.is("contact_id", null)` predicate — which is
 * the same rule applied before the row is read.
 *
 * PURE. No I/O, never throws; safe in any module graph (no server-only import).
 */
import { conversionVerdictForRow, type LeadConversionRow } from "./conversion-finality"

/** The party a lead-originated action is answered on (owner ruling 15). */
export type CanonicalParty =
  /** The lead is still open (no contact_id) — the LEAD domain owns the action. */
  | { type: "lead"; id: string; leadId: string }
  /** The lead converted — the CONTACT owns every action; `leadId` is kept as provenance only. */
  | { type: "contact"; id: string; leadId: string | null }
  /** The row could not be read / carries no id — FAIL CLOSED: neither domain acts on a guess. */
  | { type: "unresolved"; id: null; leadId: string | null; reason: string }

/**
 * May a LEAD-keyed evaluation, queue or send run for this row? Only while the lead
 * has no canonical contact. A null / unread row is NOT open (fail closed).
 */
export function isInLeadDomain(lead: LeadConversionRow | null | undefined): boolean {
  return conversionVerdictForRow(lead, lead?.id ?? null).allowed
}

/**
 * The party the journey continues on. A converted lead resolves to its contact
 * (the contact gets the action — never dropped); an open lead to itself; an
 * unread row to `unresolved` with the guard's own reason.
 */
export function canonicalPartyFor(lead: LeadConversionRow | null | undefined): CanonicalParty {
  const leadId = (lead?.id ?? null) as string | null
  const verdict = conversionVerdictForRow(lead, leadId)
  if (verdict.allowed) {
    return leadId
      ? { type: "lead", id: leadId, leadId }
      : { type: "unresolved", id: null, leadId: null, reason: "the lead row carries no id — nothing to act on" }
  }
  if (verdict.contactId) return { type: "contact", id: verdict.contactId, leadId }
  return { type: "unresolved", id: null, leadId, reason: verdict.reason }
}
