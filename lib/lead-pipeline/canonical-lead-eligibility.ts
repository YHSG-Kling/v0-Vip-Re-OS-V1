/**
 * SINGLE source of truth for the "raw record → lead" CONVERSION GATE.
 *
 * ── THE RULE IN FORCE (owner, wave 84, 2026-09-26), verbatim ──────────────────
 *   "if the record/row from scrapping comes in and doesnt have phone and/or email
 *    with first and last name, it can't come in as a lead - it goes in as a raw
 *    lead to dedup/enrich/dedup, etc."
 *
 * Read precisely, that is TWO tests, both of which must pass:
 *
 *   1. IDENTITY — a real FIRST NAME **and** a real LAST NAME. Both.
 *   2. REACHABILITY — a PHONE NUMBER and/or an EMAIL ADDRESS.
 *
 * Anything short of that stays a RAW lead (raw_scraped_leads,
 * processing_status 'insufficient_identity_for_promotion') and keeps cycling
 * dedup → enrich → dedup → this gate: the daily re-enrich sweep in
 * app/api/cron/lead-scraping/route.ts resets stranded rows to 'pending' (capped by
 * promotion-gate-health.ts::MAX_PROMOTION_ATTEMPTS) and processRawRecord re-runs the
 * whole flow, so a record that gains a name or a phone from PeopleData later is
 * promoted then.
 *
 * ── FAILURE IS REPORTED PER DIMENSION ────────────────────────────────────────
 *   `failing: 'name'`            — first and/or last missing, a placeholder, an
 *                                  initial or an entity. RETRYABLE: PeopleData
 *                                  backfills first_name / last_name before the
 *                                  post-enrich pass.
 *   `failing: 'contact_anchor'`  — a person's name but no phone and no email.
 *                                  Also retryable: enrichment can append either.
 *
 * `isLeadEligibleIdentity` is THE predicate. Every raw→lead promotion door calls it
 * (directly, or through `evaluateCanonicalLeadEligibility`, which is the same rule
 * with a per-dimension reason):
 *   · lib/lead-pipeline/pipeline-processor.ts  (processRawRecord — every scraper,
 *     cron, inventory radar, social scrape and the deal-room demo promote through it)
 *   · lib/lead-promotion/eligibility-core.ts    (the gated evaluator door)
 *   · lib/lead-promotion/lead-promoter.ts       (promoteRawRecordToLead — the insert
 *     refuses on its own, so a caller that skipped the evaluator still cannot mint)
 *   · lib/kernel/crm.ts                         (createLeadOnlyRecordForAcquisitionSource —
 *     gated unless the caller declares a PERSON-INITIATED inbound, see there)
 * scripts/lead-identity-gate-guard.ts proves the doors call it, with positive controls.
 *
 * ── WHAT CHANGED FROM WAVE 14, AND WHY ───────────────────────────────────────
 * The wave-14 ruling read "first name and last name and email and/or phone number
 * and/or a mailing address verified", so a VERIFIED MAILING ADDRESS was a third
 * anchor, and a Lob call at the gate (promotion-address-verification.ts) existed
 * only to turn an address into that anchor. The wave-84 ruling names phone and/or
 * email and nothing else, so:
 *   · the verified-mailing-address arm is REMOVED — a name + a verified address and
 *     no phone/email now stays raw;
 *   · TOMBSTONE — lib/lead-pipeline/promotion-address-verification.ts
 *     (verifyMailingAddressForPromotion / needsPromotionAddressVerification /
 *     interpretLobForPromotion) is DELETED. It could only ever rescue a record whose
 *     sole anchor was the address, which the ruling no longer promotes. Mailing-address
 *     verification for the direct-mail channel is untouched and lives where it always
 *     did — at the send: lib/providers/dispatch.ts (needsCassCheck → verifyAddressViaLob
 *     → interpretLobForGate from lib/providers/mailing-cass-gate.ts).
 *   · hasVerifiedMailingAddress / hasUnverifiedMailingAddress (this file) are DELETED
 *     with it — their only readers were that module and the proofs.
 *   A promoted lead still CARRIES its mailing address and the honest verified flag
 *   (pipeline-processor.ts writes both); the address is data, not an anchor.
 *
 * ── WHAT COUNTS AS A NAME (decided by lane 84C, documented, test-pinned) ─────
 * Each of first and last must be a PERSON's name part:
 *   · non-empty after trimming, with at least TWO letters — a bare initial ("J.")
 *     is not a first name; enrichment can supply the full one;
 *   · no digit, no "@", no URL — a handle or an email in a name column is not a name;
 *   · not a PLACEHOLDER — "Unknown", "Owner", "Current", "Resident", "Occupant",
 *     "Homeowner", "N/A", "None", "Null", "Test", "Anonymous", … (PLACEHOLDER_NAME_TOKENS),
 *     nor a whole placeholder phrase across both parts ("Current Resident",
 *     "Current Owner", "The Occupant");
 *   · the combined name carries no ENTITY marker — LLC, Inc, Corp, Ltd, LP/LLP, Trust,
 *     Trustee, "Estate of", Holdings, Properties, Investments, Realty, Bank,
 *     Association, Partners, Group, Capital, Ventures, Fund, "et al", "City of",
 *     "County of", HOA… (ENTITY_NAME_TOKENS). An LLC split across the two columns by
 *     a scraper ("ABC Holdings" / "LLC") is an entity, not a person; the person behind
 *     it has to be found (enrichment) before it can be a lead.
 *   · a SINGLE-TOKEN name is refused by construction: both columns are required, and a
 *     full name crammed into first_name with an empty last_name fails the last-name test.
 * Deliberately NOT treated as entity markers, because they are real surnames: "Church",
 * "Estate" alone without "of", "Co". A false refusal leaves a record raw (retryable); a
 * false admission mints a lead the ISA cannot address — the list errs toward refusal
 * only where the token is not a plausible surname.
 *
 * This module is PURE — no imports, no I/O — so the plain-`tsx` proofs call it directly.
 */
