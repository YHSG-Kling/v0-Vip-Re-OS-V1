// PeopleData API Client for demographic and social enrichment
// Enriches leads with demographics, employment, financial indicators, and life events

export class PeopleDataClient {
  private apiKey: string
  private baseUrl = "https://api.peopledata.com/v1"

  constructor() {
    this.apiKey = process.env.PEOPLEDATA_API_KEY || ""
    if (!this.apiKey) {
      console.warn("[PeopleData] API key not configured")
    }
  }

  async enrich(data: {
    email?: string
    phone?: string
    firstName?: string
    lastName?: string
  }) {
    if (!this.apiKey) throw new Error("PeopleData API key not configured")

    if (!data.email && !data.phone) {
      throw new Error("Email or phone required for enrichment")
    }

    try {
      const response = await fetch(`${this.baseUrl}/enrich`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(data),
      })

      if (!response.ok) {
        if (response.status === 404) {
          return null // No data found
        }
        throw new Error(`PeopleData error: ${response.status}`)
      }

      const result = await response.json()

      return {
        demographics: result.demographics || {},
        employment: result.employment || {},
        financial: result.financial_indicators || {},
        lifeEvents: result.life_events || [],
        social: result.social_profiles || {},
        additionalContacts: result.additional_contacts || {},
      }
    } catch (error) {
      console.error("[PeopleData] Enrichment error:", error)
      return null
    }
  }

  async bulkEnrich(contacts: Array<{ email?: string; phone?: string }>) {
    if (!this.apiKey) throw new Error("PeopleData API key not configured")

    try {
      const response = await fetch(`${this.baseUrl}/enrich/bulk`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ contacts }),
      })

      if (!response.ok) throw new Error(`PeopleData error: ${response.status}`)

      const result = await response.json()
      return result.results || []
    } catch (error) {
      console.error("[PeopleData] Bulk enrichment error:", error)
      return []
    }
  }
}
