// BatchData API Client for property and people data enrichment
// Provides motivated seller lists, property ownership, and public records

export class BatchDataClient {
  private apiKey: string
  private baseUrl = "https://api.batchdata.com/v1"

  constructor() {
    this.apiKey = process.env.BATCHDATA_API_KEY || ""
    if (!this.apiKey) {
      console.warn("[BatchData] API key not configured")
    }
  }

  async searchByAddress(address: string, city: string, state: string) {
    if (!this.apiKey) throw new Error("BatchData API key not configured")

    try {
      const response = await fetch(`${this.baseUrl}/property/search`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ address, city, state }),
      })

      if (!response.ok) throw new Error(`BatchData error: ${response.status}`)

      const data = await response.json()
      return data.properties || []
    } catch (error) {
      console.error("[BatchData] Address search error:", error)
      return []
    }
  }

  async searchByName(firstName: string, lastName: string, city: string, state: string) {
    if (!this.apiKey) throw new Error("BatchData API key not configured")

    try {
      const response = await fetch(`${this.baseUrl}/property/owner-search`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ firstName, lastName, city, state }),
      })

      if (!response.ok) throw new Error(`BatchData error: ${response.status}`)

      const data = await response.json()
      return data.properties || []
    } catch (error) {
      console.error("[BatchData] Name search error:", error)
      return []
    }
  }

  async getMotivatedSellers(filters: { city: string; state?: string; minEquity?: number }) {
    if (!this.apiKey) throw new Error("BatchData API key not configured")

    try {
      const response = await fetch(`${this.baseUrl}/motivated-sellers`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(filters),
      })

      if (!response.ok) throw new Error(`BatchData error: ${response.status}`)

      const data = await response.json()
      return data.sellers || []
    } catch (error) {
      console.error("[BatchData] Motivated sellers error:", error)
      return []
    }
  }

  async getPropertyDetails(propertyId: string) {
    if (!this.apiKey) throw new Error("BatchData API key not configured")

    try {
      const response = await fetch(`${this.baseUrl}/property/${propertyId}`, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
        },
      })

      if (!response.ok) throw new Error(`BatchData error: ${response.status}`)

      return await response.json()
    } catch (error) {
      console.error("[BatchData] Property details error:", error)
      return null
    }
  }
}
