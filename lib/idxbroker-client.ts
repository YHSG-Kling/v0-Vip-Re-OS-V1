// IDX Broker API Client for property search activity tracking
// Tracks what properties leads view, save, and share on IDX sites

import { resolveScopedConnection } from "@/lib/connections/resolve-scoped"
import { callConnector } from "@/lib/agentic-os/connector-gateway"

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
  /**
   * The MLS listing number from the connected IDX feed. IDX Broker's raw field
   * is `mlsID` — the alert engine already keys on that spelling
   * (lib/property-alerts/idx-alert-search.ts), so it is confirmed, not guessed.
   *
   * It was previously only ever read as one of four fallbacks for `externalId`,
   * which meant that whenever `listingID` was present — the normal case — the
   * MLS number was silently discarded. A brokerage that connected IDX
   * specifically to get MLS numbers got none.
   *
   * Kept SEPARATE from externalId on purpose: externalId is a feed-local
   * identity used for dedupe, the MLS number is the industry identity a
   * consumer and a compliance officer both recognise. Collapsing them loses
   * the second.
   */
  mlsNumber: string | null
  /**
   * The feed's own status label for the row, VERBATIM (`propStatus` — e.g.
   * "Active", "Pending", "Contingent"), lowercased. Not normalized to our
   * vocabulary here: this is what the MLS said, and the CMA's comp provider is
   * the only reader that has to decide what "pending" means for a comp set.
   *
   * Kept separate from `propertyType`, which used to fall back to `propStatus`
   * and so occasionally reported a STATUS where a caller expected a TYPE.
   */
  status: string | null
}

export class IDXBrokerClient {
  private apiKey: string
  private baseUrl = "https://api.idxbroker.com"

  /**
   * The key is REQUIRED, and there is deliberately no `process.env` fallback here.
   *
   * It used to read `apiKey ?? process.env.IDXBROKER_API_KEY ?? ""`, which made
   * `new IDXBrokerClient()` a silently-working call: nine call sites across
   * app/actions/{ai-predictions,calculators,lead-intelligence}.ts constructed the
   * client with no argument and therefore ran every brokerage's property search on
   * the PLATFORM'S feed — including brokerages that had connected their own IDX
   * Broker account specifically to get their own board's data. The capability
   * (`forBrokerage`, below) was built, correct, and unreached, and nothing failed,
   * because the env fallback made the omission invisible.
   *
   * With the parameter required, that omission is a COMPILE error rather than a
   * quiet cross-tenant read. `forBrokerage` remains the only place the platform
   * env key is consulted, and it is consulted last — after the owner cascade — so
   * "the platform's key" is a documented final tier instead of a default.
   *
   * An empty string is still accepted and still means "not configured"
   * (`isConfigured()` is false, the search methods return empty and the surfaces
   * report the data as unavailable) — that is the honest end state when neither
   * the tenant nor the platform has a key, and it is NOT the same thing as a
   * missing argument.
   */
  constructor(apiKey: string) {
    this.apiKey = apiKey
    if (!this.apiKey) {
      console.warn("[IDXBroker] API key not configured")
    }
  }

  /**
   * Multi-tenant factory — THE only supported way to obtain a client, and the only
   * reader of IDXBROKER_API_KEY.
   *
   * Resolves the IDX Broker connection through the unified ownership cascade
   * (agent → team → brokerage → platform, legacy fallback) FIRST, and only then
   * falls back to the platform env key. That order is the owner ruling: IDX Broker
   * is tenant-settable (lib/connections/scope.ts lists `idxbroker` under the
   * per-tier-connectable `listing` domain), so a tenant that connected its own
   * account must be served from its own account. Reversing these two lines
   * silently restores the platform-feed bug.
   *
   * `actor.agentUserId` is a USERS.id — the id class scopeCascade files an
   * "agent"-scope credential under. `agents.id` and `contacts.id` are DISJOINT
   * spaces and are never interchangeable with it.
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

  /** All egress through the connector-gateway: accesskey header + outputtype=json. */
  private async request<T = any>(path: string, query?: Record<string, string>): Promise<{ ok: boolean; data: T | null }> {
    const res = await callConnector<T>({
      connector: "idxbroker",
      baseUrl: this.baseUrl,
      path,
      method: "GET",
      query,
      auth: { style: "header", name: "accesskey", value: this.apiKey },
      headers: { outputtype: "json" },
    })
    return { ok: res.ok, data: res.data }
  }

