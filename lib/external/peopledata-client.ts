// ─── CLASS ALIAS (backward compat for callers using `new PeopleDataClient()`) ─
// ONE VOCABULARY for PeopleData's per-record charge (wave 72 integration):
// the enrichment orchestrator pre-flights the vendor budget with the MATCHED
// price (the worst case a call can cost) and the ledger records what the call
// actually reported.
//
// PRICED FROM THE PUBLISHED SCHEDULE (lane 81B, Exa 2026-09-24 —
// support.peopledatalabs.com "Pricing & credits", 2025-10-24; docs.peopledatalabs.com
// "Reference - Person Enrichment API"): Person Enrichment consumes ONE credit per
// SUCCESSFUL match (HTTP 200); a 404 no-match is NOT charged ("We charge per
// match"). Pro monthly credits are $0.28 (350–2,500/mo) → $0.265 → $0.25
// (5,001–8,333/mo); annual $0.224 → $0.20. The repo keeps $0.25 as the ledger
// figure (the Pro tier a platform account lands in once volume exceeds 5k/mo —
// the monthly floor; $0.28 is the entry tier and the platform-paid ledger should
// not understate, so a re-price to 0.28 is one line here if the account stays
// under 5k). The old NO_MATCH = 0.10 was the wave-64 client's guess and booked
// $0.10 of spend PDL never bills — corrected to 0. Every reader derives from
// these two names; a third literal is the §6 defect.
// SEE ALSO lib/ai-isa/property-lookup-rail.ts::CONTACT_PROVIDER_ROUTES — the
// per-capability price table that routes owner-contact skip traces to the
// CHEAPER provider (BatchData $0.07/match) and reaches this one only as the
// fallback / for the person-profile capability BatchData does not sell.
export const PEOPLEDATA_MATCH_COST_USD = 0.25
export const PEOPLEDATA_NO_MATCH_COST_USD = 0
/** PDL Email Validation API — a separate endpoint, a separate (unpublished-in-tier)
 *  per-call price the repo has carried as $0.01 since wave 5; ONE name for it. */
export const PEOPLEDATA_EMAIL_VALIDATE_COST_USD = 0.01

export class PeopleDataClient {
  async enrich(data: { email?: string; phone?: string; firstName?: string; lastName?: string }) {
    return skipTraceWithPeopleData({
      name: data.firstName && data.lastName ? `${data.firstName} ${data.lastName}` : undefined,
      phone: data.phone,
      email: data.email,
    }).then(r => r.data)
  }
  async bulkEnrich(contacts: Array<{ email?: string; phone?: string }>) {
    return Promise.all(contacts.map(c => this.enrich(c)))
  }
}

const PEOPLEDATA_API_KEY = process.env.PEOPLEDATA_API_KEY!
const PEOPLEDATA_API_URL = 'https://api.peopledatalabs.com/v5'

