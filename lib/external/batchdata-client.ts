// ─── CLASS ALIAS (backward compat for callers using `new BatchDataClient()`) ──
export class BatchDataClient {
  async searchByAddress(address: string, city: string, state: string) {
    return searchProperties(`${address}, ${city}, ${state}`).then(r => r.matches)
  }
  async searchByName(firstName: string, lastName: string, city: string, state: string) {
    return fetchMotivatedSellers({ state }).then(r => r.records)
  }
  async getMotivatedSellers(filters: { city: string; state?: string; minEquity?: number }) {
    return fetchMotivatedSellers({ state: filters.state || "" }).then(r => r.records)
  }
  async getPropertyDetails(propertyId: string) {
    return enrichPropertyWithBatchData(propertyId).then(r => r)
  }
  /**
   * Alias used by the lead-scraping cron.
   * Accepts a "City, State" string, splits it, and delegates to fetchMotivatedSellers.
   * Returns the records array directly so callers can iterate without unwrapping.
   */
  async getMotivatedSellerData(location: string): Promise<BatchDataRecord[]> {
    const [city, state] = location.includes(',')
      ? location.split(',').map(s => s.trim())
      : [location, '']
    return fetchMotivatedSellers({ state: state || location }).then(r => r.records)
  }
}

const BATCHDATA_API_KEY = process.env.BATCHDATA_API_KEY!
const BATCHDATA_API_URL = 'https://api.batchdata.com/api/v1'

export interface BatchDataRecord {
  [key: string]: unknown  // enables cast to Record<string, unknown>
  firstName: string
  lastName: string
  phone: string | null
  email: string | null
  address: string
  city: string
  state: string
  zip: string
  propertyAddress?: string
  propertyCity?: string
  propertyState?: string
  propertyZip?: string
  beds?: number
  baths?: number
  sqft?: number
  estimatedValue?: number
  // The full motivated-seller spectrum BatchData covers — downsizers (high
  // equity), divorce, foreclosure / pre-foreclosure, tax lien, expired listings,
  // investor/absentee owners, vacant, and tired landlords.
  motivationType: 'probate' | 'divorce' | 'foreclosure' | 'tax_lien' | 'pre_foreclosure' | 'distressed' | 'high_equity' | 'absentee' | 'expired' | 'vacant' | 'tired_landlord'
  motivationConfidence: number
}

/** Full motivated-seller trigger set requested by default (BatchData = the comprehensive seller source). */
export const BATCHDATA_MOTIVATION_TYPES = [
  'probate', 'divorce', 'foreclosure', 'pre_foreclosure', 'tax_lien',
  'high_equity', 'absentee', 'expired', 'vacant', 'tired_landlord',
] as const

// Maps our internal motivation types to BatchData Property Search `quickLists`
// filter slugs (kebab-case, per the BatchData v1 Property Search API).
const QUICKLIST_SLUG: Record<string, string> = {
  probate:         'inherited',
  divorce:         'divorce',
  foreclosure:     'foreclosure',
  pre_foreclosure: 'preforeclosure',
  tax_lien:        'tax-default',
  high_equity:     'high-equity',
  absentee:        'absentee-owner',
  expired:         'expired-listing',
  vacant:          'vacant',
  tired_landlord:  'tired-landlord',
  distressed:      'foreclosure',
}

