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

export interface FetchMotivatedSellersOptions {
  state: string
  city?: string
  zip?: string
  /** Internal motivation types → BatchData quickList slugs (the named lead descriptors). */
  motivationTypes?: string[]
  /** Advanced "third search type": BatchData-native searchCriteria fields merged verbatim
   *  (structured/geo filters) — an escape hatch so a verified field works without a code change. */
  searchCriteria?: Record<string, unknown>
  limit?: number
  skip?: number
}

/**
 * PURE: build the BatchData Property Search request body. BatchData's searchCriteria is driven by
 * `quickLists` (the named business-rule queries that DESCRIBE the leads — high-equity, absentee,
 * preforeclosure, …) scoped by a `query` string (the geography). The motivated-seller intent maps
 * to the best quickList(s) via QUICKLIST_SLUG — so the caller picks intent, not a pile of filters.
 * Any extra BatchData-native structured criteria can be supplied verbatim via `searchCriteria`.
 * Unit-tested in the simulator.
 */
export function buildPropertySearchBody(opts: FetchMotivatedSellersOptions): { searchCriteria: Record<string, unknown>; options: { take: number; skip: number } } {
  const types = opts.motivationTypes && opts.motivationTypes.length > 0
    ? opts.motivationTypes
    : [...BATCHDATA_MOTIVATION_TYPES]
  const quickLists = [...new Set(types.map((t) => QUICKLIST_SLUG[t]).filter(Boolean))]
  const query = [opts.city, opts.zip, opts.state].filter(Boolean).join(", ") || opts.state

  // query (geography) + quickLists (the lead descriptors); verbatim passthrough wins last.
  const searchCriteria: Record<string, unknown> = { query, quickLists, ...(opts.searchCriteria ?? {}) }

  return { searchCriteria, options: { take: opts.limit ?? 100, skip: opts.skip ?? 0 } }
}

// Single egress: all BatchData Property Search calls route through the connector-gateway
// (one way in/out). Throws on error to preserve the callers' contract.
async function batchDataPropertySearch(body: unknown, errorLabel: string): Promise<any> {
  const { callConnector } = await import("@/lib/agentic-os/connector-gateway")
  const res = await callConnector<any>({
    connector: "batchdata",
    baseUrl: BATCHDATA_API_URL,
    path: "property/search",
    method: "POST",
    auth: { style: "bearer", token: BATCHDATA_API_KEY },
    body,
  })
  if (!res.ok) throw new Error(`${errorLabel}: ${res.status ?? "network"} ${res.error ?? ""}`.trim())
  return res.data
}

export async function fetchMotivatedSellers(params: FetchMotivatedSellersOptions): Promise<{
  records: BatchDataRecord[]
  cost: number
  recordsFound: number
}> {
  const types = params.motivationTypes && params.motivationTypes.length > 0
    ? params.motivationTypes
    : [...BATCHDATA_MOTIVATION_TYPES]

  // BatchData v1 Property Search — POST /api/v1/property/search. Motivated-seller triggers are
  // expressed as `searchCriteria.quickLists`; structured filters (beds/value/equity/…) expand
  // searchCriteria via the pure builder.
  const data = await batchDataPropertySearch(
    buildPropertySearchBody(params),
    "BatchData API error",
  )
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
  const data = await batchDataPropertySearch(
    { searchCriteria: { query: address }, options: { take: 5, skip: 0 } },
    "BatchData property search error",
  )

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
  const data = await batchDataPropertySearch(
    { searchCriteria: { query: address }, options: { take: 1, skip: 0 } },
    "BatchData enrichment error",
  )
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
