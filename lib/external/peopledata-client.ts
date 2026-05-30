// ─── CLASS ALIAS (backward compat for callers using `new PeopleDataClient()`) ─
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
  gender?: string
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
}): Promise<{
  data: PeopleDataEnrichment | null
  cost: number
}> {
  if (!params.name && !params.phone && !params.email) {
    throw new Error('At least one of name, phone, or email required for skip trace')
  }

  // Single egress: route through the connector-gateway (one way in/out). Preserves the
  // throw-on-error contract this enrichment caller expects.
  const { callConnector } = await import("@/lib/agentic-os/connector-gateway")
  const res = await callConnector<any>({
    connector: "peopledata",
    baseUrl: PEOPLEDATA_API_URL,
    path: "person/enrich",
    method: "POST",
    auth: { style: "header", name: "X-Api-Key", value: PEOPLEDATA_API_KEY },
    body: {
      name: params.name,
      phone: params.phone,
      email: params.email,
      location: params.address,
      min_likelihood: 6,
      required: 'emails OR phones',
    },
  })

  if (!res.ok) {
    throw new Error(`PeopleData API error: ${res.status ?? "network"} ${res.error ?? ""}`.trim())
  }

  const data = res.data

  if (data.status !== 200 || !data.data) {
    return {
      data: null,
      cost: 0.10,
    }
  }

  const person = data.data

  // Derive verification flags up-front so callers (canonical lead-eligibility gate, AI-ISA channel
  // resolver) have what they need. PDL returns `likelihood` 1-10 — treat ≥7 as a strong identity
  // match. Email is "verified-as-real-person-email" when a matching/personal email surfaces on the
  // matched profile; mailing address is verified when PDL returns a structured street address with
  // city + state (street_addresses[0] preferred, location_* fallback).
  const likelihood = typeof person.likelihood === 'number' ? person.likelihood : 0
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
    !!(person.location_city  ?? primaryStreet?.locality)  &&
    !!(person.location_state ?? primaryStreet?.region)
  const mailingAddressVerified = likelihood >= 6 && hasStructuredAddress

  const enrichment: PeopleDataEnrichment = {
    fullName: person.full_name || params.name || '',
    firstName: person.first_name || '',
    lastName: person.last_name || '',
    middleName: person.middle_name,
    emails: pdlPersonalEmails.map(e => e.address),
    phones: person.phone_numbers || [],
    mobilePhone: person.mobile_phone,
    workPhone: person.work_phone,
    age: person.age,
    ageRange: person.age_range,
    gender: person.gender,
    city: person.location_city,
    state: person.location_state,
    country: person.location_country,
    zipCode: person.location_postal_code,
    address: person.location_address,
    currentEmployer: person.job_company_name,
    currentTitle: person.job_title,
    currentIndustry: person.industry,
    yearsOfExperience: person.experience_years,
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
    enrichmentConfidence: person.likelihood / 10,
    dataQualityScore: person.data_quality_score || 75,
    emailVerified,
    mailingAddressVerified,
    streetAddress,
  }

  return {
    data: enrichment,
    cost: 0.25,
  }
}
