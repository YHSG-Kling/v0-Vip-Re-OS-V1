// lib/compliance/fair-housing-older-persons.ts
//
// THE HOUSING-FOR-OLDER-PERSONS (55+ / 62+) EXEMPTION — A CLAIM IS VERIFIED, NEVER ASSUMED
// (wave 143, lane 143F; owner 2026-10-22: '"55+" / "senior living" is acceptable where the
// fair-housing exemption applies — investigate the exemption conditions').
//
// WHY THIS EXISTS. The Fair Housing Act forbids a housing advertisement that states a preference or
// limitation based on FAMILIAL STATUS (42 U.S.C. § 3604(c)). "55+", "senior living", "age-restricted"
// all state such a limitation — lawful ONLY for housing that qualifies as "housing for older persons".
// Before this module the repo had two half-answers: lib/compliance-rules/fair-housing-patterns.ts flags
// "adult community" with the fix "Age-qualified community (if verified 55+)" — a fix nothing could
// verify — and lib/buyer-search/fair-housing.ts takes a `seniorCommunity` flag from its caller. Nothing
// RECORDED the conditions. So a "55+" claim was either always right (flag trusted) or always wrong.
//
// WHAT THE LAW SAYS (read 2026-10-23, quoted from the current text, not from memory):
//   · 42 U.S.C. § 3607(b)(2) — housing for older persons is one of: (A) provided under a State or
//     Federal program the Secretary determines is specifically designed and operated to assist elderly
//     persons; (B) "intended for, and solely occupied by, persons 62 years of age or older"; (C)
//     "intended and operated for occupancy by persons 55 years of age or older", where (i) at least 80
//     percent of the occupied units are occupied by at least one person who is 55 or older, (ii) the
//     facility or community publishes and adheres to policies and procedures that demonstrate the
//     intent, and (iii) it complies with HUD's rules for verification of occupancy — "reliable surveys
//     and affidavits". § 3607(b)(3) keeps pre-1988 residents and units RESERVED for qualifying
//     occupants from disqualifying it.
//   · 24 CFR 100.301–100.304 (what the exemption is, 62+, 55+; "housing facility or community" =
//     dwellings under a common set of rules — a portion of one building does not qualify), 100.305
//     (80 percent, counted over OCCUPIED units), 100.306 (policies; and "adult living" / "adult
//     community" in advertising are INCONSISTENT with 55+ intent), 100.307 (verification: reliable
//     surveys/affidavits, UPDATED AT LEAST ONCE EVERY TWO YEARS, age proof by licence / birth
//     certificate / passport / etc.), 100.308 (good-faith defence from damages for a person who relied
//     on a facility's WRITTEN, SWORN certification that it complies).
//   · STATE LAW may add conditions (several states regulate senior housing separately). Nothing here
//     decides that — `state_law_reviewed` is a human attestation the record carries, and the evaluator
//     reports it as a platform requirement, not as a statutory condition.
//
// WHAT THE PLATFORM DOES WITH IT (the owner's rule: flagged → AI rewrites with the reason → recheck →
// human approves):
//   · detectOlderPersonsClaims finds the CLAIM in public copy (never the phrase alone as a violation);
//   · assessOlderPersonsClaim joins the claim to the tenant's recorded verification for the community
//     the copy NAMES. verified → the copy passes with the record as evidence. No record / unreadable
//     read / conditions unmet or stale → the claim is HELD (a finding the AI rewrites around, then a
//     human decides) — never auto-approved, and "nobody checked" never renders as "checked and fine".
//   · The record is the tenant's own attestation under § 100.308 (the sworn certification must be on
//     file); the platform stores the conditions and their dates, it does not adjudicate eligibility.
//
// SCOPE (CLAUDE.md / owner): public listing / advertising copy, marketing video + podcast scripts, lead
// magnets, housing-ad audiences ONLY. Never a CDA, commission, agreement, ledger or closing
// reconciliation — scripts/public-media-scope-guard.ts holds that negatively.
//
// PURE: no I/O, no server-only. The persistence half is fair-housing-older-persons-store.ts.

