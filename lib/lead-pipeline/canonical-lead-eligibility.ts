/**
 * SINGLE source of truth for the "raw record → lead" eligibility gate.
 *
 * Canonical business rule: a row is promoted to `leads` ONLY when ALL of the following hold —
 *   1. Full name           — first_name AND last_name both non-empty.
 *   2. Contact reachability — at least one of email OR phone is present.
 *   3. Mailing-address confirmation — mailing_address_verified === true.
 *
 * Two paths historically enforced different rules (lib/lead-pipeline/pipeline-processor.ts and
 * lib/lead-promotion/lead-promoter.ts via lib/lead-promotion/eligibility-evaluator.ts). Both now
 * delegate here so they can never drift apart. Returning a structured reason lets the caller log a
 * faithful skip reason instead of the generic "missing identity".
 */
export interface LeadCandidate {
  first_name?:                string | null
  last_name?:                 string | null
  email?:                     string | null
  phone?:                     string | null
  mailing_address_verified?:  boolean | null
}

export type EligibilityResult =
  | { eligible: true }
  | { eligible: false; reason: string; failing: "name" | "contact" | "mailing_address" }

export function evaluateCanonicalLeadEligibility(c: LeadCandidate): EligibilityResult {
  const first = (c.first_name ?? "").trim()
  const last  = (c.last_name  ?? "").trim()
  if (!first || !last) {
    return { eligible: false, failing: "name", reason: "Missing full name (first + last)" }
  }
  const hasEmail = !!(c.email ?? "").trim()
  const hasPhone = !!(c.phone ?? "").trim()
  if (!hasEmail && !hasPhone) {
    return { eligible: false, failing: "contact", reason: "Missing email or phone" }
  }
  if (!c.mailing_address_verified) {
    return { eligible: false, failing: "mailing_address", reason: "Mailing address not confirmed" }
  }
  return { eligible: true }
}
