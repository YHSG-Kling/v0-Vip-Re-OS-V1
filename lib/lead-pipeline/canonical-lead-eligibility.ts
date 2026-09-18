/**
 * SINGLE source of truth for the "raw record → lead" CONVERSION GATE.
 *
 * CANONICAL BUSINESS RULE (owner, wave 14), verbatim: "when a raw lead gets
 * converted to a lead, the gate approves only if there is a first name and last
 * name and email and/or phone number and/or a mailing address verified."
 *
 * Read precisely, that is TWO tests, both of which must pass:
 *
 *   1. IDENTITY — a FIRST NAME **and** a LAST NAME. Both. Neither is optional.
 *   2. REACHABILITY — at least ONE of three channels:
 *        • an EMAIL ADDRESS, and/or
 *        • a PHONE NUMBER, and/or
 *        • a VERIFIED MAILING ADDRESS.
 *
 * ── WHAT CHANGED, AND WHY EACH HALF MOVED ────────────────────────────────────
 * The round-38/39 gate this replaces read:
 *
 *     const hasMailing = !!(c.mailing_address ?? "").trim() || c.mailing_address_verified === true
 *     if (!hasFirst || !hasLast) …refuse…
 *     if (hasEmail || hasMailing) …promote…
 *
 * Two defects against the ruling now in force:
 *
 *   · PHONE WAS NOT AN ANCHOR. Round 38 explicitly excluded it ("Phone still
 *     does NOT count as a contact anchor"). The owner's wave-14 wording names it
 *     — "email and/or phone number and/or …" — so a named, callable person was
 *     being refused promotion for want of an email. Phone now counts.
 *   · A BARE ADDRESS STRING COUNTED AS "VERIFIED". `hasMailing` was satisfied by
 *     any non-empty scrap of an address. The ruling says VERIFIED. An
 *     unstandardized string scraped off a listing page is not a verified mailing
 *     address, and the repo already paid for that confusion once: see
 *     lib/providers/mailing-cass-gate.ts, which exists precisely because
 *     `mailing_address_verified` was being set true at promotion "merely because
 *     an address STRING exists", and direct mail then trusted it.
 *
 * ── WHAT "VERIFIED" MEANS HERE ───────────────────────────────────────────────
 * Both halves, together: an actual address STRING **and** the
 * `mailing_address_verified` flag true. A flag with no address is not something
 * you can mail to (the AI-ISA direct-mail resolver already requires
 * `lead.mailing_address && verified`), and an address with no verification is
 * exactly the scrap the ruling excludes.
 *
 * The flag's honest writer is Lob US-verification — lib/external/lob-address-verify.ts,
 * `deliverability === 'deliverable'`. At the gate the writer is
 * lib/lead-pipeline/promotion-address-verification.ts, which spends the ~$0.0025
 * ONCE, only for a record that has no email and no phone and would otherwise be
 * refused, and persists the verdict (plus Lob's standardized parts) back onto the
 * raw row. FAIL CLOSED: no LOB_API_KEY, or a transient Lob failure, verifies
 * NOTHING and the record stays raw and retryable — "nobody checked" never renders
 * as "checked and fine".
 *
 * ── FAILURE IS REPORTED PER DIMENSION ────────────────────────────────────────
 *   `failing: 'name'`            — first and/or last missing. RETRYABLE:
 *                                  enrichWithPeopleData backfills first_name /
 *                                  last_name before the post-enrich pass.
 *   `failing: 'contact_anchor'`  — no email, no phone, no verified address.
 *                                  Also retryable: enrichment can append an
 *                                  email or a phone, and the gate-side Lob check
 *                                  can verify an address on a later sweep.
 *
 * Both historical promotion paths (lib/lead-pipeline/pipeline-processor.ts and
 * lib/lead-promotion/eligibility-evaluator.ts) delegate here so they can never
 * drift apart. This module is PURE — no imports, no I/O — so the plain-`tsx`
 * simulators can call it directly.
 */
export interface LeadCandidate {
  first_name?:                string | null
  last_name?:                 string | null
  email?:                     string | null
  phone?:                     string | null
  /** The mailing address value, when the scrape/enrichment produced one. */
  mailing_address?:           string | null
  /** True ONLY when address verification (Lob) confirmed deliverability. */
  mailing_address_verified?:  boolean | null
}

/** The three channels the owner's ruling admits as "reachable". */
export type ReachableChannel = "email" | "phone" | "verified_mailing_address"

export type EligibilityResult =
  | { eligible: true; via: ReachableChannel[] }
  | { eligible: false; reason: string; failing: "name" | "contact_anchor" }

/**
 * PURE — does this candidate carry a mailing address the ruling would accept?
 * An address STRING and the verified flag. Either alone is not a verified
 * mailing address.
 *
 * Exported because the promotion paths need to answer "is it worth spending a
 * Lob verification on this record?" without re-deriving the rule.
 */
export function hasVerifiedMailingAddress(c: LeadCandidate): boolean {
  return !!(c.mailing_address ?? "").trim() && c.mailing_address_verified === true
}

/**
 * PURE — does this candidate carry an UNVERIFIED address that a verification
 * call could still turn into an anchor? Used by the gate-side writer to decide
 * whether to spend on Lob, so the spend is bounded to records that would
 * otherwise be refused.
 */
export function hasUnverifiedMailingAddress(c: LeadCandidate): boolean {
  return !!(c.mailing_address ?? "").trim() && c.mailing_address_verified !== true
}

export function evaluateCanonicalLeadEligibility(c: LeadCandidate): EligibilityResult {
  const hasFirst   = !!(c.first_name ?? "").trim()
  const hasLast    = !!(c.last_name ?? "").trim()
  const hasEmail   = !!(c.email ?? "").trim()
  const hasPhone   = !!(c.phone ?? "").trim()
  const hasMailing = hasVerifiedMailingAddress(c)

  if (!hasFirst || !hasLast) {
    return {
      eligible: false,
      failing:  "name",
      reason:   "Needs a first name and a last name (enrichment can supply them before the post-enrich pass)",
    }
  }

  const via: ReachableChannel[] = []
  if (hasEmail)   via.push("email")
  if (hasPhone)   via.push("phone")
  if (hasMailing) via.push("verified_mailing_address")
  if (via.length > 0) return { eligible: true, via }

  return {
    eligible: false,
    failing:  "contact_anchor",
    reason:   "Needs at least an email address and/or a phone number and/or a VERIFIED mailing address",
  }
}