export interface LeadCandidate {
  first_name?: string | null
  last_name?:  string | null
  email?:      string | null
  phone?:      string | null
}

/** The two channels the owner's ruling admits as "reachable". */
export type ReachableChannel = "email" | "phone"

export type EligibilityResult =
  | { eligible: true; via: ReachableChannel[] }
  | { eligible: false; reason: string; failing: "name" | "contact_anchor" }

/** Name parts that are placeholders, never a person (compared lowercased, punctuation stripped). */
export const PLACEHOLDER_NAME_TOKENS: readonly string[] = [
  "unknown", "unk", "owner", "owners", "current", "resident", "residents", "occupant", "occupants",
  // "n a" is N/A after normalisation; bare "na" is deliberately absent — Na is a real surname.
  "homeowner", "homeowners", "tenant", "tenants", "n a", "none", "null", "undefined", "nil",
  "test", "testing", "anonymous", "anon", "noname", "no name", "not available", "notavailable",
  "withheld", "redacted", "fsbo", "for sale by owner", "mr", "mrs", "ms", "dr",
  // Deliberately absent: role words that are also surnames (Lead, Seller, Buyer, Client, Private).
]

/** Whole-name placeholder phrases (first + last joined). */
const PLACEHOLDER_FULL_NAMES: readonly string[] = [
  "current resident", "current owner", "current occupant", "the occupant", "the owner",
  "the resident", "property owner", "home owner", "record owner", "unknown owner",
  "unknown unknown", "first last", "firstname lastname", "john doe", "jane doe",
]

/** Tokens that mark an ENTITY rather than a person, matched as whole words in the combined name. */
export const ENTITY_NAME_TOKENS: readonly string[] = [
  "llc", "l l c", "inc", "incorporated", "corp", "corporation", "company", "ltd", "limited",
  "lp", "llp", "pllc", "plc", "trust", "trustee", "trustees", "tr", "revocable", "irrevocable",
  "estate of", "et al", "etal", "holdings", "holding", "properties", "property", "investments",
  "investment", "investors", "realty", "realtors", "bank", "mortgage", "association", "assn",
  "partners", "partnership", "group", "capital", "ventures", "fund", "reit", "hoa",
  "city of", "county of", "state of", "housing authority", "authority", "ministries",
  "foundation", "enterprises", "management", "mgmt", "development", "developers", "homes",
]

/** Lowercased, every non-letter (Unicode — "José", "O'Neil", "李") → space, spaces collapsed. */
function normToken(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\s]/gu, " ").replace(/\s+/g, " ").trim()
}

/** PURE — why a (first, last) pair is not a person's name, or null when it is. */
export function personNameProblem(first: string | null | undefined, last: string | null | undefined): string | null {
  const f = (first ?? "").trim()
  const l = (last ?? "").trim()
  if (!f || !l) return "missing first and/or last name"
  for (const [label, part] of [["first", f], ["last", l]] as const) {
    if (/[0-9@]|https?:|www\./i.test(part)) return `${label} name looks like a handle, number or address, not a name`
    // Letters in ANY script. A single CJK character is a complete name part (王, 李), so the
    // two-letter floor applies to alphabetic scripts only.
    const letters = part.match(/\p{L}/gu) ?? []
    const cjkOnly = letters.length > 0 && letters.every((ch) => /\p{Script=Han}|\p{Script=Hangul}|\p{Script=Hiragana}|\p{Script=Katakana}/u.test(ch))
    if (!cjkOnly && letters.length < 2) return `${label} name is an initial or too short`
    if (PLACEHOLDER_NAME_TOKENS.includes(normToken(part))) return `${label} name "${part}" is a placeholder`
  }
  const full = normToken(`${f} ${l}`)
  if (PLACEHOLDER_FULL_NAMES.includes(full)) return `"${f} ${l}" is a placeholder name`
  const padded = ` ${full} `
  const entity = ENTITY_NAME_TOKENS.find((t) => padded.includes(` ${t} `))
  if (entity) return `"${f} ${l}" is an entity name (${entity}), not a person`
  return null
}

export function evaluateCanonicalLeadEligibility(c: LeadCandidate): EligibilityResult {
  const nameProblem = personNameProblem(c.first_name, c.last_name)
  if (nameProblem) {
    return {
      eligible: false,
      failing:  "name",
      reason:   `Needs a real first name and last name — ${nameProblem} (enrichment can supply them before the post-enrich pass)`,
    }
  }

  const via: ReachableChannel[] = []
  if ((c.email ?? "").trim()) via.push("email")
  if ((c.phone ?? "").trim()) via.push("phone")
  if (via.length > 0) return { eligible: true, via }

  return {
    eligible: false,
    failing:  "contact_anchor",
    reason:   "Needs a phone number and/or an email address (a mailing address alone does not make a lead — owner 2026-09-26)",
  }
}

/**
 * THE predicate (owner wave 84): first name AND last name AND (phone OR email).
 * A record that fails it stays a raw lead and keeps cycling dedup → enrich → dedup.
 */
export function isLeadEligibleIdentity(c: LeadCandidate): boolean {
  return evaluateCanonicalLeadEligibility(c).eligible
}
