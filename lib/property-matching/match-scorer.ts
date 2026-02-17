/**
 * SYSTEM 5.1A - PROPERTY → BUYER MATCH SCORER
 * Runtime-only scoring engine for listing-to-buyer matching
 * 
 * CONSTRAINTS:
 * - NO schema modifications
 * - Scores are ephemeral (never persisted to listings or contacts)
 * - Internal use only (agent/broker/team leader facing)
 */

export interface MatchScore {
  contact_id: string
  match_confidence: 'low' | 'medium' | 'high'
  score: number // 1-100, runtime only
  match_factors: string[]
  caution_notes: string[]
}

export interface BuyerProfile {
  contact_id: string
  first_name: string
  last_name: string
  notes: string | null
  created_at: string
  // Inferred from conversation insights
  inferred_intent?: string | null
  urgency_level?: string | null
  sentiment?: string | null
  health_score?: number | null
  updated_at?: string | null
}

export interface ListingProfile {
  id: string
  price: number | null
  bedrooms: number | null
  bathrooms: number | null
  square_feet: number | null
  property_type: string | null
  city: string | null
  state: string | null
  zip: string | null
  features: string[] | null
  status: string
  created_at: string
}

/**
 * Score a buyer against a specific listing
 * Returns ephemeral match score (1-100)
 */
export function scoreBuyerForListing(
  buyer: BuyerProfile,
  listing: ListingProfile
): MatchScore {
  let score = 0
  const matchFactors: string[] = []
  const cautionNotes: string[] = []

  // Extract buyer preferences from notes (if structured JSON exists)
  const buyerPrefs = extractBuyerPreferences(buyer.notes)

  // 1. PRICE ALIGNMENT (25 points max)
  if (listing.price && buyerPrefs.maxPrice) {
    if (listing.price <= buyerPrefs.maxPrice) {
      score += 25
      matchFactors.push(`Price within budget ($${listing.price.toLocaleString()})`)
    } else {
      cautionNotes.push(`Over budget by $${(listing.price - buyerPrefs.maxPrice).toLocaleString()}`)
    }
  } else if (listing.price && buyerPrefs.minPrice) {
    if (listing.price >= buyerPrefs.minPrice) {
      score += 15
      matchFactors.push('Price meets minimum')
    }
  }

  // 2. BEDROOM MATCH (15 points max)
  if (listing.bedrooms && buyerPrefs.minBeds) {
    if (listing.bedrooms >= buyerPrefs.minBeds) {
      score += 15
      matchFactors.push(`${listing.bedrooms} beds meets requirement`)
    } else {
      cautionNotes.push(`Only ${listing.bedrooms} beds (needs ${buyerPrefs.minBeds}+)`)
    }
  }

  // 3. BATHROOM MATCH (10 points max)
  if (listing.bathrooms && buyerPrefs.minBaths) {
    if (listing.bathrooms >= buyerPrefs.minBaths) {
      score += 10
      matchFactors.push(`${listing.bathrooms} baths meets requirement`)
    }
  }

  // 4. LOCATION ALIGNMENT (20 points max)
  if (listing.city && buyerPrefs.preferredCities?.includes(listing.city)) {
    score += 20
    matchFactors.push(`Preferred city: ${listing.city}`)
  } else if (listing.state && buyerPrefs.preferredStates?.includes(listing.state)) {
    score += 10
    matchFactors.push(`Preferred state: ${listing.state}`)
  }

  // 5. PROPERTY TYPE MATCH (10 points max)
  if (listing.property_type && buyerPrefs.propertyTypes?.includes(listing.property_type)) {
    score += 10
    matchFactors.push(`Property type: ${listing.property_type}`)
  }

  // 6. URGENCY SCORE (10 points max)
  if (buyer.urgency_level === 'high') {
    score += 10
    matchFactors.push('High urgency buyer - prioritize')
  } else if (buyer.urgency_level === 'medium') {
    score += 5
    matchFactors.push('Medium urgency')
  }

  // 7. ENGAGEMENT HEALTH (10 points max)
  if (buyer.health_score && buyer.health_score >= 70) {
    score += 10
    matchFactors.push('Strong engagement history')
  } else if (buyer.health_score && buyer.health_score < 40) {
    cautionNotes.push('Low engagement score - may need follow-up')
  }

  // CONFIDENCE LEVEL
  const confidence = score >= 70 ? 'high' : score >= 45 ? 'medium' : 'low'

  return {
    contact_id: buyer.contact_id,
    match_confidence: confidence,
    score: Math.min(100, Math.round(score)),
    match_factors: matchFactors,
    caution_notes: cautionNotes,
  }
}

/**
 * Extract buyer preferences from contacts.notes
 * Returns structured preferences or defaults
 * 
 * SCHEMA NOTE: contacts.notes is append-only, non-authoritative
 */
function extractBuyerPreferences(notes: string | null): {
  minPrice?: number
  maxPrice?: number
  minBeds?: number
  minBaths?: number
  preferredCities?: string[]
  preferredStates?: string[]
  propertyTypes?: string[]
} {
  if (!notes) return {}

  try {
    // Check for structured AI inference namespace
    const notesObj = JSON.parse(notes)
    if (notesObj.ai_inference?.buyer_preferences) {
      return notesObj.ai_inference.buyer_preferences
    }
  } catch {
    // Not JSON, parse as text hints
    const prefs: any = {}

    // Price hints: "$300k-$450k" or "budget: 400000"
    const priceMatch = notes.match(/\$?([\d,]+)k?[-–to]*\$?([\d,]+)k?/i)
    if (priceMatch) {
      prefs.minPrice = parseInt(priceMatch[1].replace(/,/g, '')) * 1000
      prefs.maxPrice = parseInt(priceMatch[2].replace(/,/g, '')) * 1000
    }

    // Bedroom hints: "3+ beds" or "4 bedroom"
    const bedsMatch = notes.match(/(\d+)\+?\s*(bed|br)/i)
    if (bedsMatch) {
      prefs.minBeds = parseInt(bedsMatch[1])
    }

    // Location hints: cities mentioned
    const cities = notes.match(/(Austin|Dallas|Houston|San Antonio|Portland|Seattle|Denver)/gi)
    if (cities) {
      prefs.preferredCities = [...new Set(cities)]
    }

    return prefs
  }

  return {}
}

/**
 * Rank all buyers for a listing
 * Returns sorted list of matches (highest score first)
 */
export function rankBuyersForListing(
  buyers: BuyerProfile[],
  listing: ListingProfile
): MatchScore[] {
  const scores = buyers.map((buyer) => scoreBuyerForListing(buyer, listing))
  
  // Sort by score descending
  return scores.sort((a, b) => b.score - a.score)
}

/**
 * Filter buyers by minimum score threshold
 */
export function filterViableBuyers(
  matches: MatchScore[],
  minScore = 45
): MatchScore[] {
  return matches.filter((m) => m.score >= minScore)
}