  async getLeadActivity(email: string) {
    if (!this.apiKey) throw new Error("IDXBroker API key not configured")

    try {
      // First, find the lead by email
      const leadResponse = await this.request<any>("/leads/lead", { email })

      if (!leadResponse.ok) {
        console.warn("[IDXBroker] Lead not found:", email)
        return []
      }

      const lead = leadResponse.data

      if (!lead || !lead.id) {
        return []
      }

      // Get lead's property activity
      const activityResponse = await this.request<any[]>("/leads/activity", { leadID: String(lead.id) })

      if (!activityResponse.ok || !activityResponse.data) return []

      const activities = activityResponse.data

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

  // getProperties(filters) was REMOVED — it was a degenerate duplicate of
  // searchActiveListings below. It advertised {city, minPrice, maxPrice, status}
  // and applied NONE of them: its whole body hit `/clients/featured` and returned
  // the raw wire rows. So every caller — whatever it asked for — got the same
  // array of the brokerage's featured ACTIVE listings. Two calls with different
  // filters were indistinguishable, and `status: "sold"` returned active listings
  // whose `soldPrice` field does not exist, so callers rendered `$undefined`.
  //
  // searchActiveListings serves the SAME endpoint but normalizes the rows into
  // NormalizedIdxListing and really does filter (city/state/zip/price/beds/baths/
  // limit). It is the survivor; every former getProperties caller now uses it.
  //
  // What this client CANNOT do, and no rewrite of it will: return SOLD comparable
  // sales. IDX Broker's per-MLS search endpoint needs account-specific MLS ids and
  // field mappings provisioned per brokerage, so a bare API key reaches only the
  // brokerage's own IDX-enabled active/featured set. Sold/market figures come from
  // the `market_data` observation table (writer: lib/intelligence/market-insight-
  // generator.ts) or the CMA engine (lib/cma/ai-cma-orchestrator.ts) — never from here.

  /**
   * Normalized active-listing search for the external-listings router.
   *
   * IDX Broker's per-MLS search endpoint (`/mls/search`) requires account-specific
   * MLS ids + field mappings that are provisioned per brokerage, so a generic
   * cross-market search isn't possible from a bare API key. We pull the brokerage's
   * IDX-enabled active/featured listings (`/clients/featured`) — the set the agent
   * has rights to surface — and narrow client-side by the caller's filters. Returns
   * a normalized shape; callers map to their own listing type.
   *
   * The rows are the brokerage's FEATURED set, which is overwhelmingly (but not
   * by contract) live inventory — a feed that leaves a home featured after it
   * goes under contract will return it here. `NormalizedIdxListing.status`
   * carries the feed's own `propStatus` verbatim so a caller that needs to tell
   * active from pending can, instead of assuming. No status FILTER is applied
   * here: that would change what every existing caller receives.
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

    let raw: unknown
    try {
      const response = await this.request<any>("/clients/featured")
      if (!response.ok) return []
      raw = response.data
    } catch (error) {
      console.error("[IDXBroker] searchActiveListings error:", error)
      return []
    }

    let listings: NormalizedIdxListing[] = idxRowsOf(raw).map(normalizeIdxRow)

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

  /**
   * THE ACCOUNT'S OWN LISTINGS, KEYED BY THE SAME externalId THE SAVE PATH STORES (wave 152, lane 152J — convergence
   * row 78). This is the ONLY listing-by-id read the provider documents, and it is a lookup inside two sets, not a
   * per-listing call:
   *
   *   · IDX Broker documents NO listing-by-id endpoint for a client key: "Nor can you submit a listing ID and get property
   *     details from the API. This is true for the Client, MLS, Partner and Leads components" (developers.idxbroker.com/
   *     getting-mls-data/), and "The IDX Broker API does not provide … Property retrieval by MLS ID. The only listing data
   *     available through the API is: Featured Listings; Listings belonging to the agent(s) on the IDX Broker account"
   *     (support.idxbroker.com "Connecting to the API", 2026-05-11). The separate BulkData beta (data-services.idxbroker.com
   *     `/beta/live/listings?idxID&listingID`, x-api-key + AccessToken) is a different licensed product this client does
   *     not hold — it is NOT called here and is never faked.
   *   · What a client key DOES reach: `/clients/featured` (the account agents' active set — exactly the set the buyer
   *     search's IDX rows come from, lib/property/external-listings-search.ts) and `/clients/soldpending` (the same
   *     agents' sold / pending set; the SoldPending return is documented beside Featured in API history v1.4.0). A saved
   *     IDX home that went under contract or sold moves from the first set into the second — a REAL status read.
   *   · Two GETs per call, no per-listing fan-out: the docs ask callers not to call per page load (500 requests / hour on
   *     Platinum), so the saved-home watch reads this ONCE per tenant per daily sweep. Free at the provider ("available to
   *     anyone with a valid API key at no extra charge"), so no spend gate applies.
   *
   * A home in NEITHER set is simply absent: absence is not a status (the caller holds it, never guesses "sold"). Photos
   * ride on the rows because the feed carries them; this method stores nothing (convergence row 84: external photos are
   * never copied). A sold/pending row wins over a featured row for the same id (the later lifecycle state).
   */
  async readAccountListingsById(): Promise<
    | { ok: true; byId: Map<string, NormalizedIdxListing & { feedSet: "featured" | "sold_pending" }>; counts: { featured: number; soldPending: number } }
    | { ok: false; error: string }
  > {
    if (!this.apiKey) return { ok: false, error: "not_configured" }
    const byId = new Map<string, NormalizedIdxListing & { feedSet: "featured" | "sold_pending" }>()
    const counts = { featured: 0, soldPending: 0 }
    for (const [path, feedSet] of [["/clients/featured", "featured"], ["/clients/soldpending", "sold_pending"]] as const) {
      let res: { ok: boolean; data: unknown }
      try {
        res = await this.request<unknown>(path)
      } catch (error) {
        return { ok: false, error: `${path} threw: ${error instanceof Error ? error.message : String(error)}` }
      }
      // A refused set is a refused READ — never "nothing in it" (a home missing from an unread set would read as absent).
      if (!res.ok) return { ok: false, error: `${path} was refused` }
      for (const r of idxRowsOf(res.data)) {
        const l = normalizeIdxRow(r)
        if (!l.externalId) continue
        // The feed's own normalized status (idxStatus) stands in when propStatus is absent — still verbatim, lowercased.
        const status = l.status ?? (r?.idxStatus == null || r.idxStatus === "" ? null : String(r.idxStatus).toLowerCase())
        byId.set(l.externalId, { ...l, status, feedSet })
        if (feedSet === "featured") counts.featured++
        else counts.soldPending++
      }
    }
    return { ok: true, byId, counts }
  }

  async searchProperties(query: string) {
    if (!this.apiKey) {
      console.error("[IDXBroker] API key not configured — returning empty search results")
      return []
    }

    try {
      const response = await this.request<any>("/clients/search", { query })
      if (!response.ok) return []
      return response.data ?? []
    } catch (error) {
      console.error("[IDXBroker] Search error:", error)
      return []
    }
  }
}

// ─── THE ONE ROW NORMALIZER (module-private; searchActiveListings and readAccountListingsById share it) ───────────────

/** IDX returns either an array or an object keyed by listing id (`"<idxID>!%<listingID>": {…}`). */
function idxRowsOf(raw: unknown): any[] {
  return Array.isArray(raw) ? raw : raw && typeof raw === "object" ? Object.values(raw as Record<string, unknown>) : []
}

function normalizeIdxRow(r: any): NormalizedIdxListing {
  const num = (v: any): number | null => {
    const n = Number(String(v ?? "").replace(/[^0-9.]/g, ""))
    return Number.isFinite(n) && n > 0 ? n : null
  }
  const str = (v: any): string | null => (v == null || v === "" ? null : String(v))
  return {
    // The SAME identity the buyer search hands the save path (lib/buyer-search/external-match.ts external_property_id).
    externalId: String(r?.listingID ?? r?.idxID ?? r?.mlsID ?? r?.id ?? ""),
    address:    str(r?.address ?? r?.streetName) ?? "",
    city:       str(r?.cityName ?? r?.city),
    state:      str(r?.state ?? r?.stateAbbr),
    zip:        str(r?.zipcode ?? r?.zip),
    price:      num(r?.listingPrice ?? r?.price ?? r?.listPrice),
    bedrooms:   num(r?.bedrooms ?? r?.beds),
    bathrooms:  num(r?.totalBaths ?? r?.bathrooms ?? r?.baths),
    squareFeet: num(r?.sqFt ?? r?.sqft ?? r?.acres),
    yearBuilt:  num(r?.yearBuilt),
    // propStatus was in this fallback chain and is NOT a property type — a row
    // with no idxPropType/propType reported "Active" as its property type. It
    // has its own field now.
    propertyType: str(r?.idxPropType ?? r?.propType),
    daysOnMarket: num(r?.daysOnMarket ?? r?.dom),
    photoUrl:   str(r?.image?.["0"]?.url ?? r?.image?.[0]?.url ?? r?.thumbnail ?? r?.photoURL),
    mlsNumber:  str(r?.mlsID ?? r?.mlsNumber ?? r?.listingID),
    status:     str(r?.propStatus ?? r?.status)?.toLowerCase() ?? null,
  }
}
