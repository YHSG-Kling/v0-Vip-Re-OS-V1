// lib/lead-pipeline/enrichment-column-map.ts
//
// Pure mapping: PeopleData enrichment profile (the JSONB blob we persist on
// leads.enrichment_profile / contacts.enrichment_profile) -> the FIRST-CLASS
// demographic / financial / social columns the contacts table already has.
//
// Why this exists: the orchestrator conserved the full PDL payload in the
// enrichment_profile jsonb, but nothing promoted it to the dedicated columns
// (age_range, household_income, home_owner_status, linkedin_url, life_events, …),
// so every scorer / segmenter / AI-ISA script / dashboard that reads those
// columns saw NULL even though we had the data. This makes the enrichment
// genuinely conserved AND usable, on both the enrich path and lead->contact
// promotion. No gateway/server imports — unit-testable under plain tsx.

/** The shape of the enrichment_profile JSONB blob (see enrichment-orchestrator). */
export interface EnrichmentProfileLike {
  provider?: string | null
  peopledata_id?: string | null
  age_range?: string | null
  gender?: string | null
  marital_status?: string | null
  household_income?: string | null
  employer?: string | null
  job_title?: string | null
  education?: Array<{ school?: string | null; degree?: string | null; major?: string | null }> | null
  home_owner_status?: string | null
  home_value?: number | null
  net_worth?: string | null
  credit_score_range?: string | null
  linkedin_url?: string | null
  facebook_url?: string | null
  twitter_url?: string | null
  github_url?: string | null
  life_events?: Array<{ type: string; date?: string; description?: string }> | null
  [k: string]: unknown
}

// Highest-first so the first regex that matches a degree string wins the rank.
const DEGREE_RANK: Array<[RegExp, string]> = [
  [/doctor|ph\.?\s?d|\bmd\b|\bjd\b|doctorate/i, 'Doctorate'],
  [/master|\bmba\b|m\.?\s?s\b|m\.?\s?a\b|msc/i, 'Master'],
  [/bachelor|b\.?\s?s\b|b\.?\s?a\b|bsc|undergrad/i, 'Bachelor'],
  [/associate|a\.?\s?a\b|a\.?\s?s\b/i, 'Associate'],
  [/high\s?school|ged|diploma/i, 'High School'],
]

/** Reduce a PDL education[] to a single normalized level string (most advanced degree found). */
export function deriveEducationLevel(
  education?: Array<{ degree?: string | null }> | null,
): string | null {
  if (!Array.isArray(education) || education.length === 0) return null
  let best: string | null = null
  let bestRank = -1
  for (const e of education) {
    const degree = (e?.degree ?? '').toString()
    if (!degree) continue
    for (let i = 0; i < DEGREE_RANK.length; i++) {
      const rank = DEGREE_RANK.length - i // higher = more advanced
      if (DEGREE_RANK[i][0].test(degree) && rank > bestRank) {
        bestRank = rank
        best = DEGREE_RANK[i][1]
      }
    }
  }
  return best
}

/**
 * Map an enrichment profile blob to the contacts first-class columns. Only emits a key
 * when the source value is genuinely present (no overwriting good data with null), so the
 * result can be spread straight into a contacts update/insert.
 */
