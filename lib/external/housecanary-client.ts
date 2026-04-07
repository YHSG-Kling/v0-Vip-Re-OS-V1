/**
 * HouseCanary API Client
 * Tier 1 provider for market data - highest accuracy
 * Requires HOUSECANARY_API_KEY and HOUSECANARY_API_SECRET
 */

const HC_BASE = 'https://api.housecanary.com/v2'

function getHCAuth(): string {
  const key = process.env.HOUSECANARY_API_KEY
  const secret = process.env.HOUSECANARY_API_SECRET
  if (!key || !secret) return ''
  return 'Basic ' + Buffer.from(`${key}:${secret}`).toString('base64')
}

export interface HouseCanaryMarketStats {
  median_sale_price: number
  median_list_price: number
  avg_days_on_market: number
  months_of_inventory: number
  total_active_listings: number
  total_sold_30d: number
  list_to_sale_ratio: number
  price_trend_yoy_pct: number
  market_grade: string // e.g. "B+" — HouseCanary proprietary
}

export async function fetchHouseCanaryMarketStats(
  zipCode: string
): Promise<HouseCanaryMarketStats | null> {
  const auth = getHCAuth()
  if (!auth) return null

  try {
    const url = `${HC_BASE}/property/block/market_sale_stats?zipcode=${zipCode}&period=months_3`
    const res = await fetch(url, {
      headers: { Authorization: auth },
      next: { revalidate: 3600 }, // Cache for 1 hour
    })

    if (!res.ok) {
      console.error(`[HouseCanary] API error: ${res.status} ${res.statusText}`)
      return null
    }

    const json = await res.json()
    const d = json.result?.block?.market_sale_stats

    if (!d) {
      console.error('[HouseCanary] No market_sale_stats in response')
      return null
    }

    return {
      median_sale_price: d.median_sale_price ?? 0,
      median_list_price: d.median_list_price ?? 0,
      avg_days_on_market: d.avg_days_on_market ?? 0,
      months_of_inventory: d.months_of_inventory ?? 0,
      total_active_listings: d.total_active_listings ?? 0,
      total_sold_30d: d.num_sales_3mo ? Math.round(d.num_sales_3mo / 3) : 0,
      list_to_sale_ratio: d.median_sale_to_list ?? 0,
      price_trend_yoy_pct: d.median_sale_price_yoy ?? 0,
      market_grade: d.market_grade ?? 'N/A',
    }
  } catch (error) {
    console.error('[HouseCanary] Fetch error:', error)
    return null
  }
}

// ─── Comparable Sales (for CMA fallback) ─────────────────────────────────────
export interface HouseCanaryComp {
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

export async function fetchHouseCanaryComps(params: {
  address: string
  zipCode: string
  bedrooms: number
  squareFeet: number
  maxAgeDays?: number
  limit?: number
}): Promise<HouseCanaryComp[]> {
  const auth = getHCAuth()
  if (!auth) return []

  try {
    const url = `${HC_BASE}/property/sales_history?address=${encodeURIComponent(params.address)}&zipcode=${params.zipCode}&num_sales=${params.limit ?? 10}`
    const res = await fetch(url, {
      headers: { Authorization: auth },
      next: { revalidate: 3600 },
    })

    if (!res.ok) {
      console.error(`[HouseCanary] Comps error: ${res.status} ${res.statusText}`)
      return []
    }

    const json = await res.json()
    const sales: any[] = json.result?.property?.sales_history ?? []

    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - (params.maxAgeDays ?? 180))

    return sales
      .filter((s: any) => s.event_date && new Date(s.event_date) >= cutoff)
      .map((s: any) => ({
        address: s.address ?? params.address,
        city: s.city ?? '',
        state: s.state ?? '',
        zip: s.zipcode ?? params.zipCode,
        bedrooms: s.num_beds ?? params.bedrooms,
        bathrooms: s.num_baths ?? 0,
        square_feet: s.building_area_sq_ft ?? params.squareFeet,
        sale_price: s.price ?? 0,
        list_price: s.price ?? 0,
        sale_date: s.event_date ?? '',
        days_on_market: 0,
        price_per_sqft: s.price && s.building_area_sq_ft ? Math.round(s.price / s.building_area_sq_ft) : 0,
        distance_miles: 0,
        year_built: s.year_built ?? null,
      }))
  } catch (error) {
    console.error('[HouseCanary] Comps fetch error:', error)
    return []
  }
}

export interface HouseCanaryForecast {
  forecast_6mo_pct: number
}

export async function fetchHouseCanaryForecast(
  zipCode: string
): Promise<HouseCanaryForecast | null> {
  const auth = getHCAuth()
  if (!auth) return null

  try {
    const url = `${HC_BASE}/property/value_forecast?zipcode=${zipCode}`
    const res = await fetch(url, {
      headers: { Authorization: auth },
      next: { revalidate: 3600 },
    })

    if (!res.ok) return null

    const json = await res.json()
    return {
      forecast_6mo_pct: json.result?.value_forecast?.forecast_6mo_pct ?? 0,
    }
  } catch (error) {
    console.error('[HouseCanary] Forecast error:', error)
    return null
  }
}
