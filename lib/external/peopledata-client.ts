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

  const response = await fetch(`${PEOPLEDATA_API_URL}/person/enrich`, {
    method: 'POST',
    headers: {
      'X-Api-Key': PEOPLEDATA_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: params.name,
      phone: params.phone,
      email: params.email,
      location: params.address,
      min_likelihood: 6,
      required: 'emails OR phones',
    }),
  })

  if (!response.ok) {
    throw new Error(`PeopleData API error: ${response.status} ${response.statusText}`)
  }

  const data = await response.json()

  if (data.status !== 200 || !data.data) {
    return {
      data: null,
      cost: 0.10,
    }
  }

  const person = data.data

  const enrichment: PeopleDataEnrichment = {
    fullName: person.full_name || params.name || '',
    firstName: person.first_name || '',
    lastName: person.last_name || '',
    middleName: person.middle_name,
    emails: person.emails || [],
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
  }

  return {
    data: enrichment,
    cost: 0.25,
  }
}