/** The citations every finding and record carries — one spelling. */
export const OLDER_PERSONS_AUTHORITY = {
  statute: "42 U.S.C. § 3607(b)(2)–(3)",
  regulation: "24 CFR 100.300–100.308",
  readOn: "2026-10-23",
} as const

export type OlderPersonsBasis = "55_plus" | "62_plus" | "federal_state_program"
export const OLDER_PERSONS_BASES: readonly OlderPersonsBasis[] = ["55_plus", "62_plus", "federal_state_program"]

/** One tenant verification record (the shape of public.older_persons_housing_verifications). */
export interface OlderPersonsVerification {
  id?: string
  community_name: string
  basis: OlderPersonsBasis
  /** The common set of rules the community lives under (CC&Rs, HOA, condo declaration, park rules) — § 100.304. */
  governing_rules: string | null
  /** Occupied units at the survey date (an integer ≥ 1). */
  occupied_units: number | null
  /** Occupied units with at least one occupant who meets the age line (55+; for 62+ every occupied unit). */
  qualifying_units: number | null
  /** When the occupancy survey / affidavit round was completed (YYYY-MM-DD) — § 100.307 two-year clock. */
  survey_completed_on: string | null
  /** The community publishes and follows policies showing intent to operate as older-persons housing — § 100.306. */
  policies_published: boolean
  /** Where the published policy lives (document title, URL, recorded deed-restriction reference). */
  policies_reference: string | null
  /** Routine procedures exist to determine each unit's occupancy and age proof — § 100.307. */
  age_verification_procedures: boolean
  /** federal_state_program only: the programme and the determination that it is designed and operated for the elderly. */
  program_name: string | null
  program_determination_ref: string | null
  /** § 100.308: the written, sworn certification from the community's authorised representative is on file. */
  sworn_certification_on_file: boolean
  certifying_representative: string | null
  certification_date: string | null
  state: string | null
  /** A human attests the state's own senior-housing rules were checked. */
  state_law_reviewed: boolean
  verified_by?: string | null
  verified_at?: string | null
}

export type OlderPersonsConditionId =
  | "community_defined" | "eighty_percent" | "all_units_62_plus" | "intent_policies" | "age_verification_current"
  | "program_determination" | "sworn_certification" | "state_law_reviewed"

export interface OlderPersonsCondition {
  id: OlderPersonsConditionId
  met: boolean
  /** statute / regulation = the law's own condition; platform = a record this OS insists on before it will publish the claim. */
  requiredBy: "statute" | "regulation" | "platform"
  authority: string
  detail: string
}

export type OlderPersonsEvaluationStatus = "verified" | "conditions_unmet"

export interface OlderPersonsEvaluation {
  status: OlderPersonsEvaluationStatus
  basis: OlderPersonsBasis
  conditions: OlderPersonsCondition[]
  unmet: OlderPersonsCondition[]
  /** The date after which the record is stale (two years from the survey for 55+; two years from verification otherwise). */
  expiresOn: string | null
  /** Honest limits of this evaluator — what a human must still confirm. */
  caveats: string[]
}

/** § 100.305: the 80 percent line. */
export const OLDER_PERSONS_MIN_PERCENT = 80
/** § 100.307: occupancy information is refreshed at least once every two years. */
export const OLDER_PERSONS_SURVEY_MAX_AGE_YEARS = 2

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
function parseDate(s: string | null | undefined): Date | null {
  if (!s || !DATE_RE.test(s)) return null
  const d = new Date(`${s}T00:00:00Z`)
  return Number.isNaN(d.getTime()) ? null : d
}
function addYears(d: Date, years: number): Date {
  const r = new Date(d.getTime())
  r.setUTCFullYear(r.getUTCFullYear() + years)
  return r
}
function iso(d: Date): string { return d.toISOString().slice(0, 10) }
/** The two-year clock runs in whole DAYS — a survey completed on 2024-10-23 is current through 2026-10-23, not until noon. */
function startOfUtcDay(d: Date): Date { return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())) }
function nonEmpty(s: string | null | undefined): boolean { return typeof s === "string" && s.trim().length > 0 }
function isCount(n: unknown): n is number { return typeof n === "number" && Number.isInteger(n) && n >= 0 }