export interface PeopleDataEnrichment {
  /** PDL person id (person.id) — stable provider key so we can re-pull / de-dupe without a new match. */
  peopledataId?: string
  fullName: string
  firstName: string
  lastName: string
  middleName?: string
  emails: string[]
  phones: string[]
  mobilePhone?: string
  workPhone?: string
  age?: number
  ageRange?: string
  /** Lane 83A — PDL birth_year (the source of age / ageRange). */
  birthYear?: number
  gender?: string
  /** Lane 83A — PDL inferred_salary (the person's salary band, NOT household income). */
  inferredSalary?: string
  jobTitleRole?: string
  jobTitleLevels?: string[]
  jobStartDate?: string
  metro?: string
  locationHistory?: string[]
  interests?: string[]
  city?: string
  state?: string
  country?: string
  zipCode?: string
  address?: string
  currentEmployer?: string
  currentTitle?: string
  currentIndustry?: string
  yearsOfExperience?: number
  education?: {
    school: string
    degree?: string
    major?: string
    startDate?: string
    endDate?: string
  }[]
  linkedinUrl?: string
  linkedinUsername?: string
  skills?: string[]
  certifications?: string[]
  householdIncome?: string
  netWorth?: string
  homeOwnerStatus?: 'owner' | 'renter' | 'unknown'
  homeValue?: number
  creditScoreRange?: string
  maritalStatus?: string
  childrenCount?: number
  householdSize?: number
  facebookUrl?: string
  twitterUrl?: string
  githubUrl?: string
  enrichmentConfidence: number
  dataQualityScore: number
  /** True when PDL confirmed an email on the matched person profile AND the match likelihood is
   *  high enough that we treat the email as verified for AI-ISA email channel gating. The actual
   *  bytewise validation (deliverable / hard-bounce / role) is PDL's separate email-validation
   *  endpoint — this flag is "verified-as-real-person-email" not "verified-as-deliverable". */
  emailVerified: boolean
  /** True when PDL returned a structured mailing address (street + city + state) so the AI-ISA
   *  direct_mail channel has somewhere to send and `mailing_address_verified` can be flipped on
   *  the lead row. */
  mailingAddressVerified: boolean
  /** Full structured street address (PDL street_addresses[0] when present, else built from
   *  location_* parts). Surface to UI / direct mail. */
  streetAddress?: string
  // Extended AI-enrichment fields (optional)
  demographics?: { age?: number; ageRange?: string; gender?: string; maritalStatus?: string; childrenCount?: number; householdSize?: number; education?: string; incomeLevel?: string }
  employment?: { employer?: string; title?: string; industry?: string; yearsOfExperience?: number; linkedinUrl?: string }
  financial?: { householdIncome?: string; netWorth?: string; homeOwnerStatus?: string; homeValue?: number; creditScoreRange?: string }
  life_events?: Array<{ type: string; date?: string; description?: string }>
  social_profiles?: Array<{ platform: string; url: string; username?: string }>
  additional_contacts?: Array<{ type: string; value: string; label?: string }>
  // Legacy camelCase aliases (deprecated)
  lifeEvents?: Array<{ type: string; date?: string; description?: string }>
  social?: Array<{ platform: string; url: string; username?: string }>
  additionalContacts?: Array<{ type: string; value: string; label?: string }>
}

export async function skipTraceWithPeopleData(params: {
  name?: string
  phone?: string
  email?: string
  address?: string
  /** lane 72B — a social profile URL (built from a raw lead's scraped handle by
   *  lib/lead-pipeline/social-identity-resolve.ts::deriveSocialProfileUrl). Lets
   *  a record that arrived with ONLY a post author / social handle (no name,
   *  email or phone) still be identified via PDL's `profile` match param,
   *  instead of the "at least one of name/phone/email" guard below refusing it
   *  outright. Same endpoint, same per-match price — PDL bills the match
   *  regardless of which identifying param resolved it. */
  profileUrl?: string
}): Promise<{
  data: PeopleDataEnrichment | null
  cost: number
}> {
  if (!params.name && !params.phone && !params.email && !params.profileUrl) {
    throw new Error('At least one of name, phone, email, or profileUrl required for skip trace')
  }

  // Official SDK adapter (wave 71A) — see lib/providers/peopledata/client.ts.
  // Preserves the throw-on-error contract this enrichment caller expects.
  const { enrichPerson } = await import("@/lib/providers/peopledata/client")
  const res = await enrichPerson(PEOPLEDATA_API_KEY, {
    name: params.name,
    phone: params.phone,
    email: params.email,
    location: params.address,
    profile: params.profileUrl,
    minLikelihood: 6,
    required: 'emails OR phones',
  })

  if (!res.ok) {
    throw new Error(`PeopleData API error: ${res.status ?? "network"} ${res.error ?? ""}`.trim())
  }

  const data = res.data

  if (data.status !== 200 || !data.data) {
    return {
      data: null,
      cost: PEOPLEDATA_NO_MATCH_COST_USD,
    }
  }

  return {
    // PDL returns `likelihood` on the RESPONSE envelope, beside `data` — not inside the person.
    data: mapPeopleDataPerson(data.data, { name: params.name, likelihood: (data as any).likelihood }),
    cost: PEOPLEDATA_MATCH_COST_USD,
  }
}

/** PURE — PDL birth_year / birth_date → whole years at `now` (null when PDL returned neither). */
export function pdlAgeFromBirth(birthYear: unknown, birthDate: unknown, now: Date = new Date()): number | null {
  const y = typeof birthYear === 'number' ? birthYear
    : typeof birthDate === 'string' && /^\d{4}/.test(birthDate) ? Number(birthDate.slice(0, 4))
    : null
  if (!y || y < 1900 || y > now.getUTCFullYear()) return null
  return now.getUTCFullYear() - y
}