/** Pure: a BatchData Property Search `results.properties[]` row → BatchDataRecord. */
export function normalizeBatchDataProperty(p: Record<string, any>, requestedType: string): BatchDataRecord {
  const addr = p.address ?? {}
  const owner = p.owner ?? {}
  const building = p.building ?? {}
  const valuation = p.valuation ?? {}
  const fullName = typeof owner.fullName === 'string' ? owner.fullName.trim() : ''
  const ownerFirst = owner.firstName ?? (fullName ? fullName.split(/\s+/)[0] : '')
  const ownerLast = owner.lastName ?? (fullName ? fullName.split(/\s+/).slice(1).join(' ') : '')
  return {
    firstName: ownerFirst || '',
    lastName: ownerLast || '',
    phone: owner.phone ?? null,
    email: owner.email ?? null,
    address: owner.mailingAddress?.street ?? addr.street ?? '',
    city: owner.mailingAddress?.city ?? addr.city ?? '',
    state: owner.mailingAddress?.state ?? addr.state ?? '',
    zip: owner.mailingAddress?.zip ?? addr.zip ?? '',
    propertyAddress: addr.street ?? undefined,
    propertyCity: addr.city ?? undefined,
    propertyState: addr.state ?? undefined,
    propertyZip: addr.zip ?? undefined,
    beds: building.bedroomCount ?? building.beds ?? undefined,
    baths: building.bathroomCount ?? building.baths ?? undefined,
    sqft: building.livingAreaSquareFeet ?? building.sqft ?? undefined,
    estimatedValue: valuation.estimatedValue ?? p.estimatedValue ?? undefined,
    motivationType: (requestedType as BatchDataRecord['motivationType']) ?? 'distressed',
    motivationConfidence: 0.7,
  }
}

export async function fetchMotivatedSellers(params: {
  state: string
  city?: string
  motivationTypes?: string[]
  limit?: number
}): Promise<{
  records: BatchDataRecord[]
  cost: number
  recordsFound: number
}> {
  const types = params.motivationTypes && params.motivationTypes.length > 0
    ? params.motivationTypes
    : [...BATCHDATA_MOTIVATION_TYPES]
  const quickLists = [...new Set(types.map((t) => QUICKLIST_SLUG[t]).filter(Boolean))]
  const query = [params.city, params.state].filter(Boolean).join(', ') || params.state

  // BatchData v1 Property Search — POST /api/v1/property/search.
  // Motivated-seller triggers are expressed as `searchCriteria.quickLists`.
  const response = await fetch(`${BATCHDATA_API_URL}/property/search`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${BATCHDATA_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      searchCriteria: { query, quickLists },
      options: { take: params.limit ?? 100, skip: 0 },
    }),
  })

  if (!response.ok) {
    throw new Error(`BatchData API error: ${response.status} ${response.statusText}`)
  }

  const data = await response.json()
  const properties: any[] = data?.results?.properties ?? data?.results ?? []
  const records = properties.map((p) => normalizeBatchDataProperty(p, types[0] ?? 'distressed'))

  return {
    records,
    recordsFound: data?.results?.meta?.totalResults ?? properties.length,
    cost: records.length * 0.05,
  }
}

export async function searchProperties(address: string): Promise<{
  matches: any[]
  cost: number
}> {
  // BatchData v1 Property Search by free-text address (POST /api/v1/property/search).
  const response = await fetch(`${BATCHDATA_API_URL}/property/search`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${BATCHDATA_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ searchCriteria: { query: address }, options: { take: 5, skip: 0 } }),
  })

  if (!response.ok) {
    throw new Error(`BatchData property search error: ${response.status} ${response.statusText}`)
  }

  const data = await response.json()

  return {
    matches: data?.results?.properties ?? data?.results ?? [],
    cost: 0.02,
  }
}

export async function enrichPropertyWithBatchData(address: string): Promise<{
  condition: 'turnkey' | 'fixer' | 'unknown'
  estimatedValue: number
  daysOnMarket?: number
  cost: number
}> {
  // No dedicated "enrichment" endpoint on BatchData — a single-address Property
  // Search returns the property valuation + attributes we derive condition from.
  const response = await fetch(`${BATCHDATA_API_URL}/property/search`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${BATCHDATA_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ searchCriteria: { query: address }, options: { take: 1, skip: 0 } }),
  })

  if (!response.ok) {
    throw new Error(`BatchData enrichment error: ${response.status} ${response.statusText}`)
  }

  const data = await response.json()
  const prop = (data?.results?.properties ?? data?.results ?? [])[0] ?? {}
  const ql = prop.quickLists ?? {}
  // Distress/vacancy signals imply a likely fixer; otherwise unknown.
  const condition: 'turnkey' | 'fixer' | 'unknown' =
    ql.vacant || ql.foreclosure || ql.preforeclosure || ql['tax-default'] ? 'fixer' : 'unknown'

  return {
    condition,
    estimatedValue: prop.valuation?.estimatedValue ?? prop.estimatedValue ?? 0,
    daysOnMarket: prop.listing?.daysOnMarket,
    cost: 0.03,
  }
}