export function peopleDataProfileToContactColumns(
  profile: EnrichmentProfileLike | null | undefined,
  opts?: { enrichedAt?: string },
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (!profile || typeof profile !== 'object') return out

  const set = (key: string, value: unknown) => {
    if (value === undefined || value === null) return
    if (typeof value === 'string' && value.trim() === '') return
    out[key] = value
  }

  set('age_range', profile.age_range)
  set('gender', profile.gender)
  set('occupation', profile.job_title ?? profile.employer)
  set('education_level', deriveEducationLevel(profile.education))
  set('home_owner_status', profile.home_owner_status)
  set('home_value_estimate', typeof profile.home_value === 'number' ? profile.home_value : undefined)
  // Lane 85C — the four HOUSEHOLD FINANCIAL attributes (marital status, household income, net worth,
  // modeled credit band) map through ONE function, householdFinancialContactColumns below, whichever
  // provider supplied them (BatchData demographic dataset / Versium financial append / a payload that
  // carries them). m640's net_worth_range + credit_score_range columns are the landing spots; the
  // agent-tracked credit-repair band is a different column this mapper never writes.
  Object.assign(out, householdFinancialContactColumns(profile))
  set('linkedin_url', profile.linkedin_url)
  set('facebook_url', profile.facebook_url)
  set('twitter_url', profile.twitter_url)
  set('peopledata_id', profile.peopledata_id)

  // social_handles jsonb — compact platform->url map built from whatever URLs we have.
  const social: Record<string, string> = {}
  if (profile.linkedin_url) social.linkedin = profile.linkedin_url
  if (profile.facebook_url) social.facebook = profile.facebook_url
  if (profile.twitter_url) social.twitter = profile.twitter_url
  if (profile.github_url) social.github = profile.github_url
  if (Object.keys(social).length > 0) out.social_handles = social

  if (Array.isArray(profile.life_events) && profile.life_events.length > 0) {
    out.life_events = profile.life_events
  }

  // contacts.enrichment_source = THE PROVIDER (wave 86, §6) — only a name in ENRICHMENT_PROVIDERS; a
  // profile without one was built by buildPeopleDataProfile, whose provider is PeopleData.
  out.enrichment_source = enrichmentProviderOf(profile.provider) ?? 'peopledata'
  if (opts?.enrichedAt) out.enriched_at = opts.enrichedAt

  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// THE ONE PeopleData → enrichment_profile builder (lane 83A, wave 83; owner verbatim: "we need the
// richer demographics for raw leads and leads, etc"). Was an inline object literal in
// enrichment-orchestrator.ts that ONLY the queue drain ran — the raw-record path
// (pipeline-processor.ts::enrichWithPeopleData) bought the same PDL match and then DROPPED everything
// but name/email/phone at lead creation, so a lead born from a scrape carried no demographics at all.
// Both paths now build the profile here, so a scraped lead and a drained lead carry the same blob
// the persona / outreach readers expect (lead-action-plan, ghost-reengagement, personalize-outreach
// read enrichment_profile.age / age_range / household_income).
// ─────────────────────────────────────────────────────────────────────────────

/** The PDL person fields the profile builder reads (a structural subset of PeopleDataEnrichment). */
export interface PeopleDataPersonLike {
  peopledataId?: string
  enrichmentConfidence?: number
  fullName?: string
  middleName?: string
  emails?: string[]
  phones?: string[]
  mobilePhone?: string
  workPhone?: string
  age?: number
  ageRange?: string
  birthYear?: number
  gender?: string
  maritalStatus?: string
  childrenCount?: number
  householdSize?: number
  currentEmployer?: string
  currentTitle?: string
  jobTitleRole?: string
  jobTitleLevels?: string[]
  jobStartDate?: string
  currentIndustry?: string
  yearsOfExperience?: number
  inferredSalary?: string
  education?: Array<{ school?: string; degree?: string; major?: string }> | unknown
  householdIncome?: string
  netWorth?: string
  homeOwnerStatus?: string
  homeValue?: number
  creditScoreRange?: string
  metro?: string
  locationHistory?: string[]
  interests?: string[]
  linkedinUrl?: string
  linkedinUsername?: string
  facebookUrl?: string
  twitterUrl?: string
  githubUrl?: string
  skills?: string[]
  certifications?: unknown
}

/** The DEMOGRAPHIC keys of the profile (persona / segmentation inputs) — the raw row carries these. */
export const DEMOGRAPHIC_PROFILE_FIELDS = [
  'age', 'age_range', 'birth_year', 'gender', 'marital_status', 'children_count', 'household_size',
  'employer', 'job_title', 'job_title_role', 'job_title_levels', 'job_start_date', 'industry',
  'years_of_experience', 'inferred_salary', 'education', 'household_income', 'net_worth',
  'home_owner_status', 'home_value', 'credit_score_range', 'metro', 'location_history', 'interests',
] as const

/**
 * PURE — the enrichment_profile blob for one PDL match. Only keys the provider actually returned are
 * kept (undefined / null / empty arrays dropped), so readers can coalesce safely.
 */
export function buildPeopleDataProfile(enriched: PeopleDataPersonLike, capturedAt: string = new Date().toISOString()): Record<string, any> {
  const profile: Record<string, any> = {
    provider: 'peopledata',
    peopledata_id: enriched.peopledataId,
    captured_at: capturedAt,
    confidence: enriched.enrichmentConfidence,
    full_name: enriched.fullName,
    middle_name: enriched.middleName,
    emails: enriched.emails,
    phones: enriched.phones,
    mobile_phone: enriched.mobilePhone,
    work_phone: enriched.workPhone,
    age: enriched.age,
    age_range: enriched.ageRange,
    birth_year: enriched.birthYear,
    gender: enriched.gender,
    marital_status: enriched.maritalStatus,
    children_count: enriched.childrenCount,
    household_size: enriched.householdSize,
    employer: enriched.currentEmployer,
    job_title: enriched.currentTitle,
    job_title_role: enriched.jobTitleRole,
    job_title_levels: enriched.jobTitleLevels,
    job_start_date: enriched.jobStartDate,
    industry: enriched.currentIndustry,
    years_of_experience: enriched.yearsOfExperience,
    inferred_salary: enriched.inferredSalary,
    education: enriched.education,
    household_income: enriched.householdIncome,
    net_worth: enriched.netWorth,
    home_owner_status: enriched.homeOwnerStatus,
    home_value: enriched.homeValue,
    credit_score_range: enriched.creditScoreRange,
    metro: enriched.metro,
    location_history: enriched.locationHistory,
    interests: enriched.interests,
    linkedin_url: enriched.linkedinUrl,
    linkedin_username: enriched.linkedinUsername,
    facebook_url: enriched.facebookUrl,
    twitter_url: enriched.twitterUrl,
    github_url: enriched.githubUrl,
    skills: enriched.skills,
    certifications: enriched.certifications,
    life_events: (enriched as any).life_events ?? (enriched as any).lifeEvents,
  }
  for (const k of Object.keys(profile)) {
    const v = profile[k]
    if (v === undefined || v === null) delete profile[k]
    else if (Array.isArray(v) && v.length === 0) delete profile[k]
  }
  // Wave 100 (lane 100C) — provenance per field through THE ONE writer (stampFieldProvenance), keyed by
  // the CONTACT COLUMN each value lands in (the reader's key). Built HERE so the drain, the raw-record
  // path and the contact card's "Enrich now" all carry it. Only the MAPPED columns are stamped — every
  // one of those paths writes them; contact points / name / mailing address are written by some paths
  // and not others, so the writer that lands them stamps them (peopleDataContactPointProvenance).
  const stamped = Object.keys(peopleDataProfileToContactColumns(profile))
    .filter((k) => !['enrichment_source', 'enriched_at', 'peopledata_id', 'social_handles'].includes(k))
  if (stamped.length > 0) profile.field_provenance = stampFieldProvenance(stamped, peopleDataStampInput(enriched, capturedAt))
  return profile
}

function peopleDataStampInput(enriched: PeopleDataPersonLike, capturedAt?: string): ProvenanceStampInput {
  return {
    source: 'peopledata', capability: 'person.enrich_identity', purpose: 'enrichment',
    retrievedAt: capturedAt, matchConfidence: enriched.enrichmentConfidence ?? null,
  }
}

/** PURE — provenance for the PeopleData contact points / name / mailing address a writer actually LANDED
 *  (the caller passes the column names it wrote). Same stamp as the profile's mapped columns. */
export function peopleDataContactPointProvenance(
  enriched: PeopleDataPersonLike,
  landed: Iterable<string>,
  capturedAt?: string,
): Record<string, FieldProvenance> {
  return stampFieldProvenance(landed, peopleDataStampInput(enriched, capturedAt))
}

/** PURE — the demographic subset of a profile (what a raw_scraped_leads row carries). */
export function demographicsFromProfile(profile: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (!profile) return out
  for (const k of DEMOGRAPHIC_PROFILE_FIELDS) if (profile[k] !== undefined && profile[k] !== null) out[k] = profile[k]
  return out
}

/**
 * Map an enrichment profile blob to the LEADS first-class columns (m233). Leads carry a SUBSET of
 * the contact columns — only home_owner_status + life_events are promoted here (the rest stay in
 * enrichment_profile jsonb and are extracted at lead→contact promotion). Only emits a key when the
 * source value is genuinely present, so it spreads straight into a leads update.
 */
export function peopleDataProfileToLeadColumns(
  profile: EnrichmentProfileLike | null | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (!profile || typeof profile !== 'object') return out
  if (typeof profile.home_owner_status === 'string' && profile.home_owner_status.trim() !== '') {
    out.home_owner_status = profile.home_owner_status
  }
  if (Array.isArray(profile.life_events) && profile.life_events.length > 0) {
    out.life_events = profile.life_events
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// BATCHDATA PROPERTY-ENRICHMENT DATASETS (valuation, mortgage-liens, foreclosure,
// deed, owner — lib/external/batchdata-client.ts::enrichPropertyDatasetsBatchData)
// → the SAME first-class columns PeopleData writes above, PLUS the property-fact
// JSONB columns those two tables ALREADY carry. Every key below is verified live
// against scripts/schema-snapshot.ts — PGRST204 refuses an insert/update naming
// an absent column ENTIRELY (CLAUDE.md §3), so nothing here invents one.
//
// leads has NO property_records/court_records jsonb — the nested facts land in
// enrichment_profile.batchdata_property instead (the same pattern
// freeLaneProfileBlock already uses for osint_free, enrichment-orchestrator.ts).
// contacts DOES carry a general-purpose property_records jsonb; that is its
// landing spot, so the two tables get parallel-shaped but table-appropriate patches.
// ─────────────────────────────────────────────────────────────────────────────

/** The shape enrichPropertyDatasetsBatchData returns (duplicated here, not imported,
 *  so this file stays free of the gateway-bearing lib/external import graph — see the
 *  header note above about unit-testability under plain tsx). */
export interface BatchDataPropertyEnrichmentLike {
  ok: boolean
  equityPercent: number | null
  estimatedValue: number | null
  mortgageBalance: number | null
  foreclosureStatus: string | null
  lastDeedType: string | null
  ownerOccupied: boolean | null
  /** Lane 85C — the `demographic` dataset's household financials (householdFinancialsFromBatchData). */
  householdFinancials?: HouseholdFinancials | null
}

/** Pure: BatchData property-enrichment → the first-class columns BOTH leads and
 *  contacts carry (equity_estimate, lender_status). Shared because both tables use
 *  identical names and semantics for these two — verified against schema-snapshot.ts. */
function sharedBatchDataPropertyColumns(e: BatchDataPropertyEnrichmentLike): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (typeof e.equityPercent === 'number') out.equity_estimate = e.equityPercent
  if (typeof e.foreclosureStatus === 'string' && e.foreclosureStatus.trim() !== '') out.lender_status = e.foreclosureStatus
  return out
}

/** Wave 100 (lane 100C) — the BatchData property dataset's provenance, keyed by the CONTACT column each
 *  value is displayed under (a lead's estimated_value becomes the contact's home_value_estimate at
 *  promotion, so it is stamped under that key and travels with enrichment_profile). */
function batchDataPropertyProvenance(e: BatchDataPropertyEnrichmentLike): Record<string, FieldProvenance> {
  const fields = Object.keys(sharedBatchDataPropertyColumns(e))
  if (typeof e.estimatedValue === 'number') fields.push('home_value_estimate')
  // The `demographic` dataset's household values ride the same lookup (same source, same moment).
  if (e.householdFinancials) fields.push(...Object.keys(householdFinancialContactColumns(e.householdFinancials)))
  return stampFieldProvenance(fields, { source: 'batchdata', capability: 'property.enrich_datasets', purpose: 'valuation' })
}

/** Pure: BatchData property-enrichment → leads columns + the enrichment_profile.batchdata_property
 *  nested block (leads has no dedicated property jsonb column). Lane 85C: the `demographic` dataset's
 *  household financials (the same lookup, no extra record) merge into the profile through the ONE
 *  household merge — leads carry them in enrichment_profile only (no first-class lead column). */
export function batchDataPropertyEnrichmentToLeadColumns(
  e: BatchDataPropertyEnrichmentLike | null | undefined,
  priorProfile: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  if (!e || !e.ok) return {}
  const out = sharedBatchDataPropertyColumns(e)
  if (typeof e.estimatedValue === 'number') out.estimated_value = e.estimatedValue
  const withHousehold = e.householdFinancials
    ? mergeHouseholdFinancials(priorProfile ?? {}, e.householdFinancials, 'batchdata', { prefer: 'incoming' })
    : (priorProfile ?? {})
  out.enrichment_profile = {
    ...withFieldProvenance(withHousehold, fieldProvenanceOf(withHousehold), batchDataPropertyProvenance(e)),
    batchdata_property: {
      captured_at: new Date().toISOString(),
      equity_percent: e.equityPercent,
      estimated_value: e.estimatedValue,
      mortgage_balance: e.mortgageBalance,
      foreclosure_status: e.foreclosureStatus,
      last_deed_type: e.lastDeedType,
      owner_occupied: e.ownerOccupied,
    },
  }
  return out
}

/** Pure: BatchData property-enrichment → contacts columns + the property_records jsonb
 *  column contacts already carry (verified against schema-snapshot.ts). */
export function batchDataPropertyEnrichmentToContactColumns(
  e: BatchDataPropertyEnrichmentLike | null | undefined,
  priorPropertyRecords: Record<string, unknown> | null | undefined,
  /** Wave 100 (lane 100C) — the contact's current enrichment_profile; when given, the patch carries it
   *  back with the BatchData provenance stamped (contacts keep property facts in property_records, so
   *  without this the values landed with no provenance at all). */
  priorProfile?: Record<string, unknown> | null,
): Record<string, unknown> {
  if (!e || !e.ok) return {}
  const out = sharedBatchDataPropertyColumns(e)
  if (priorProfile !== undefined) {
    out.enrichment_profile = withFieldProvenance(priorProfile, fieldProvenanceOf(priorProfile), batchDataPropertyProvenance(e))
  }
  if (typeof e.estimatedValue === 'number') out.home_value_estimate = e.estimatedValue
  // Lane 85C — the demographic dataset's household financials land on the contact's first-class
  // columns through the ONE column mapper (same function peopleDataProfileToContactColumns uses).
  if (e.householdFinancials) Object.assign(out, householdFinancialContactColumns(e.householdFinancials))
  out.property_records = {
    ...(priorPropertyRecords ?? {}),
    batchdata: {
      captured_at: new Date().toISOString(),
      equity_percent: e.equityPercent,
      estimated_value: e.estimatedValue,
      mortgage_balance: e.mortgageBalance,
      foreclosure_status: e.foreclosureStatus,
      last_deed_type: e.lastDeedType,
      owner_occupied: e.ownerOccupied,
    },
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// HOUSEHOLD FINANCIALS — marital status, household income, net worth, modeled credit band
// (lane 85C, wave 85; owner verbatim: "add marital status,household income, net worth or credit on
// enrichment and add location for contact enrichment.")
//
// ONE VOCABULARY (CLAUDE.md §6). The profile keys are the ones buildPeopleDataProfile already
// declared and every reader already reads — marital_status / household_income / net_worth /
// credit_score_range — so nothing downstream learns a second spelling. PeopleData's person schema
// does NOT carry any of the four (lane 84C finding), so until this lane the keys were declared,
// mapped and read, and never written by anything. The WRITERS are:
//   · BatchData's `demographic` property dataset (maritalStatus / income / netWorth) — ALREADY
//     BOUGHT: the seller-signal probe requests it for every lead/contact it rotates through
//     (batchdata-seller-signals.ts BATCHDATA_SIGNAL_DATASETS) and the drain's Step 6f property
//     lookup now names it in the SAME request (no extra billed record). Acquisition pulls return
//     every permitted dataset by default, so a BatchData-sourced RAW row carries it from ingest.
//   · Versium's financial append (Household Income / Estimated Net Worth / Credit Rating) — the only
//     rung that sells a CREDIT band; asked only for what is still missing (household-financials.ts).
//
// CREDIT IS A MODELED MARKETING ESTIMATE, NEVER A CONSUMER REPORT. Versium / BatchData are not
// consumer reporting agencies and their ranges are modeled from marketing data (both vendors state
// the data may not be used for FCRA-regulated eligibility decisions). normalizeModeledCreditBand
// therefore stores a BAND only (an exact score is bucketed to a 50-point band, never stored), the
// profile carries household_financials.credit_basis = MODELED_CREDIT_BASIS. WHERE THE BAND GOES
// (wave 86, owner verbatim: "add because most audience or info will be used from the contact card"):
// net worth and the credit band are SHOWN on the agent-facing contact card beside household income and
// marital status, labelled "modeled estimate" (app/actions/contact-enrichment.ts::getContactInsights →
// enrichment-panel.tsx). The credit band is NEVER an input to outbound copy, an eligibility / pricing /
// steering decision, or a persona trait (FCRA / fair lending) — scripts/enrichment-one-rail-guard.ts
// Layer 8d (the modeled-credit firewall) holds that with a positive control.
// ─────────────────────────────────────────────────────────────────────────────

export const HOUSEHOLD_FINANCIAL_FIELDS = ['marital_status', 'household_income', 'net_worth', 'credit_score_range'] as const
export type HouseholdFinancialField = typeof HOUSEHOLD_FINANCIAL_FIELDS[number]
export type HouseholdFinancials = Partial<Record<HouseholdFinancialField, string>>
/** THE enrichment PROVIDER vocabulary (§6) — one name per provider, the ledger's vendor key
 *  (vendor_usage_tracking.vendor_name). `contacts.enrichment_source` holds one of these and nothing
 *  else (wave 86, owner verbatim: "more provider unless trigger is needed"); the TRIGGER (manual /
 *  auto / import / …) is contact-enrichment-core.ts's EnrichmentTrigger and rides the ledger row's
 *  metadata, never this column. */
export const ENRICHMENT_PROVIDERS = ['peopledata', 'batchdata', 'versium'] as const
export type EnrichmentProvider = typeof ENRICHMENT_PROVIDERS[number]
/** PURE — a value as an enrichment provider, or null when it is not one (a trigger such as 'auto' /
 *  'manual', a blank, anything else). */
export function enrichmentProviderOf(value: unknown): EnrichmentProvider | null {
  const v = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return (ENRICHMENT_PROVIDERS as readonly string[]).includes(v) ? (v as EnrichmentProvider) : null
}
/** The providers that may supply a household financial — the enrichment provider vocabulary. */
export type HouseholdFinancialProvider = EnrichmentProvider

/** The provenance stamp for a credit band: a modeled range from marketing data, not a credit report. */
export const MODELED_CREDIT_BASIS = 'modeled_marketing_estimate'

/** profile key → contacts column (m640 named the two financial columns *_range). */
const HOUSEHOLD_FINANCIAL_CONTACT_COLUMN: Readonly<Record<HouseholdFinancialField, string>> = {
  marital_status: 'marital_status',
  household_income: 'household_income',
  net_worth: 'net_worth_range',
  credit_score_range: 'credit_score_range',
}

const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''

/** PURE — any provider's marital status (word or single-letter list code) → married | single |
 *  divorced | widowed | separated. Unknown / blank → null (never guessed). "Inferred" spellings and
 *  the list-industry A (inferred married) / B (inferred single) codes map to the same word. */
export function normalizeMaritalStatus(raw: unknown): string | null {
  if (typeof raw === 'boolean' || raw == null) return null
  const s = String(raw).trim().toLowerCase()
  if (!s) return null
  if (s.length === 1) return ({ m: 'married', a: 'married', s: 'single', b: 'single', d: 'divorced', w: 'widowed' } as Record<string, string>)[s] ?? null
  if (/never\s*married|un-?married|\bsingle\b/.test(s)) return 'single'
  if (/divorc/.test(s)) return 'divorced'
  if (/widow/.test(s)) return 'widowed'
  if (/separat/.test(s)) return 'separated'
  if (/married/.test(s)) return 'married'
  return null
}

/** PURE — a household income / net worth figure → the range string readers parse. A provider range
 *  string passes through trimmed; a bare number (a modeled point estimate) is formatted as dollars. */
export function normalizeMoneyRange(raw: unknown): string | null {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return `$${Math.round(raw).toLocaleString('en-US')}`
  if (nonEmpty(raw)) return raw.trim()
  return null
}

/** PURE — a modeled credit figure → a BAND. "700-749" / "700 to 749" → "700-749"; "800+" → "800+";
 *  "> 799" → "800+"; "< 550" / "under 550" → "<550"; an exact score (300–850) → its 50-point band (an
 *  exact score is never stored); a descriptor (excellent / very good / good / fair / poor) → the
 *  lower-case word. Anything else (out of range, garbage) → null. */
export function normalizeModeledCreditBand(raw: unknown): string | null {
  if (raw == null || typeof raw === 'boolean') return null
  const s = String(raw).trim().toLowerCase()
  if (!s) return null
  const inRange = (n: number) => n >= 300 && n <= 850
  const range = s.match(/(\d{3})\s*(?:-|–|to)\s*(\d{3})/)
  if (range) {
    const lo = Number(range[1]), hi = Number(range[2])
    return inRange(lo) && inRange(hi) && lo <= hi ? `${lo}-${hi}` : null
  }
  const plus = s.match(/^(\d{3})\s*(?:\+|and\s+(?:above|up)|or\s+(?:more|higher))$/)
  if (plus) return inRange(Number(plus[1])) ? `${Number(plus[1])}+` : null
  const over = s.match(/^(>=|>|over|above)\s*(\d{3})$/)
  if (over) {
    const n = Number(over[2])
    if (!inRange(n)) return null
    return over[1] === '>=' ? `${n}+` : `${n + 1}+`
  }
  const under = s.match(/^(?:<=?|under|below|less\s+than)\s*(\d{3})$/)
  if (under) return inRange(Number(under[1])) ? `<${Number(under[1])}` : null
  if (/^\d{3}$/.test(s)) {
    const n = Number(s)
    if (!inRange(n)) return null
    if (n >= 800) return '800+'
    if (n < 550) return '<550'
    const lo = Math.floor(n / 50) * 50
    return `${lo}-${lo + 49}`
  }
  const word = s.replace(/_/g, ' ')
  return ['excellent', 'very good', 'good', 'fair', 'poor'].includes(word) ? word : null
}

function normalizeHouseholdField(field: HouseholdFinancialField, raw: unknown): string | null {
  if (field === 'marital_status') return normalizeMaritalStatus(raw)
  if (field === 'credit_score_range') return normalizeModeledCreditBand(raw)
  return normalizeMoneyRange(raw)
}

/** PURE — keep only normalizable values of the four fields. */
export function normalizeHouseholdFinancials(input: Partial<Record<HouseholdFinancialField, unknown>> | null | undefined): HouseholdFinancials {
  const out: HouseholdFinancials = {}
  if (!input) return out
  for (const f of HOUSEHOLD_FINANCIAL_FIELDS) {
    const v = normalizeHouseholdField(f, input[f])
    if (v) out[f] = v
  }
  return out
}

/** PURE — BatchData's `demographic` dataset on a property row (`demographics.maritalStatus` /
 *  `maritalStatusCode` / `income` / `netWorth`, field names read live from
 *  list_property_dataset_fields 2026-09-26) → household financials. Also accepts a row that ALREADY
 *  carries the mapped block (a BatchDataRecord persisted as raw_scraped_leads.raw_data has
 *  `householdFinancials`). BatchData sells no credit band; that key is never produced here. */
export function householdFinancialsFromBatchData(row: unknown): HouseholdFinancials {
  if (!row || typeof row !== 'object') return {}
  const r = row as Record<string, any>
  if (r.householdFinancials && typeof r.householdFinancials === 'object') {
    const { credit_score_range: _never, ...rest } = r.householdFinancials as Record<string, unknown>
    return normalizeHouseholdFinancials(rest)
  }
  const d = r.demographics
  if (!d || typeof d !== 'object') return {}
  return normalizeHouseholdFinancials({
    marital_status: d.maritalStatus ?? d.maritalStatusCode,
    household_income: d.income,
    net_worth: d.netWorth,
  })
}

/** PURE — one Versium Demographic Append result (`financial` output type; field names from
 *  api-documentation.versium.com "Demographic Output Sample") → household financials. */
export function householdFinancialsFromVersium(result: unknown): HouseholdFinancials {
  if (!result || typeof result !== 'object') return {}
  const r = result as Record<string, unknown>
  return normalizeHouseholdFinancials({
    marital_status: r['Marital Status'],
    household_income: r['Household Income'],
    net_worth: r['Estimated Net Worth'],
    credit_score_range: r['Credit Rating'],
  })
}

// ─── VERSIUM DEMOGRAPHICS → THE SAME PROFILE VOCABULARY (wave 93, lane 93B3) ──────────────────
// Since 93B2 a Versium contact hit ends the enrichment chain without People Data Labs, which used to
// supply the demographic profile. Versium's Demographic Append sells the same categories (1 match
// credit per category output): `demographic` (basic — age range, gender, marital status, household,
// children, education, home ownership / value) and `financial` (household income, net worth, modeled
// credit rating). This maps them onto the SAME enrichment_profile keys PDL fills (DEMOGRAPHIC_PROFILE_
// FIELDS — §6, no second vocabulary); the four household fields go through THE ONE household merge
// (mergeHouseholdFinancials, provider 'versium'), so every reader (peopleDataProfileToContactColumns,
// peopleDataProfileToLeadColumns, demographicsFromProfile, the persona readers) reads it unchanged.
// UNRESOLVED (no live call this lane): the `demographic` output's exact field names — read
// defensively from the documented sample's spellings; an absent field stays absent, never guessed.

/** The Versium demographic output categories this repo buys, and the profile keys each one fills. */
export const VERSIUM_DEMOGRAPHIC_CATEGORY_FIELDS = {
  demographic: ['age_range', 'gender', 'marital_status', 'household_size', 'children_count', 'education', 'home_owner_status', 'home_value'],
  financial: ['household_income', 'net_worth', 'credit_score_range'],
} as const
export type VersiumDemographicCategory = keyof typeof VERSIUM_DEMOGRAPHIC_CATEGORY_FIELDS

/** PURE — the categories worth buying for a profile: a category is skipped when EVERY field it fills
 *  is already present (a credit is billed per category, so a filled category is never re-bought). */
export function versiumDemographicCategoriesNeeded(profile: Record<string, unknown> | null | undefined): VersiumDemographicCategory[] {
  const present = (k: string) => {
    const v = profile?.[k]
    return v !== undefined && v !== null && !(typeof v === 'string' && v.trim() === '')
  }
  return (Object.keys(VERSIUM_DEMOGRAPHIC_CATEGORY_FIELDS) as VersiumDemographicCategory[])
    .filter((c) => VERSIUM_DEMOGRAPHIC_CATEGORY_FIELDS[c].some((k) => !present(k)))
}

/** PURE — Versium demographic/financial results → a profile on the PDL vocabulary (provider
 *  'versium'). Only keys Versium actually returned are kept. */
export function buildVersiumDemographicProfile(
  results: Partial<Record<VersiumDemographicCategory, Record<string, unknown> | null>>,
  capturedAt: string = new Date().toISOString(),
): Record<string, any> {
  const d = (results.demographic ?? {}) as Record<string, unknown>
  const f = (results.financial ?? {}) as Record<string, unknown>
  const pick = (r: Record<string, unknown>, keys: string[]): unknown => {
    for (const k of keys) { const v = r[k]; if (v !== undefined && v !== null && !(typeof v === 'string' && v.trim() === '')) return v }
    return undefined
  }
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : undefined)
  const int = (v: unknown) => { const n = typeof v === 'number' ? v : Number(String(v ?? '').replace(/[^\d.]/g, '')); return Number.isFinite(n) && String(v ?? '').trim() !== '' ? Math.round(n) : undefined }
  const money = (v: unknown) => { const n = typeof v === 'number' ? v : Number(String(v ?? '').replace(/[$,\s]/g, '')); return Number.isFinite(n) && n > 0 ? n : undefined }
  const ownRaw = str(pick(d, ['Home Own/Rent', 'Home Own Rent', 'Homeowner Status', 'Home Owner', 'Homeowner']))?.toLowerCase()
  const homeOwner = ownRaw ? (/rent/.test(ownRaw) ? 'renter' : /own|yes|^y$/.test(ownRaw) ? 'owner' : undefined) : undefined
  const childrenRaw = pick(d, ['Number of Children', 'Children Count', 'Presence of Children'])
  const children = typeof childrenRaw === 'string' && /^(yes|y)$/i.test(childrenRaw.trim()) ? 1
    : typeof childrenRaw === 'string' && /^(no|n)$/i.test(childrenRaw.trim()) ? 0 : int(childrenRaw)
  const educationRaw = str(pick(d, ['Education Level', 'Education']))
  const profile: Record<string, any> = {
    provider: 'versium',
    captured_at: capturedAt,
    age_range: str(pick(d, ['Age Range', 'Age'])),
    gender: str(pick(d, ['Gender'])),
    household_size: int(pick(d, ['Household Size', 'Number of People in Household', 'Number of Adults in Household'])),
    children_count: children,
    education: educationRaw ? [{ degree: educationRaw }] : undefined,
    home_owner_status: homeOwner,
    home_value: money(pick(d, ['Home Market Value', 'Home Value', 'Estimated Home Value'])),
  }
  for (const k of Object.keys(profile)) if (profile[k] === undefined) delete profile[k]
  // The four household fields through THE ONE merge (marital status rides the basic output; income,
  // net worth and the MODELED credit band ride the financial output).
  return mergeHouseholdFinancials(profile, householdFinancialsFromVersium({ ...f, 'Marital Status': pick(d, ['Marital Status']) ?? f['Marital Status'] }), 'versium', { capturedAt })
}

/** PURE — the household financial values a profile already carries (top-level keys). */
export function householdFinancialsFromProfile(profile: Record<string, unknown> | null | undefined): HouseholdFinancials {
  if (!profile) return {}
  const out: HouseholdFinancials = {}
  for (const f of HOUSEHOLD_FINANCIAL_FIELDS) if (nonEmpty(profile[f])) out[f] = (profile[f] as string).trim()
  return out
}

/** PURE — which of the four a profile still lacks (drives the paid credit rung: ask only for gaps). */
export function missingHouseholdFinancials(profile: Record<string, unknown> | null | undefined): HouseholdFinancialField[] {
  const have = householdFinancialsFromProfile(profile)
  return HOUSEHOLD_FINANCIAL_FIELDS.filter((f) => !have[f])
}

/**
 * PURE — THE ONE household merge. Writes each present value at the profile's top-level key (what
 * every reader reads) and records its provider under `household_financials.sources`, plus the
 * credit basis when a band lands. `prefer: 'incoming'` (a fresh provider read) replaces a value;
 * `prefer: 'existing'` (carrying an older read forward) only fills gaps. Never mutates its input.
 */
export function mergeHouseholdFinancials(
  profile: Record<string, any> | null | undefined,
  incoming: HouseholdFinancials | null | undefined,
  provider: HouseholdFinancialProvider,
  opts: { prefer?: 'incoming' | 'existing'; capturedAt?: string } = {},
): Record<string, any> {
  const base: Record<string, any> = { ...(profile ?? {}) }
  const clean = normalizeHouseholdFinancials(incoming ?? {})
  const prior = (base.household_financials && typeof base.household_financials === 'object') ? base.household_financials as Record<string, any> : {}
  const sources: Record<string, string> = { ...(prior.sources ?? {}) }
  let wrote = false
  for (const f of HOUSEHOLD_FINANCIAL_FIELDS) {
    const v = clean[f]
    if (!v) continue
    if (opts.prefer === 'existing' && nonEmpty(base[f])) continue
    base[f] = v
    sources[f] = provider
    wrote = true
  }
  if (!wrote) return base
  base.household_financials = {
    ...prior,
    sources,
    captured_at: opts.capturedAt ?? new Date().toISOString(),
    ...(nonEmpty(base.credit_score_range) ? { credit_basis: MODELED_CREDIT_BASIS } : {}),
  }
  return base
}

/** PURE — a profile that REPLACES an older one (the drain writes enrichment_profile wholesale) keeps
 *  the older household financials it does not itself carry, with their provenance. */
export function carryForwardHouseholdFinancials(
  next: Record<string, any>,
  prior: Record<string, any> | null | undefined,
): Record<string, any> {
  const priorValues = householdFinancialsFromProfile(prior)
  if (Object.keys(priorValues).length === 0) return next
  const priorBlock = (prior?.household_financials ?? {}) as Record<string, any>
  const priorSources = (priorBlock.sources ?? {}) as Record<string, string>
  let out = next
  for (const f of HOUSEHOLD_FINANCIAL_FIELDS) {
    if (!priorValues[f]) continue
    const provider = (priorSources[f] ?? 'peopledata') as HouseholdFinancialProvider
    out = mergeHouseholdFinancials(out, { [f]: priorValues[f] }, provider, { prefer: 'existing', capturedAt: priorBlock.captured_at })
  }
  return out
}

/** PURE — THE ONE household → contacts column mapping (marital_status, household_income,
 *  net_worth_range, credit_score_range). Only present values are emitted, so it spreads safely. */
export function householdFinancialContactColumns(source: Record<string, unknown> | HouseholdFinancials | null | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  const values = normalizeHouseholdFinancials((source ?? {}) as Partial<Record<HouseholdFinancialField, unknown>>)
  for (const f of HOUSEHOLD_FINANCIAL_FIELDS) {
    const v = values[f]
    if (v) out[HOUSEHOLD_FINANCIAL_CONTACT_COLUMN[f]] = v
  }
  return out
}

// ─── FIELD PROVENANCE — THE ONE WRITER + THE ONE READER (wave 97 reader, wave 100 writer) ─────────
// Wave 96B wrote `enrichment_profile.field_provenance` (Versium email / phone / demographics, each
// { source, capability, retrievedAt, matchConfidence }) and lanes 85C/86 wrote
// `household_financials.{sources, captured_at}` — and NOTHING read either back (96B open item:
// "field_provenance has no reader yet"). fieldProvenanceForDisplay is the ONE reader; the contact card
// (app/actions/contact-enrichment.ts::getContactInsights → app/crm/contacts/[contactId]/components/
// enrichment-panel.tsx) shows it beside the enriched value. Keys are the CONTACT COLUMN the value is
// displayed under, plus `email` / `phone` / `demographics` for the Versium contact + demographic appends.
//
// WAVE 100 (lane 100C — OWNER LAW 2, OS-CONSTITUTION row 4 "every enriched field carries provenance"):
// the Versium adapter's shape is the SURVIVOR and is now the ONE shape every writer stamps through
// stampFieldProvenance — PeopleData (buildPeopleDataProfile), BatchData skip trace + property datasets
// (enrichment-orchestrator.ts / the BatchData column mappers below), RentCast/AVM values
// (app/actions/home-value.ts, lib/wealth-advisor/scan-opportunities.ts via
// lib/enrichment/field-provenance-store.ts::persistFieldProvenance), raw-record promotion
// (pipeline-processor.ts::enrichWithPeopleData — the record's own source, email-seek, Perplexity gap-fill),
// OSINT / Exa findings (contact-enrichment-core.ts), staff edits (lib/kernel/crm.ts::updateContactRecord,
// source 'staff' + actor) and contact self-edits (app/actions/portal-settings.ts, source 'contact' + actor).
// The Versium field names (source, capability, retrievedAt, matchConfidence) keep their spelling — every
// stored row and both proofs read them — and `purpose` + `actor` are ADDED (optional on read, so rows
// written before wave 100 still render). Leads carry the same jsonb and the same shape; lead→contact
// promotion copies enrichment_profile verbatim (contact-creator.ts), so the stamps travel with it.

/** Why a value was obtained — the `purpose` of a provenance stamp (one vocabulary, §6). */
const PROVENANCE_PURPOSES = [
  'enrichment',   // person enrichment (PeopleData / Versium) — the drain or the contact card's "Enrich now"
  'skip_trace',   // BatchData skip trace / reverse skip trace — contact points for a known person
  'valuation',    // AVM / CMA value on the person's property (RentCast chain, BatchData valuation)
  'acquisition',  // the value arrived with the acquired record itself (scrape / vendor list / Exa)
  'osint',        // public-web findings (Exa mentions, ZenRows people search, Perplexity gap-fill)
  'staff_edit',   // a back-office user typed it
  'self_service', // the contact typed it in their own portal
] as const
export type ProvenancePurpose = typeof PROVENANCE_PURPOSES[number]

/** THE stored provenance shape (enrichment_profile.field_provenance[<contact column>]). */
export interface FieldProvenance {
  /** Provider / origin ('peopledata', 'batchdata_skip_trace', 'versium', 'rentcast', …), or 'staff' /
   *  'contact' for a human edit. */
  source: string
  /** The capability that produced it, as the platform asks for it ('person.enrich_contact', …). */
  capability: string
  /** ISO time the value was obtained. */
  retrievedAt: string
  /** Provider match confidence ('individual' / 'household' / a 0–1 likelihood as text); null when unstated. */
  matchConfidence: string | null
  purpose?: ProvenancePurpose
  /** users.id of the human who typed it (staff / self edits); null for a provider. */
  actor?: string | null
}

export interface ProvenanceStampInput {
  source: string
  capability: string
  purpose: ProvenancePurpose
  retrievedAt?: string
  matchConfidence?: string | number | null
  actor?: string | null
}

/** PURE — one provenance stamp in THE shape. A numeric confidence is stored as text (the reader's type). */
export function fieldProvenanceStamp(input: ProvenanceStampInput): FieldProvenance {
  const mc = input.matchConfidence
  return {
    source: input.source,
    capability: input.capability,
    retrievedAt: input.retrievedAt ?? new Date().toISOString(),
    matchConfidence: typeof mc === 'number' && Number.isFinite(mc) ? String(mc) : nonEmpty(mc) ? mc.trim() : null,
    purpose: input.purpose,
    actor: input.actor ?? null,
  }
}

/** PURE — THE ONE PROVENANCE WRITER: the same stamp keyed by every field it covers (blank names dropped). */
export function stampFieldProvenance(fields: Iterable<string>, input: ProvenanceStampInput): Record<string, FieldProvenance> {
  const stamp = fieldProvenanceStamp(input)
  const out: Record<string, FieldProvenance> = {}
  for (const f of fields) if (nonEmpty(f)) out[f] = { ...stamp }
  return out
}

/** PURE — the field_provenance block a profile carries (empty object when none / malformed). */
export function fieldProvenanceOf(profile: Record<string, unknown> | null | undefined): Record<string, unknown> {
  const fp = profile && typeof profile === 'object' ? (profile as Record<string, unknown>).field_provenance : null
  return fp && typeof fp === 'object' ? (fp as Record<string, unknown>) : {}
}

/** PURE — `profile` with field_provenance = every layer merged in order (a later layer wins per field).
 *  A writer that REPLACES enrichment_profile wholesale passes the PRIOR profile's block as the first
 *  layer, so stamps it does not itself carry (a staff edit, an older Versium email) survive the replace. */
export function withFieldProvenance(
  profile: Record<string, any> | null | undefined,
  ...layers: Array<Record<string, unknown> | null | undefined>
): Record<string, any> {
  const merged: Record<string, unknown> = {}
  for (const layer of layers) {
    if (!layer || typeof layer !== 'object') continue
    for (const [k, v] of Object.entries(layer)) if (v && typeof v === 'object') merged[k] = v
  }
  const out: Record<string, any> = { ...(profile ?? {}) }
  if (Object.keys(merged).length > 0) out.field_provenance = merged
  return out
}

/** Contact columns whose provenance is FINANCIAL (CLAUDE.md §5: contacts, lenders and vendors see no
 *  financials) — dropped by the reader when `includeFinancials` is false, whichever writer stamped them. */
const FINANCIAL_PROVENANCE_KEYS: ReadonlySet<string> = new Set([
  'household_income', 'net_worth_range', 'credit_score_range', 'inferred_salary',
  'home_value_estimate', 'estimated_value', 'equity_estimate', 'lender_status', 'mortgage_balance',
])

export interface FieldProvenanceLine {
  source: string
  retrievedAt: string | null
  matchConfidence: string | null
  capability: string | null
  purpose: string | null
  actor: string | null
}

/** PURE — provenance per displayed field. `includeFinancials: false` drops income / net worth / credit
 *  band / property value (CLAUDE.md §5: contacts, lenders and vendors see no financials). Never throws
 *  on a malformed blob. */
export function fieldProvenanceForDisplay(
  profile: Record<string, unknown> | null | undefined,
  opts: { includeFinancials: boolean },
): Record<string, FieldProvenanceLine> {
  const out: Record<string, FieldProvenanceLine> = {}
  if (!profile || typeof profile !== 'object') return out
  const hf = profile.household_financials
  if (hf && typeof hf === 'object') {
    const block = hf as { sources?: Record<string, unknown>; captured_at?: unknown }
    const at = nonEmpty(block.captured_at) ? block.captured_at : null
    for (const f of HOUSEHOLD_FINANCIAL_FIELDS) {
      if (f !== 'marital_status' && !opts.includeFinancials) continue
      const src = block.sources?.[f]
      if (nonEmpty(src)) out[HOUSEHOLD_FINANCIAL_CONTACT_COLUMN[f]] = { source: src, retrievedAt: at, matchConfidence: null, capability: null, purpose: null, actor: null }
    }
  }
  const fp = profile.field_provenance
  if (fp && typeof fp === 'object') {
    for (const [key, raw] of Object.entries(fp as Record<string, unknown>)) {
      if (!raw || typeof raw !== 'object') continue
      if (!opts.includeFinancials && FINANCIAL_PROVENANCE_KEYS.has(key)) continue
      const p = raw as { source?: unknown; retrievedAt?: unknown; matchConfidence?: unknown; capability?: unknown; purpose?: unknown; actor?: unknown }
      if (!nonEmpty(p.source)) continue
      out[key] = {
        source: p.source,
        retrievedAt: nonEmpty(p.retrievedAt) ? p.retrievedAt : null,
        matchConfidence: nonEmpty(p.matchConfidence) ? p.matchConfidence : null,
        capability: nonEmpty(p.capability) ? p.capability : null,
        purpose: nonEmpty(p.purpose) ? p.purpose : null,
        actor: nonEmpty(p.actor) ? p.actor : null,
      }
    }
  }
  return out
}