/** PURE — the cohort band the persona / reel-brief readers parse ("35-44"). */
export function ageRangeForAge(age: number | null | undefined): string | undefined {
  if (age == null || !Number.isFinite(age)) return undefined
  const bands: Array<[number, number]> = [[18, 24], [25, 34], [35, 44], [45, 54], [55, 64], [65, 74]]
  for (const [lo, hi] of bands) if (age >= lo && age <= hi) return `${lo}-${hi}`
  return age >= 75 ? '75+' : undefined
}

/**
 * PURE — one PDL person record → PeopleDataEnrichment. Lane 83A: reads the fields PDL's person
 * schema ACTUALLY carries (docs.peopledatalabs.com person-data-field-bundles, 2026-09-26):
 * birth_year / birth_date (→ age, age_range), sex (→ gender), inferred_salary, location_locality /
 * location_region / location_postal_code / location_street_address / location_metro /
 * location_names, inferred_years_experience, job_title_role / job_title_levels / job_start_date,
 * interests. The old mapping read age / age_range / gender / location_city / location_state /
 * experience_years — names the PDL schema does not have — so those "demographics" were always
 * empty; they stay as fallbacks for a payload that does carry them.
 */
export function mapPeopleDataPerson(person: any, params: { name?: string; likelihood?: number } = {}, now: Date = new Date()): PeopleDataEnrichment {
  // Derive verification flags up-front so callers (canonical lead-eligibility gate, AI-ISA channel
  // resolver) have what they need. PDL returns `likelihood` 1-10 — treat ≥7 as a strong identity
  // match. Email is "verified-as-real-person-email" when a matching/personal email surfaces on the
  // matched profile; mailing address is verified when PDL returns a structured street address with
  // city + state (street_addresses[0] preferred, location_* fallback).
  const likelihood = typeof params.likelihood === 'number' ? params.likelihood
    : typeof person.likelihood === 'number' ? person.likelihood : 0
  const pdlEmailList: any[] = Array.isArray(person.emails) ? person.emails : []
  const pdlPersonalEmails = pdlEmailList
    .map(e => typeof e === 'string' ? { address: e, type: undefined } : e)
    .filter(e => e?.address)
  const emailVerified = likelihood >= 7 && pdlPersonalEmails.length > 0
  const pdlAddresses: any[] = Array.isArray(person.street_addresses) ? person.street_addresses : []
  const primaryStreet = pdlAddresses[0]
  const streetAddress =
    primaryStreet?.street_address
    ?? primaryStreet?.address_line_1
    ?? person.location_street_address
    ?? person.location_address
    ?? undefined
  const hasStructuredAddress =
    !!streetAddress &&
    !!(person.location_locality ?? person.location_city  ?? primaryStreet?.locality)  &&
    !!(person.location_region   ?? person.location_state ?? primaryStreet?.region)
  const mailingAddressVerified = likelihood >= 6 && hasStructuredAddress
  const age = pdlAgeFromBirth(person.birth_year, person.birth_date, now)

  const enrichment: PeopleDataEnrichment = {
    peopledataId: person.id ?? undefined,
    fullName: person.full_name || params.name || '',
    firstName: person.first_name || '',
    lastName: person.last_name || '',
    middleName: person.middle_name,
    emails: pdlPersonalEmails.map(e => e.address),
    phones: person.phone_numbers || [],
    mobilePhone: person.mobile_phone,
    workPhone: person.work_phone,
    age: typeof person.age === 'number' ? person.age : (age ?? undefined),
    ageRange: person.age_range ?? ageRangeForAge(typeof person.age === 'number' ? person.age : age),
    birthYear: typeof person.birth_year === 'number' ? person.birth_year : undefined,
    gender: person.sex ?? person.gender,
    city: person.location_locality ?? person.location_city,
    state: person.location_region ?? person.location_state,
    country: person.location_country,
    zipCode: person.location_postal_code,
    address: person.location_street_address ?? person.location_address,
    metro: person.location_metro ?? undefined,
    // location_names = every place PDL has seen the person — a mover's history (relocation signal).
    locationHistory: Array.isArray(person.location_names) ? person.location_names : undefined,
    currentEmployer: person.job_company_name,
    currentTitle: person.job_title,
    jobTitleRole: person.job_title_role ?? undefined,
    jobTitleLevels: Array.isArray(person.job_title_levels) ? person.job_title_levels : undefined,
    jobStartDate: person.job_start_date ?? undefined,
    currentIndustry: person.industry,
    yearsOfExperience: person.inferred_years_experience ?? person.experience_years,
    // PDL's inferred_salary is the PERSON's salary band ("70,000-85,000"), never a household income —
    // kept under its own name; household_income stays whatever a payload actually labels household.
    inferredSalary: person.inferred_salary ?? undefined,
    interests: Array.isArray(person.interests) ? person.interests : undefined,
    education: person.education?.map((edu: any) => ({
      school: edu.school?.name,
      degree: edu.degree,
      major: edu.major,
      startDate: edu.start_date,
      endDate: edu.end_date,
    })),
    linkedinUrl: person.linkedin_url,
    linkedinUsername: person.linkedin_username,
    skills: person.skills,
    certifications: person.certifications,
    householdIncome: person.household_income_range,
    netWorth: person.net_worth_range,
    homeOwnerStatus: person.home_owner_status,
    homeValue: person.home_value,
    creditScoreRange: person.credit_score_range,
    maritalStatus: person.marital_status,
    childrenCount: person.children_count,
    householdSize: person.household_size,
    facebookUrl: person.facebook_url,
    twitterUrl: person.twitter_url,
    githubUrl: person.github_url,
    enrichmentConfidence: likelihood / 10,
    dataQualityScore: person.data_quality_score || 75,
    emailVerified,
    mailingAddressVerified,
    streetAddress,
  }

  return enrichment
}

