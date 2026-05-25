// lib/property/rentcast-normalize.ts
// Pure RentCast response normalizers — no network, no server-only imports, so they
// are unit-testable directly (and importable from the tsx simulator).

export interface RentcastMarketStats {
  median_sale_price: number
  avg_days_on_market: number
  active_listings: number
  new_listings_30d: number
  /** YoY median price change %, derived from RentCast saleData.history when present. */
  price_trend_yoy_pct: number
}

/** Pure: a RentCast /markets saleData object → normalized market stats (or null). */
export function normalizeRentcastMarketStats(saleData: Record<string, any> | null | undefined): RentcastMarketStats | null {
  if (!saleData || typeof saleData !== "object") return null
  const median = Number(saleData.medianPrice ?? saleData.averagePrice ?? 0)
  if (!median || median <= 0) return null

  // YoY: compare the newest history snapshot against the one ~12 months prior.
  let yoy = 0
  const history = saleData.history && typeof saleData.history === "object" ? saleData.history : null
  if (history) {
    const months = Object.keys(history).sort() // "YYYY-MM" keys, ascending
    if (months.length >= 13) {
      const latest = Number(history[months[months.length - 1]]?.medianPrice ?? 0)
      const yearAgo = Number(history[months[months.length - 13]]?.medianPrice ?? 0)
      if (latest > 0 && yearAgo > 0) yoy = ((latest - yearAgo) / yearAgo) * 100
    }
  }

  return {
    median_sale_price: Math.round(median),
    avg_days_on_market: Math.round(Number(saleData.averageDaysOnMarket ?? saleData.medianDaysOnMarket ?? 0)),
    active_listings: Math.round(Number(saleData.totalListings ?? 0)),
    new_listings_30d: Math.round(Number(saleData.newListings ?? 0)),
    price_trend_yoy_pct: Math.round(yoy * 10) / 10,
  }
}