// ─── Comparable Sales (for CMA) ──────────────────────────────────────────────
export interface BatchDataComp {
  address: string
  city: string
  state: string
  zip: string
  bedrooms: number
  bathrooms: number
  square_feet: number
  sale_price: number
  list_price: number
  sale_date: string
  days_on_market: number
  price_per_sqft: number
  distance_miles: number
  year_built: number | null
}

export async function fetchComparableSales(params: {
  address: string
  city: string
  state: string
  zip?: string
  bedrooms: number
  bathrooms: number
  squareFeet: number
  radiusMiles?: number
  maxAgeDays?: number
  limit?: number
}): Promise<BatchDataComp[]> {
  if (!process.env.BATCHDATA_API_KEY) return []

  try {
    const response = await fetch(`${BATCHDATA_API_URL}/comparable-sales`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${BATCHDATA_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        address: params.address,
        city: params.city,
        state: params.state,
        zip: params.zip,
        bedrooms: params.bedrooms,
        bathrooms: params.bathrooms,
        square_feet: params.squareFeet,
        radius_miles: params.radiusMiles ?? 1,
        max_age_days: params.maxAgeDays ?? 180,
        limit: params.limit ?? 10,
      }),
    })

    if (!response.ok) {
      console.error(`[BatchData] Comparable sales error: ${response.status} ${response.statusText}`)
      return []
    }

    const data = await response.json()
    return (data.comparables ?? data.results ?? []).map((c: any) => ({
      address: c.address ?? '',
      city: c.city ?? params.city,
      state: c.state ?? params.state,
      zip: c.zip ?? params.zip ?? '',
      bedrooms: c.bedrooms ?? 0,
      bathrooms: c.bathrooms ?? 0,
      square_feet: c.square_feet ?? c.sqft ?? 0,
      sale_price: c.sale_price ?? c.sold_price ?? 0,
      list_price: c.list_price ?? c.sale_price ?? 0,
      sale_date: c.sale_date ?? c.sold_date ?? '',
      days_on_market: c.days_on_market ?? c.dom ?? 0,
      price_per_sqft: c.price_per_sqft ?? (c.sale_price && c.square_feet ? Math.round(c.sale_price / c.square_feet) : 0),
      distance_miles: c.distance_miles ?? c.distance ?? 0,
      year_built: c.year_built ?? null,
    }))
  } catch (error) {
    console.error('[BatchData] Comparable sales fetch error:', error)
    return []
  }
}

// ─── Market Stats (for Market Insight Generator) ─────────────────────────────
export interface BatchDataMarketStats {
  median_sale_price: number
  avg_days_on_market: number
  active_listings: number
  sold_last_30d: number
  list_to_sale_ratio: number
  months_supply: number
}

export async function fetchBatchDataMarketStats(
  city: string,
  state: string,
  zipCode?: string
): Promise<BatchDataMarketStats | null> {
  if (!process.env.BATCHDATA_API_KEY) return null

  try {
    const body = zipCode ? { zip: zipCode } : { city, state }
    const response = await fetch(`${BATCHDATA_API_URL}/market-stats`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${BATCHDATA_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      console.error(`[BatchData] Market stats error: ${response.status}`)
      return null
    }

    const data = await response.json()

    return {
      median_sale_price: data.median_sale_price ?? 0,
      avg_days_on_market: data.avg_days_on_market ?? 0,
      active_listings: data.active_listings ?? 0,
      sold_last_30d: data.sold_last_30d ?? 0,
      list_to_sale_ratio: data.list_to_sale_ratio ?? 0,
      months_supply: data.months_supply ?? 0,
    }
  } catch (error) {
    console.error('[BatchData] Market stats fetch error:', error)
    return null
  }
}