/**
 * PeopleData Labs Email Validation API (separate endpoint from person/enrich). Validates the
 * deliverability + risk classification of a single email, giving the canonical lead-gate +
 * AI-ISA channel resolver an authoritative `email_verified` signal instead of inferring from
 * enrichment likelihood.
 *
 * Docs: https://docs.peopledatalabs.com/docs/email-validation-api
 */
export interface EmailValidationResult {
  /** True only when status is 'valid' AND not a role/disposable address. */
  isVerified:        boolean
  /** PDL's classification: 'valid' | 'risky' | 'invalid' | 'unknown'. */
  status:            string | null
  /** Sub-category (e.g. 'mailbox_does_not_exist', 'role_account', 'catch_all'). */
  reason?:           string | null
  /** True when the address is a role account (info@, support@, …) — usable but not personal. */
  isRoleAccount?:    boolean
  /** True when the domain is a known disposable provider (mailinator, etc.). */
  isDisposable?:     boolean
  /** True when the email box is "catch-all" — deliverable but not unique to a person. */
  isCatchAll?:       boolean
  /** Raw response for audit / future schema changes. */
  raw:               unknown
}

export async function validateEmailViaPeopleData(email: string): Promise<{
  data: EmailValidationResult | null
  cost: number
}> {
  if (!email || !email.includes("@")) {
    return { data: null, cost: 0 }
  }
  // KEPT ON REST (wave 71A): `peopledatalabs@14.6.0` exposes no `email`
  // namespace at all (person/company/school/location/autocomplete/jobTitle/
  // jobPosting/ip only — confirmed by reading the SDK's bundled dist/index.cjs,
  // no "email" token anywhere in it) — the official SDK has no equivalent for
  // PDL's separate Email Validation API. Stays on the connector gateway.
  const { callConnector } = await import("@/lib/agentic-os/connector-gateway")
  const res = await callConnector<any>({
    connector: "peopledata",
    baseUrl:   PEOPLEDATA_API_URL,
    path:      "email/validate",
    method:    "GET",
    query:     { email },
    auth:      { style: "header", name: "X-Api-Key", value: PEOPLEDATA_API_KEY },
  })

  if (!res.ok || !res.data) {
    return { data: null, cost: PEOPLEDATA_EMAIL_VALIDATE_COST_USD }
  }
  const d = res.data
  const status = typeof d.status === "string" ? d.status.toLowerCase() : null
  const role = d.is_role_account === true || d.is_role === true
  const disposable = d.is_disposable === true || d.disposable === true
  const catchAll = d.is_catch_all === true || d.catch_all === true
  const isVerified = status === "valid" && !role && !disposable

  return {
    data: {
      isVerified,
      status,
      reason: d.reason ?? d.error ?? null,
      isRoleAccount: role,
      isDisposable:  disposable,
      isCatchAll:    catchAll,
      raw:           d,
    },
    cost: PEOPLEDATA_EMAIL_VALIDATE_COST_USD,
  }
}
