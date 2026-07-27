// Property alert scoring engine — exact spec weights
// Price+location must match for minimum qualifying score of 40

import { canonicalPropertyType } from "@/lib/constants"

export interface AlertProperty {
  mls_number: string
  property_address: string
  city?: string
  state?: string
  zip?: string
  list_price?: number
  bedrooms?: number
  bathrooms?: number
  sqft?: number
  property_type?: string
  days_on_market?: number
  listing_url?: string
  primary_photo_url?: string
  is_price_reduction?: boolean
  previous_price?: number
  description?: string
  listed_at?: string
}

export interface AlertCriteria {
  min_price?: number | null
  max_price?: number | null
  bedrooms_min?: number | null
  bathrooms_min?: number | null
  property_types?: string[]
  cities?: string[]
  zip_codes?: string[]
  min_sqft?: number | null
  max_sqft?: number | null
  year_built_min?: number | null
  must_have_features?: string[]
  keywords?: string | null
  max_days_on_market?: number | null
  new_listings_only?: boolean
  include_coming_soon?: boolean
  include_price_reductions?: boolean
  price_reduction_min_percent?: number | null
}

export interface MatchResult {
  score: number
  reasons: string[]
  qualifies: boolean
  priceMatched: boolean
  locationMatched: boolean
}

export function scorePropertyForAlert(
  property: AlertProperty,
  criteria: AlertCriteria
): MatchResult {
  let score = 0
  const reasons: string[] = []
  let priceMatched = false
  let locationMatched = false

  // ── Price match: 30pts exact, 15pts within 5% ─────────────────────────────
  if (property.list_price != null && (criteria.min_price != null || criteria.max_price != null)) {
    const inRange =
      (criteria.min_price == null || property.list_price >= criteria.min_price) &&
      (criteria.max_price == null || property.list_price <= criteria.max_price)
    if (inRange) {
      score += 30
      priceMatched = true
      reasons.push(`Price ${formatPrice(property.list_price)} fits budget`)
    } else {
      // within 5% of range boundary
      const buffer = (criteria.max_price ?? criteria.min_price!) * 0.05
      const nearRange =
        (criteria.max_price != null && property.list_price <= criteria.max_price + buffer) ||
        (criteria.min_price != null && property.list_price >= criteria.min_price - buffer)
      if (nearRange) {
        score += 15
        priceMatched = true
        reasons.push(`Price ${formatPrice(property.list_price)} close to budget`)
      }
    }
  } else if (!criteria.min_price && !criteria.max_price) {
    // no price filter — treat as matched
    priceMatched = true
  }

  // ── Beds: 10pts ───────────────────────────────────────────────────────────
  if (criteria.bedrooms_min != null && property.bedrooms != null) {
    if (property.bedrooms >= criteria.bedrooms_min) {
      score += 10
      reasons.push(`${property.bedrooms} beds meets minimum`)
    }
  } else if (!criteria.bedrooms_min) {
    score += 0 // not penalized
  }

  // ── Baths: 10pts ──────────────────────────────────────────────────────────
  if (criteria.bathrooms_min != null && property.bathrooms != null) {
    if (Number(property.bathrooms) >= Number(criteria.bathrooms_min)) {
      score += 10
      reasons.push(`${property.bathrooms} baths meets minimum`)
    }
  }

  // ── City match: 15pts / ZIP match: 10pts ──────────────────────────────────
  const hasCityFilter = criteria.cities && criteria.cities.length > 0
  const hasZipFilter  = criteria.zip_codes && criteria.zip_codes.length > 0

  if (hasCityFilter && property.city) {
    const cityMatch = criteria.cities!.some(
      c => c.toLowerCase() === property.city!.toLowerCase()
    )
    if (cityMatch) {
      score += 15
      locationMatched = true
      reasons.push(`Located in ${property.city}`)
    }
  }

  if (hasZipFilter && property.zip) {
    const zipMatch = criteria.zip_codes!.includes(property.zip)
    if (zipMatch) {
      score += 10
      locationMatched = true
      reasons.push(`ZIP ${property.zip} matches search area`)
    }
  }

  if (!hasCityFilter && !hasZipFilter) {
    locationMatched = true // no location filter — treat as matched
  }

  // ── Property type: 10pts ──────────────────────────────────────────────────
  if (criteria.property_types && criteria.property_types.length > 0 && property.property_type) {
    // Compare CANONICAL values on both sides. The previous `.toLowerCase()` on each side
    // looked defensive but only normalised case — saved criteria hold display strings
    // ("Single Family", "Multi-Family") while listings hold canonical values
    // ("single_family"), so the separator still differed. Condo/Townhouse/Land/Commercial
    // matched because they are single words; Single Family and Multi-Family — the two most
    // common residential types — silently scored zero on every listing. Normalising both
    // sides also keeps ALREADY-SAVED rows working without a data migration.
    const wanted = criteria.property_types.map(canonicalPropertyType).filter(Boolean)
    const actual = canonicalPropertyType(property.property_type)
    const typeMatch = actual !== null && wanted.includes(actual)
    if (typeMatch) {
      score += 10
      reasons.push(`${property.property_type} matches type preference`)
    }
  }

  // ── New listing bonus: 5pts ───────────────────────────────────────────────
  if (!property.is_price_reduction && (!property.days_on_market || property.days_on_market <= 3)) {
    score += 5
    reasons.push("New listing")
  }

  // ── Keywords in description: 10pts ────────────────────────────────────────
  if (criteria.keywords && property.description) {
    const kw = criteria.keywords.toLowerCase()
    if (property.description.toLowerCase().includes(kw)) {
      score += 10
      reasons.push(`Matches keyword "${criteria.keywords}"`)
    }
  }

  // ── DOM filter ────────────────────────────────────────────────────────────
  if (
    criteria.max_days_on_market != null &&
    property.days_on_market != null &&
    property.days_on_market > criteria.max_days_on_market
  ) {
    // Disqualify entirely
    return { score: 0, reasons: [], qualifies: false, priceMatched, locationMatched }
  }

  // Price reduction gate
  if (property.is_price_reduction && criteria.include_price_reductions === false) {
    return { score: 0, reasons: [], qualifies: false, priceMatched, locationMatched }
  }

  if (property.is_price_reduction && property.previous_price && property.list_price) {
    const pct = ((property.previous_price - property.list_price) / property.previous_price) * 100
    const minPct = criteria.price_reduction_min_percent ?? 2
    if (pct < minPct) {
      return { score: 0, reasons: [], qualifies: false, priceMatched, locationMatched }
    }
    reasons.push(`Price reduced ${pct.toFixed(1)}%`)
  }

  // Minimum qualifying: price AND location must match (score >= 40)
  const qualifies = score >= 40 && priceMatched && locationMatched

  return { score, reasons, qualifies, priceMatched, locationMatched }
}

function formatPrice(price: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(price)
}
