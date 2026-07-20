/**
 * SINGLE source of truth for the "raw record → lead" eligibility gate.
 *
 * CANONICAL BUSINESS RULE (owner, round 38 — verbatim): after enrichment and the
 * second dedup pass, "if at least an email address and/or mailing address,
 * promote to a lead". A row is promoted to `leads` when it carries:
 *
 *   • an EMAIL ADDRESS, and/or
 *   • a MAILING ADDRESS (a mailing_address value, or the
 *     mailing_address_verified flag set by enrichment / address verification).
 *
 * WHAT CHANGED (round 38 alignment): the previous predicate was STRICTER than
 * the canonical rule — it required full name (first + last) AND (email OR
 * phone) AND mailing_address_verified === true. That blocked owner-canonical
 * promotions (e.g. email-only records, or mailing-address-only motivated-seller
 * records with no phone/email yet). It also let phone count as the contact
 * anchor, which the owner's rule does not. Name and phone are still captured
 * and enriched — they just no longer gate promotion. The AI ISA channel
 * resolver downstream picks reachable channels per lead (email / direct mail),
 * and `minimum_viable_for_isa` still keys off email.
 *
 * Both historical promotion paths (lib/lead-pipeline/pipeline-processor.ts and
 * lib/lead-promotion/eligibility-evaluator.ts) delegate here so they can never
 * drift apart. Returning a structured reason lets the caller log a faithful
 * skip reason.
 */
export interface LeadCandidate {
  first_name?:                string | null
  last_name?:                 string | null
  email?:                     string | null
  phone?:                     string | null
  /** The mailing address value, when the scrape/enrichment produced one. */
  mailing_address?:           string | null
  mailing_address_verified?:  boolean | null
}

export type EligibilityResult =
  | { eligible: true; via: Array<"email" | "mailing_address"> }
  | { eligible: false; reason: string; failing: "contact_anchor" }

export function evaluateCanonicalLeadEligibility(c: LeadCandidate): EligibilityResult {
  const hasEmail   = !!(c.email ?? "").trim()
  const hasMailing = !!(c.mailing_address ?? "").trim() || c.mailing_address_verified === true

  if (hasEmail || hasMailing) {
    const via: Array<"email" | "mailing_address"> = []
    if (hasEmail)   via.push("email")
    if (hasMailing) via.push("mailing_address")
    return { eligible: true, via }
  }
  return {
    eligible: false,
    failing:  "contact_anchor",
    reason:   "Needs at least an email address and/or a mailing address",
  }
}
