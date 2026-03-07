/**
 * lib/alerts/alert-matcher.ts
 * Spec: scorePropertyAgainstAlert(property, alert) → 0-100
 * Hard filters must all pass or score = 0.
 * Soft scoring adds to base of 60.
 * Minimum qualifying score: 40.
 */

export interface IDXProperty {
  mlsId:        string
  address:      string
  city:         string
  state?:       string
  zipCode:      string
  listPrice:    number
  bedrooms:     number
  bathrooms:    number
  sqft?:        number
  type:         string           // e.g. "Single Family", "Condo"
  features?:    string[]
  yearBuilt?:   number
  daysOnMarket: number
  listingUrl?:  string
  photoUrl?:    string
  isPriceReduction?: boolean
}

export interface PropertyAlert {
  id:                   string
  min_price?:           number | null
  max_price?:           number | null
  bedrooms_min?:        number | null
  bathrooms_min?:       number | null
  property_types?:      string[] | null
  cities?:              string[] | null
  zip_codes?:           string[] | null
  min_sqft?:            number | null
  max_sqft?:            number | null
  year_built_min?:      number | null
  must_have_features?:  string[] | null
  new_listings_only?:   boolean
}

/**
 * scorePropertyAgainstAlert
 * Returns 0 if any hard filter fails.
 * Returns 40–100 for qualifying matches.
 */
export function scorePropertyAgainstAlert(
  property: IDXProperty,
  alert: PropertyAlert,
  isPriceReduction = false
): number {
  // ── Hard filters ──────────────────────────────────────────────────────────
  if (alert.min_price != null && property.listPrice < alert.min_price)  return 0
  if (alert.max_price != null && property.listPrice > alert.max_price)  return 0
  if (alert.bedrooms_min  != null && property.bedrooms  < alert.bedrooms_min)  return 0
  if (alert.bathrooms_min != null && property.bathrooms < alert.bathrooms_min) return 0

  if (alert.property_types?.length) {
    const match = alert.property_types.some(t => t.toLowerCase() === property.type.toLowerCase())
    if (!match) return 0
  }

  if (alert.cities?.length) {
    const match = alert.cities.some(c => c.toLowerCase() === property.city.toLowerCase())
    if (!match) return 0
  }

  if (alert.zip_codes?.length) {
    if (!alert.zip_codes.includes(property.zipCode)) return 0
  }

  if (alert.min_sqft != null && property.sqft != null && property.sqft < alert.min_sqft) return 0
  if (alert.max_sqft != null && property.sqft != null && property.sqft > alert.max_sqft) return 0

  // ── Base score ───────────────────────────────────────────────────────────
  let score = 60

  // +10: year built >= alert.year_built_min
  if (alert.year_built_min != null && property.yearBuilt != null) {
    if (property.yearBuilt >= alert.year_built_min) score += 10
  }

  // +5 per must_have_feature found, max +20
  if (alert.must_have_features?.length && property.features?.length) {
    let featureScore = 0
    for (const f of alert.must_have_features) {
      if (property.features.some(pf => pf.toLowerCase().includes(f.toLowerCase()))) {
        featureScore += 5
        if (featureScore >= 20) break
      }
    }
    score += featureScore
  }

  // +10: new listing (DOM <= 3) and alert.new_listings_only = true
  if (alert.new_listings_only && property.daysOnMarket <= 3) {
    score += 10
  }

  // +5: price reduction detected
  if (isPriceReduction) score += 5

  // Cap at 100, enforce minimum 40
  const capped = Math.min(100, score)
  return capped >= 40 ? capped : 0
}
