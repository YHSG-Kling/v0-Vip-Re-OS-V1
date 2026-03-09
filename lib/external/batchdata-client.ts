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
}

const BATCHDATA_API_KEY = process.env.BATCHDATA_API_KEY!
const BATCHDATA_API_URL = 'https://api.batchdata.com/api/v1'

export interface BatchDataRecord {
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
  motivationType: 'probate' | 'divorce' | 'foreclosure' | 'tax_lien' | 'pre_foreclosure' | 'distressed'
  motivationConfidence: number
}

export async function fetchMotivatedSellers(params: {
  state: string
  motivationTypes?: string[]
  limit?: number
}): Promise<{
  records: BatchDataRecord[]
  cost: number
  recordsFound: number
}> {
  const response = await fetch(`${BATCHDATA_API_URL}/motivated-sellers`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${BATCHDATA_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      state: params.state,
      motivation_types: params.motivationTypes || ['probate', 'divorce', 'foreclosure', 'tax_lien'],
      limit: params.limit || 100,
    }),
  })

  if (!response.ok) {
    throw new Error(`BatchData API error: ${response.status} ${response.statusText}`)
  }

  const data = await response.json()

  return {
    records: data.records || [],
    recordsFound: data.total || 0,
    cost: (data.records?.length || 0) * 0.05,
  }
}

export async function searchProperties(address: string): Promise<{
  matches: any[]
  cost: number
}> {
  const response = await fetch(`${BATCHDATA_API_URL}/property-search`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${BATCHDATA_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ address }),
  })

  if (!response.ok) {
    throw new Error(`BatchData property search error: ${response.status} ${response.statusText}`)
  }

  const data = await response.json()

  return {
    matches: data.matches || [],
    cost: 0.02,
  }
}

export async function enrichPropertyWithBatchData(address: string): Promise<{
  condition: 'turnkey' | 'fixer' | 'unknown'
  estimatedValue: number
  daysOnMarket?: number
  cost: number
}> {
  const response = await fetch(`${BATCHDATA_API_URL}/property-enrichment`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${BATCHDATA_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ address }),
  })

  if (!response.ok) {
    throw new Error(`BatchData enrichment error: ${response.status} ${response.statusText}`)
  }

  const data = await response.json()

  return {
    condition: data.condition || 'unknown',
    estimatedValue: data.estimated_value || 0,
    daysOnMarket: data.days_on_market,
    cost: 0.03,
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
