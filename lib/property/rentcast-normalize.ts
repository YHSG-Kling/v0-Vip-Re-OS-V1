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

/** Normalized comparable sale — matches the shape the CMA pipeline consumes. */
export interface RentcastComp {
  address: string
  list_price: number
  /**
   * RentCast's comparable `price`.
   *
   * PROVENANCE, stated once here so no downstream reader has to guess: this is
   * the price on the comparable's LISTING RECORD, not a figure read off a
   * recorded deed. For a comparable that has left the market (`removed_date`
   * set) it is the price the home was last listed at before it went off-market
   * — RentCast's own basis for treating it as a sale comparable. For one still
   * on the market it is the live asking price. `list_price` carries the same
   * number; the two are not independent observations.
   */
  sale_price: number
  days_on_market: number
  square_feet: number
  price_per_sqft: number
  bedrooms: number
  bathrooms: number
  year_built: number | null
  distance_miles: number
  /** ISO date (YYYY-MM-DD) the comparable was listed, when RentCast reports it. */
  listed_date: string | null
  /**
   * ISO date the comparable was REMOVED from the market. Its presence is what
   * separates a sold/off-market comparable from one that is still for sale —
   * the CMA's 6-month/12-month sold window is measured against this date, so a
   * comparable that carries no date at all cannot be claimed to have sold
   * inside any window and is excluded rather than assumed.
   */
  removed_date: string | null
  /** ISO date RentCast last observed the comparable on the market. */
  last_seen_date: string | null
  /** RentCast's own 0..1 similarity metric for this comparable vs the subject. */
  correlation: number | null
  /** RentCast's property-type label (e.g. "Single Family"), when present. */
  property_type: string | null
  /** Lot size in ACRES, converted from RentCast's square feet. Null when absent. */
  lot_size_acres: number | null
}

const SQFT_PER_ACRE = 43560

/** Pure: a wire value that may be an ISO timestamp → "YYYY-MM-DD", else null. */
function isoDay(v: any): string | null {
  if (typeof v !== "string" || v.length < 10) return null
  const day = v.slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null
}

/** Pure: RentCast /avm/value `comparables[]` → normalized comps (drops entries with no price). */
export function normalizeRentcastComps(comparables: any[] | null | undefined): RentcastComp[] {
  if (!Array.isArray(comparables)) return []
  const out: RentcastComp[] = []
  for (const c of comparables) {
    const price = Number(c?.price ?? 0)
    if (!price || price <= 0) continue
    const sqft = Number(c?.squareFootage ?? 0)
    const lotSqft = Number(c?.lotSize ?? 0)
    const correlation = Number(c?.correlation ?? NaN)
    out.push({
      address: String(c?.formattedAddress ?? c?.address ?? "Unknown"),
      list_price: price,
      sale_price: price,
      days_on_market: Math.round(Number(c?.daysOnMarket ?? 0)),
      square_feet: Math.round(sqft),
      price_per_sqft: sqft > 0 ? Math.round(price / sqft) : 0,
      bedrooms: Math.round(Number(c?.bedrooms ?? 0)),
      bathrooms: Number(c?.bathrooms ?? 0),
      year_built: c?.yearBuilt != null ? Math.round(Number(c.yearBuilt)) : null,
      distance_miles: Math.round(Number(c?.distance ?? 0) * 100) / 100,
      listed_date: isoDay(c?.listedDate),
      removed_date: isoDay(c?.removedDate),
      last_seen_date: isoDay(c?.lastSeenDate),
      correlation: Number.isFinite(correlation) && correlation > 0 ? correlation : null,
      property_type: c?.propertyType != null && c.propertyType !== "" ? String(c.propertyType) : null,
      lot_size_acres:
        Number.isFinite(lotSqft) && lotSqft > 0
          ? Math.round((lotSqft / SQFT_PER_ACRE) * 100) / 100
          : null,
    })
  }
  return out
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
