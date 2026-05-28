// IDX Broker API Client for property search activity tracking
// Tracks what properties leads view, save, and share on IDX sites

import { resolveScopedConnection } from "@/lib/connections/resolve-scoped"

export interface NormalizedIdxListing {
  externalId: string
  address: string
  city: string | null
  state: string | null
  zip: string | null
  price: number | null
  bedrooms: number | null
  bathrooms: number | null
  squareFeet: number | null
  yearBuilt: number | null
  propertyType: string | null
  daysOnMarket: number | null
  photoUrl: string | null
}

export class IDXBrokerClient {
  private apiKey: string
  private baseUrl = "https://api.idxbroker.com"

  constructor(apiKey?: string) {
    this.apiKey = apiKey ?? process.env.IDXBROKER_API_KEY ?? ""
    if (!this.apiKey) {
      console.warn("[IDXBroker] API key not configured")
    }
  }

  /**
   * Multi-tenant factory: resolves the IDX Broker connection through the unified ownership
   * cascade (agent → team → brokerage → platform, legacy fallback), then the IDXBROKER_API_KEY
   * env as the platform default. Pass actor context to honor a per-agent/team IDX connection;
   * brokerage-only callers keep their existing behavior.
   */
  static async forBrokerage(
    brokerageId: string,
    actor?: { agentUserId?: string | null; teamId?: string | null },
  ): Promise<IDXBrokerClient> {
    const conn = await resolveScopedConnection("idxbroker", {
      agentUserId: actor?.agentUserId ?? null,
      teamId: actor?.teamId ?? null,
      brokerageId,
    }).catch(() => null)
    const apiKey = conn?.apiKey || process.env.IDXBROKER_API_KEY || ""
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

  /**
   * Normalized active-listing search for the external-listings router.
   *
   * IDX Broker's per-MLS search endpoint (`/mls/search`) requires account-specific
   * MLS ids + field mappings that are provisioned per brokerage, so a generic
   * cross-market search isn't possible from a bare API key. We pull the brokerage's
   * IDX-enabled active/featured listings (`/clients/featured`) — the set the agent
   * has rights to surface — and narrow client-side by the caller's filters. Returns
   * a normalized shape; callers map to their own listing type.
   */
  async searchActiveListings(filters: {
    city?: string
    state?: string
    zipCode?: string
    bedroomsMin?: number
    bedroomsMax?: number
    bathroomsMin?: number
    priceMin?: number
    priceMax?: number
    limit?: number
  } = {}): Promise<NormalizedIdxListing[]> {
    if (!this.apiKey) return []

    let raw: any
    try {
      const response = await fetch(`${this.baseUrl}/clients/featured`, {
        headers: { accesskey: this.apiKey, outputtype: "json" },
      })
      if (!response.ok) return []
      raw = await response.json()
    } catch (error) {
      console.error("[IDXBroker] searchActiveListings error:", error)
      return []
    }

    // IDX returns either an array or an object keyed by listing id.
    const rows: any[] = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? Object.values(raw) : []

    const num = (v: any): number | null => {
      const n = Number(String(v ?? "").replace(/[^0-9.]/g, ""))
      return Number.isFinite(n) && n > 0 ? n : null
    }
    const str = (v: any): string | null => (v == null || v === "" ? null : String(v))

    let listings: NormalizedIdxListing[] = rows.map((r) => ({
      externalId: String(r.listingID ?? r.idxID ?? r.mlsID ?? r.id ?? ""),
      address:    str(r.address ?? r.streetName) ?? "",
      city:       str(r.cityName ?? r.city),
      state:      str(r.state ?? r.stateAbbr),
      zip:        str(r.zipcode ?? r.zip),
      price:      num(r.listingPrice ?? r.price ?? r.listPrice),
      bedrooms:   num(r.bedrooms ?? r.beds),
      bathrooms:  num(r.totalBaths ?? r.bathrooms ?? r.baths),
      squareFeet: num(r.sqFt ?? r.sqft ?? r.acres),
      yearBuilt:  num(r.yearBuilt),
      propertyType: str(r.idxPropType ?? r.propType ?? r.propStatus),
      daysOnMarket: num(r.daysOnMarket ?? r.dom),
      photoUrl:   str(r.image?.["0"]?.url ?? r.image?.[0]?.url ?? r.thumbnail ?? r.photoURL),
    }))

    // Client-side narrowing.
    const cityLc = filters.city?.toLowerCase()
    const stateLc = filters.state?.toLowerCase()
    listings = listings.filter((l) => {
      if (cityLc && l.city?.toLowerCase() !== cityLc) return false
      if (stateLc && l.state?.toLowerCase() !== stateLc) return false
      if (filters.zipCode && l.zip !== filters.zipCode) return false
      if (filters.priceMin != null && (l.price ?? 0) < filters.priceMin) return false
      if (filters.priceMax != null && l.price != null && l.price > filters.priceMax) return false
      if (filters.bedroomsMin != null && (l.bedrooms ?? 0) < filters.bedroomsMin) return false
      if (filters.bedroomsMax != null && l.bedrooms != null && l.bedrooms > filters.bedroomsMax) return false
      if (filters.bathroomsMin != null && (l.bathrooms ?? 0) < filters.bathroomsMin) return false
      return true
    })

    return listings.slice(0, filters.limit ?? 50)
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