/** PURE. Evaluate ONE record's conditions at `now`. `verified` only when EVERY required condition is met. */
export function evaluateOlderPersonsRecord(r: OlderPersonsVerification, now: Date = new Date()): OlderPersonsEvaluation {
  const conditions: OlderPersonsCondition[] = []
  const caveats: string[] = [
    "This record is the tenant's attestation, not a legal determination — the platform stores the conditions and their dates.",
    "Reasonable local, State or Federal occupancy limits and any State senior-housing statute apply in addition (24 CFR 100.301).",
  ]
  let expiresOn: string | null = null
  const today = startOfUtcDay(now)
  const survey = parseDate(r.survey_completed_on)
  const verifiedAt = r.verified_at ? new Date(r.verified_at) : null

  conditions.push({
    id: "community_defined", requiredBy: "regulation", authority: "24 CFR 100.304",
    met: nonEmpty(r.community_name) && nonEmpty(r.governing_rules),
    detail: "A housing facility or community — dwellings under one common set of rules (CC&Rs, HOA / condo declaration, park rules). A portion of a single building does not qualify on its own.",
  })

  if (r.basis === "55_plus") {
    const occ = r.occupied_units, q = r.qualifying_units
    const countsOk = isCount(occ) && isCount(q) && occ > 0 && q <= occ
    const pct = countsOk ? (q! / occ!) * 100 : null
    conditions.push({
      id: "eighty_percent", requiredBy: "statute", authority: "42 U.S.C. § 3607(b)(2)(C)(i); 24 CFR 100.305",
      met: pct !== null && pct >= OLDER_PERSONS_MIN_PERCENT,
      detail: pct === null
        ? "Occupied units and units with a 55+ occupant must both be recorded (occupied ≥ 1, qualifying ≤ occupied)."
        : `${q} of ${occ} occupied units have a 55+ occupant (${pct.toFixed(1)}%); the line is ${OLDER_PERSONS_MIN_PERCENT}% of OCCUPIED units.`,
    })
    conditions.push({
      id: "intent_policies", requiredBy: "statute", authority: "42 U.S.C. § 3607(b)(2)(C)(ii); 24 CFR 100.306",
      met: r.policies_published === true && nonEmpty(r.policies_reference),
      detail: "The community publishes and adheres to policies and procedures showing the intent to operate as 55+ housing (advertising, lease terms, written rules / covenants, public 55+ statement) — name where they live.",
    })
    const ageOk = survey !== null && survey.getTime() <= today.getTime() && addYears(survey, OLDER_PERSONS_SURVEY_MAX_AGE_YEARS).getTime() >= today.getTime()
    expiresOn = survey ? iso(addYears(survey, OLDER_PERSONS_SURVEY_MAX_AGE_YEARS)) : null
    conditions.push({
      id: "age_verification_current", requiredBy: "statute", authority: "42 U.S.C. § 3607(b)(2)(C)(iii); 24 CFR 100.307",
      met: r.age_verification_procedures === true && ageOk,
      detail: survey === null
        ? "No occupancy survey date is recorded — reliable surveys and affidavits, refreshed at least once every two years."
        : ageOk
          ? `Occupancy survey completed ${r.survey_completed_on}; due again by ${expiresOn}.`
          : `The occupancy survey of ${r.survey_completed_on} is older than ${OLDER_PERSONS_SURVEY_MAX_AGE_YEARS} years (or in the future) — it must be refreshed.`,
    })
    caveats.push("Newly constructed housing need not meet the 80 percent line until 25 percent of units are occupied (24 CFR 100.305) — a human decides that case; this evaluator does not.")
  } else if (r.basis === "62_plus") {
    const occ = r.occupied_units, q = r.qualifying_units
    const countsOk = isCount(occ) && isCount(q) && occ > 0 && q <= occ
    conditions.push({
      id: "all_units_62_plus", requiredBy: "statute", authority: "42 U.S.C. § 3607(b)(2)(B); 24 CFR 100.303",
      met: countsOk && q === occ,
      detail: countsOk
        ? `${q} of ${occ} occupied units are solely occupied by persons 62 or older (every occupied unit must be).`
        : "Occupied units and units solely occupied by persons 62+ must both be recorded.",
    })
    conditions.push({
      id: "intent_policies", requiredBy: "regulation", authority: "42 U.S.C. § 3607(b)(2)(B) (\"intended for\"); 24 CFR 100.303",
      met: r.policies_published === true && nonEmpty(r.policies_reference),
      detail: "The housing is INTENDED for persons 62+ — name the published policy or restriction that says so.",
    })
    const base = verifiedAt && !Number.isNaN(verifiedAt.getTime()) ? verifiedAt : null
    expiresOn = base ? iso(addYears(base, OLDER_PERSONS_SURVEY_MAX_AGE_YEARS)) : null
    const fresh = base ? addYears(startOfUtcDay(base), OLDER_PERSONS_SURVEY_MAX_AGE_YEARS).getTime() >= today.getTime() : false
    conditions.push({
      id: "age_verification_current", requiredBy: "platform", authority: "platform policy (the 62+ rule carries no stated refresh interval; the 55+ two-year clock is applied)",
      met: r.age_verification_procedures === true && fresh,
      detail: fresh ? `Verified ${base ? iso(base) : "—"}; re-verify by ${expiresOn}.` : "The verification is older than two years or has no date — re-verify.",
    })
    caveats.push("Under-62 residents there on 13 Sept 1988, units reserved for 62+ and under-62 employees with substantial management duties are allowed by § 3607(b)(3) / 24 CFR 100.303 — the counts above must already account for them.")
  } else {
    conditions.push({
      id: "program_determination", requiredBy: "statute", authority: "42 U.S.C. § 3607(b)(2)(A); 24 CFR 100.302",
      met: nonEmpty(r.program_name) && nonEmpty(r.program_determination_ref),
      detail: "Provided under a State or Federal programme the Secretary has determined is specifically designed and operated to assist elderly persons — name the programme and the determination.",
    })
    const base = verifiedAt && !Number.isNaN(verifiedAt.getTime()) ? verifiedAt : null
    expiresOn = base ? iso(addYears(base, OLDER_PERSONS_SURVEY_MAX_AGE_YEARS)) : null
    const fresh = base ? addYears(startOfUtcDay(base), OLDER_PERSONS_SURVEY_MAX_AGE_YEARS).getTime() >= today.getTime() : false
    conditions.push({
      id: "age_verification_current", requiredBy: "platform", authority: "platform policy (re-verify the programme status at least every two years)",
      met: fresh,
      detail: fresh ? `Verified ${base ? iso(base) : "—"}; re-verify by ${expiresOn}.` : "The verification is older than two years or has no date — re-verify.",
    })
  }

  conditions.push({
    id: "sworn_certification", requiredBy: "platform", authority: "24 CFR 100.308",
    met: r.sworn_certification_on_file === true && nonEmpty(r.certifying_representative) && parseDate(r.certification_date) !== null,
    detail: "A written, SWORN certification from the community's authorised representative that it complies is on file (it is what lets an agent rely on the claim in good faith) — name who certified and when.",
  })
  conditions.push({
    id: "state_law_reviewed", requiredBy: "platform", authority: "State senior-housing law (varies by state)",
    met: r.state_law_reviewed === true && nonEmpty(r.state),
    detail: "A human attests the state's own senior-housing rules were checked for this community, and names the state.",
  })

  const unmet = conditions.filter((c) => !c.met)
  return { status: unmet.length === 0 ? "verified" : "conditions_unmet", basis: r.basis, conditions, unmet, expiresOn, caveats }
}

