// IDX Broker API Client for property search activity tracking
// Tracks what properties leads view, save, and share on IDX sites

import { createServiceClient } from "@/lib/supabase/service"

export class IDXBrokerClient {
  private apiKey: string
  private baseUrl = "https://api.idxbroker.com"

  constructor(apiKey?: string) {
    this.apiKey = apiKey ?? process.env.IDXBROKER_API_KEY ?? ""
    if (!this.apiKey) {
      console.warn("[IDXBroker] API key not configured")
    }
  }

  /** Multi-tenant factory: resolves API key from platform_credentials for a brokerage. */
  static async forBrokerage(brokerageId: string): Promise<IDXBrokerClient> {
    const supabase = createServiceClient()
    const { data: cred } = await supabase
      .from("platform_credentials")
      .select("api_key")
      .eq("brokerage_id", brokerageId)
      .eq("provider_name", "idxbroker")
      .eq("is_active", true)
      .limit(1)
      .maybeSingle()
    const apiKey = cred?.api_key || process.env.IDXBROKER_API_KEY || ""
    return new IDXBrokerClient(apiKey)
  }

  isConfigured(): boolean {
    return !!this.apiKey
  }

  async getLeadActivity(email: string) {
    if (!this.apiKey) throw new Error("IDXBroker API key not configured")

    try {
      // First, find the lead by email
      const leadResponse = await fetch(`${this.baseUrl}/leads/lead?email=${encodeURIComponent(email)}`, {
        headers: {
          accesskey: this.apiKey,
          outputtype: "json",
        },
      })

      if (!leadResponse.ok) {
        console.warn("[IDXBroker] Lead not found:", email)
        return []
      }

      const lead = await leadResponse.json()

      if (!lead || !lead.id) {
        return []
      }

      // Get lead's property activity
      const activityResponse = await fetch(`${this.baseUrl}/leads/activity?leadID=${lead.id}`, {
        headers: {
          accesskey: this.apiKey,
          outputtype: "json",
        },
      })

      if (!activityResponse.ok) return []

      const activities = await activityResponse.json()

      return activities.map((activity: any) => ({
        mlsID: activity.mlsID,
        address: activity.address,
        listPrice: activity.listPrice,
        bedrooms: activity.bedrooms,
        bathrooms: activity.bathrooms,
        sqft: activity.sqft,
        propType: activity.propType,
        type: activity.action, // 'viewed', 'saved', 'shared'
        timeSpent: activity.timeOnPage || 0,
        timestamp: activity.created,
        metadata: activity,
      }))
    } catch (error) {
      console.error("[IDXBroker] Activity fetch error:", error)
      return []
    }
  }

  async getProperties(filters: { city?: string; minPrice?: number; maxPrice?: number; status?: string } = {}) {
    if (!this.apiKey) {
      console.error("[IDXBroker] API key not configured — returning empty property list")
      return []
    }

    try {
      const response = await fetch(`${this.baseUrl}/clients/featured`, {
        headers: {
          accesskey: this.apiKey,
          outputtype: "json",
        },
      })

      if (!response.ok) return []

      return await response.json()
    } catch (error) {
      console.error("[IDXBroker] Properties fetch error:", error)
      return []
    }
  }

  async searchProperties(query: string) {
    if (!this.apiKey) {
      console.error("[IDXBroker] API key not configured — returning empty search results")
      return []
    }

    try {
      const response = await fetch(`${this.baseUrl}/clients/search?query=${encodeURIComponent(query)}`, {
        headers: {
          accesskey: this.apiKey,
          outputtype: "json",
        },
      })

      if (!response.ok) return []

      return await response.json()
    } catch (error) {
      console.error("[IDXBroker] Search error:", error)
      return []
    }
  }
}
