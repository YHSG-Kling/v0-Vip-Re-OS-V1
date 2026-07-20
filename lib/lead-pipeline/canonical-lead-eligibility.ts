/**
 * SINGLE source of truth for the "raw record → lead" eligibility gate.
 *
 * CANONICAL BUSINESS RULE (owner, round 39): "the first name and last name
 * should be part of raw lead promotion to a lead" — ON TOP of the round-38
 * anchor rule ("if at least an email address and/or mailing address, promote
 * to a lead"). A row is promoted to `leads` when it carries:
 *
 *   • a FIRST NAME and a LAST NAME, and
 *   • an EMAIL ADDRESS, and/or
 *   • a MAILING ADDRESS (a mailing_address value, or the
 *     mailing_address_verified flag set by enrichment / address verification).
 *
 * Phone still does NOT count as a contact anchor (round 38, unchanged).
 *
 * WHAT CHANGED (round 39 alignment): round 38 removed the name requirement
 * entirely; the owner corrected that — the full name IS required, alongside
 * (not instead of) the email-and/or-mailing anchor. The failure is reported
 * per-dimension: `failing: 'name'` when first/last is missing (enrichment can
 * SUPPLY missing names before the post-enrich pass — enrichWithPeopleData
 * backfills first_name/last_name, so a name-failing record is retryable, not
 * terminal), `failing: 'contact_anchor'` when the email/mailing anchor is
 * missing. The AI ISA channel resolver downstream still picks reachable
 * channels per lead (email / direct mail), and `minimum_viable_for_isa`
 * still keys off email.
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
  | { eligible: false; reason: string; failing: "name" | "contact_anchor" }

export function evaluateCanonicalLeadEligibility(c: LeadCandidate): EligibilityResult {
  const hasFirst   = !!(c.first_name ?? "").trim()
  const hasLast    = !!(c.last_name ?? "").trim()
  const hasEmail   = !!(c.email ?? "").trim()
  const hasMailing = !!(c.mailing_address ?? "").trim() || c.mailing_address_verified === true

  if (!hasFirst || !hasLast) {
    return {
      eligible: false,
      failing:  "name",
      reason:   "Needs a first name and a last name (enrichment can supply them before the post-enrich pass)",
    }
  }
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