// ── The claim in public copy ─────────────────────────────────────────────────────────────────────

export interface OlderPersonsClaim {
  phrase: string
  /** age_qualified = states the housing is for older persons; inconsistent_intent = wording 24 CFR 100.306 calls inconsistent with 55+ intent. */
  kind: "age_qualified" | "inconsistent_intent"
}

// Lookbehind keeps "$55+ per sqft" and "1155+" out; (?!\d) keeps "55+5" out. Every pattern is a CLAIM about who the housing is for.
const AGE_QUALIFIED_PATTERNS: readonly RegExp[] = [
  /(?<![\d$.,])55\s?\+(?!\d)/gi,
  /(?<![\d$.,])62\s?\+(?!\d)/gi,
  /\b(?:55|62)\s*(?:and|&)\s*(?:over|older|up|better)\b/gi,
  /\b(?:55|62)[- ]plus\b/gi,
  /\b(?:over|age)\s+(?:55|62)\b/gi,
  /\bsenior\s+(?:living|community|communities|housing|apartments?|residences?|villas?)\b/gi,
  /\bage[- ](?:restricted|qualified)\b/gi,
  /\bactive[- ]adult\b/gi,
  /\bhousing\s+for\s+older\s+persons\b/gi,
  /\bretirement\s+(?:community|communities|village|living)\b/gi,
]
// 24 CFR 100.306: "adult living" / "adult community" in advertising are inconsistent with 55+ intent.
const INCONSISTENT_INTENT_PATTERNS: readonly RegExp[] = [/\badult\s+(?:living|community|communities)\b/gi]

/** PURE. The age-qualified housing CLAIMS in a piece of public copy (and the 100.306 inconsistent wordings), de-duplicated by phrase. */
export function detectOlderPersonsClaims(text: string): OlderPersonsClaim[] {
  const out: OlderPersonsClaim[] = []
  const seen = new Set<string>()
  const t = text ?? ""
  const push = (phrase: string, kind: OlderPersonsClaim["kind"]) => {
    const key = `${kind}:${phrase.toLowerCase().replace(/\s+/g, " ")}`
    if (seen.has(key)) return
    seen.add(key)
    out.push({ phrase: phrase.replace(/\s+/g, " ").trim(), kind })
  }
  for (const re of AGE_QUALIFIED_PATTERNS) for (const m of t.matchAll(re)) push(m[0], "age_qualified")
  for (const re of INCONSISTENT_INTENT_PATTERNS) for (const m of t.matchAll(re)) push(m[0], "inconsistent_intent")
  return out
}

/** A community name as a comparison key: lower-case alphanumerics only. */
export function communityKey(name: string | null | undefined): string {
  return String(name ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()
}

export type OlderPersonsClaimStatus =
  /** no age-qualified claim in the copy */
  | "none"
  /** the copy names a community whose recorded verification meets every condition today */
  | "verified"
  /** a claim, and no verification record is named by the copy (or none was supplied) — nobody checked */
  | "unverified"
  /** a claim, and the verification record could not be read — fail closed */
  | "unreadable"
  /** a claim, a record exists for the named community, and at least one condition is unmet or stale */
  | "conditions_unmet"

export interface OlderPersonsAssessment {
  status: OlderPersonsClaimStatus
  claims: OlderPersonsClaim[]
  /** The 100.306 wordings, reported whatever the status is (they are inconsistent with 55+ intent even when verified). */
  inconsistentWording: OlderPersonsClaim[]
  community: string | null
  record: { id: string | null; community_name: string; basis: OlderPersonsBasis; expiresOn: string | null } | null
  unmet: OlderPersonsCondition[]
  /** One sentence the AI rewriter and the human reviewer both read. */
  reason: string
  /** What to do — rewrite around the claim, or record the verification. */
  fix: string
}

const SETTINGS_PATH = "Settings → Compliance → Older-persons housing"

/**
 * PURE. Join the claims in `text` to the tenant's recorded verifications.
 * `records` undefined = the caller supplied none (nobody checked → unverified); "unreadable" = the read was refused.
 * Both fail closed — a claim is only ever `verified` by a record that names the community AND meets every condition.
 */
export function assessOlderPersonsClaim(
  text: string,
  records: readonly OlderPersonsVerification[] | "unreadable" | undefined,
  now: Date = new Date(),
): OlderPersonsAssessment {
  const all = detectOlderPersonsClaims(text)
  const claims = all.filter((c) => c.kind === "age_qualified")
  const inconsistentWording = all.filter((c) => c.kind === "inconsistent_intent")
  const base = { claims, inconsistentWording, community: null as string | null, record: null as OlderPersonsAssessment["record"], unmet: [] as OlderPersonsCondition[] }
  if (claims.length === 0) return { ...base, status: "none", reason: "No age-qualified housing claim.", fix: "" }

  const phrases = claims.map((c) => `"${c.phrase}"`).join(", ")
  if (records === "unreadable") {
    return { ...base, status: "unreadable", reason: `The copy claims age-qualified housing (${phrases}) and the tenant's exemption records could not be read — a claim is not published on a guess.`, fix: `Retry; or remove the age-qualified wording. Record the verification at ${SETTINGS_PATH}.` }
  }
  if (!records) {
    return { ...base, status: "unverified", reason: `The copy claims age-qualified housing (${phrases}) and no exemption verification was checked — "nobody checked" is not "checked and fine".`, fix: `Remove the age-qualified wording, or have the housing-for-older-persons exemption verified and recorded (${SETTINGS_PATH}).` }
  }
  const t = communityKey(text)
  const named = records.filter((r) => { const k = communityKey(r.community_name); return k.length >= 3 && ` ${t} `.includes(` ${k} `) })
  if (named.length === 0) {
    return { ...base, status: "unverified", reason: `The copy claims age-qualified housing (${phrases}) but names no community with a recorded exemption verification. ${OLDER_PERSONS_AUTHORITY.statute} protects a COMMUNITY that meets its conditions, not a phrase.`, fix: `Name the verified community in the copy, or remove the age-qualified wording; to add a community, record its verification at ${SETTINGS_PATH} (${OLDER_PERSONS_AUTHORITY.regulation}).` }
  }
  let best: { r: OlderPersonsVerification; ev: OlderPersonsEvaluation } | null = null
  for (const r of named) {
    const ev = evaluateOlderPersonsRecord(r, now)
    if (ev.status === "verified") {
      return { ...base, status: "verified", community: r.community_name, record: { id: r.id ?? null, community_name: r.community_name, basis: r.basis, expiresOn: ev.expiresOn }, reason: `${r.community_name} has a recorded ${r.basis.replace("_", " ")} exemption verification meeting every condition (re-verify by ${ev.expiresOn ?? "—"}).`, fix: "" }
    }
    if (!best || ev.unmet.length < best.ev.unmet.length) best = { r, ev }
  }
  const { r, ev } = best!
  return {
    ...base, status: "conditions_unmet", community: r.community_name,
    record: { id: r.id ?? null, community_name: r.community_name, basis: r.basis, expiresOn: ev.expiresOn },
    unmet: ev.unmet,
    reason: `The copy claims age-qualified housing for ${r.community_name}, whose recorded exemption verification does not meet: ${ev.unmet.map((c) => `${c.id} (${c.authority})`).join("; ")}.`,
    fix: `Remove the age-qualified wording until the verification is complete, or update the record at ${SETTINGS_PATH}.`,
  }
}

/** The line every public-copy WRITER prompt carries (lead magnet, book, podcast, video script) — proactive, not only post hoc. */
export const OLDER_PERSONS_WRITING_DIRECTIVE =
  "Never state or imply that a home or community is for older persons (55+, 62+, senior living, age-restricted, active adult, adult community) unless the brief names a community with a verified housing-for-older-persons exemption. Describe the home, never who may live there."

/** Validation of a record input (the server action's gate), PURE. Returns the problems, empty when well-formed. */
export function validateOlderPersonsInput(i: Partial<OlderPersonsVerification>): string[] {
  const p: string[] = []
  if (!nonEmpty(i.community_name)) p.push("community_name is required")
  if (!i.basis || !OLDER_PERSONS_BASES.includes(i.basis)) p.push(`basis must be one of ${OLDER_PERSONS_BASES.join(", ")}`)
  for (const k of ["occupied_units", "qualifying_units"] as const) {
    const v = i[k]
    if (v != null && !isCount(v)) p.push(`${k} must be a whole number ≥ 0`)
  }
  if (isCount(i.occupied_units) && isCount(i.qualifying_units) && i.qualifying_units > i.occupied_units) p.push("qualifying_units cannot exceed occupied_units")
  for (const k of ["survey_completed_on", "certification_date"] as const) {
    const v = i[k]
    if (v != null && v !== "" && parseDate(v) === null) p.push(`${k} must be YYYY-MM-DD`)
  }
  if (i.state != null && i.state !== "" && !/^[A-Za-z]{2}$/.test(i.state)) p.push("state must be a 2-letter code")
  return p
}
