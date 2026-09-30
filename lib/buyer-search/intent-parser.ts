/**
 * SYSTEM 5.1B - NATURAL LANGUAGE INTENT PARSER
 * Converts buyer free-text queries into structured search criteria
 * 
 * CONSTRAINTS:
 * - Runtime-only parsing (no persistence)
 * - Extracts constraints from natural language
 * - Merges with conversation context
 */

export interface ParsedBuyerIntent {
  // Price constraints
  minPrice?: number
  maxPrice?: number
  
  // Property attributes
  minBeds?: number
  maxBeds?: number
  minBaths?: number
  propertyTypes?: string[]
  
  // Location
  cities?: string[]
  /** Two-letter USPS codes ("TX") — never a full state name, never lower case. */
  states?: string[]
  neighborhoods?: string[]
  /** Five-digit ZIPs the buyer named (wave 91). */
  zipCodes?: string[]

  /** 'rent' when the buyer's own words say renting/lease/a month (wave 91);
   *  absent = the for-sale market. */
  listingType?: 'sale' | 'rent'

  // Lifestyle & features
  features?: string[]
  mustHaves?: string[]
  niceToHaves?: string[]
  
  // Implicit signals
  urgency?: 'low' | 'medium' | 'high'
  lifestyle?: string // e.g., "family", "professional", "retiree"
  
  // Parsed metadata
  rawQuery: string
  confidence: number // 0-1, how confident we are in the parse
  ambiguities?: string[] // Things we couldn't parse clearly
}

/**
 * Parse natural language query into structured intent
 * Examples:
 * - "I need a 3 bedroom house under $400k in Austin"
 * - "Looking for something with a pool and garage"
 * - "Family-friendly neighborhood, good schools, 4+ beds"
 */
export function parseNaturalLanguageQuery(query: string): ParsedBuyerIntent {
  const intent: ParsedBuyerIntent = {
    rawQuery: query,
    confidence: 0,
    ambiguities: [],
  }

  const lowerQuery = query.toLowerCase()
  let confidencePoints = 0

  // 1. PRICE EXTRACTION
  // Patterns: "$400k", "$400,000", "under 500k", "300-400k", "budget of 350000", "$1.5m".
  // The k/m suffix is captured INSIDE the group so parsePrice can scale it (the suffix used to fall
  // outside the capture, so "under 500k" parsed as $500 — breaking the price filter).
  //
  // Wave 91 (lane 91C) — three real-estate readings the parser got wrong:
  //   · "million"/"mil" are suffixes too ("1.2 million" was $1).
  //   · A RANGE that is really a bedroom/bath count ("3-4 bed house under
  //     $400k") was read as a $3–$4 PRICE and, being the first pattern, beat
  //     the real "under $400k". The range now refuses a count unit after it.
  //   · Buyers say "under 450" and mean $450,000. A bare for-sale figure below
  //     10,000 is never a home price, so it is read in thousands — unless the
  //     buyer is RENTING ("under 2500 a month"), where it is the monthly rent.
  const NUM = String.raw`(\$?[\d,]+\.?\d*\s*(?:(?:million|mil|[km])\b)?)`
  const COUNT_UNIT = String.raw`(?!\s*\+?\s*(?:bed|br\b|bd\b|bath|ba\b|stor|car\b|garage|acre|sq|year|yr|min|mile))`
  const pricePatterns = [
    new RegExp(`${NUM}\\s*(?:[-–]|to)\\s*${NUM}${COUNT_UNIT}`, "i"), // Range: "300k-400k", "300k to 400k"
    new RegExp(`under\\s+${NUM}`, "i"),     // Max: "under 500k"
    new RegExp(`below\\s+${NUM}`, "i"),     // Max: "below 400k"
    new RegExp(`max\\s+${NUM}`, "i"),       // Max: "max 450k"
    new RegExp(`budget\\s+of\\s+${NUM}`, "i"), // Max: "budget of 400k"
    new RegExp(`around\\s+${NUM}`, "i"),    // Target: "around 350k"
  ]

  // RENT CONTEXT — decides both the market (listingType) and how a bare
  // figure is read. Only the buyer's own words: "rent", "lease", "a month".
  const rentContext = /\b(rent|renting|rental|lease|leasing|per month|a month|monthly|\/mo)\b/i.test(query)
  if (rentContext) intent.listingType = 'rent'
  const priceOf = (raw: string) => scaleBarePrice(parsePrice(raw), raw, rentContext)

  for (const pattern of pricePatterns) {
    const match = query.match(pattern)
    if (match) {
      if (match[2]) {
        // Range detected
        intent.minPrice = priceOf(match[1])
        intent.maxPrice = priceOf(match[2])
        confidencePoints += 20
      } else {
        // Single value - treat as max
        intent.maxPrice = priceOf(match[1])
        confidencePoints += 15
      }
      break
    }
  }

  // ZIP CODES — a five-digit token that is not a price ("$75034" or "75034k"
  // is money, and so is a figure already read above).
  const zipMatches = Array.from(query.matchAll(/(?<![\$\d,.])\b(\d{5})\b(?!\s*(?:k|m|mil|million)\b)(?![\d,])/gi))
    .map((m) => m[1])
    .filter((z) => Number(z) !== intent.minPrice && Number(z) !== intent.maxPrice)
  if (zipMatches.length > 0) {
    intent.zipCodes = Array.from(new Set(zipMatches))
    confidencePoints += 15
  }

  // 2. BEDROOM EXTRACTION
  // Patterns: "3 bed", "4+ bedroom", "at least 3 beds", "3-4 bedrooms"
  const bedsMatch = query.match(/(\d+)\s*[-–to]+\s*(\d+)\s*(bed|br)/i)
  if (bedsMatch) {
    intent.minBeds = parseInt(bedsMatch[1])
    intent.maxBeds = parseInt(bedsMatch[2])
    confidencePoints += 15
  } else {
    const minBedsMatch = query.match(/(\d+)\+?\s*(bed|br|bedroom)/i)
    if (minBedsMatch) {
      intent.minBeds = parseInt(minBedsMatch[1])
      confidencePoints += 15
    }
  }

  // 3. BATHROOM EXTRACTION
  const bathsMatch = query.match(/(\d+\.?\d?)\+?\s*(bath|bathroom)/i)
  if (bathsMatch) {
    intent.minBaths = parseFloat(bathsMatch[1])
    confidencePoints += 10
  }

  // 4. PROPERTY TYPE EXTRACTION
  const propertyTypeMap: Record<string, string> = {
    'single family': 'single_family',
    'single-family': 'single_family',
    house: 'single_family',
    condo: 'condo',
    townhouse: 'townhouse',
    townhome: 'townhouse',
    apartment: 'apartment',
    'multi-family': 'multi_family',
    duplex: 'multi_family',
  }

  const detectedTypes: string[] = []
  for (const [keyword, type] of Object.entries(propertyTypeMap)) {
    if (lowerQuery.includes(keyword)) {
      if (!detectedTypes.includes(type)) {
        detectedTypes.push(type)
      }
    }
  }

  if (detectedTypes.length > 0) {
    intent.propertyTypes = detectedTypes
    confidencePoints += 10
  }

  // 5. LOCATION EXTRACTION
  // Common cities (expandable)
  const cityMap = [
    'austin', 'dallas', 'houston', 'san antonio', 'fort worth',
    'portland', 'seattle', 'denver', 'phoenix', 'atlanta',
    'miami', 'orlando', 'tampa', 'charlotte', 'nashville',
    'raleigh', 'boston', 'chicago', 'new york', 'los angeles',
    'san francisco', 'san diego', 'las vegas', 'salt lake city',
  ]

  const detectedCities: string[] = []
  for (const city of cityMap) {
    if (lowerQuery.includes(city)) {
      detectedCities.push(city.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '))
      confidencePoints += 15
    }
  }

  if (detectedCities.length > 0) {
    intent.cities = detectedCities
  }

  // State extraction (abbreviations or full names)
  //
  // Wave 91: the abbreviations are matched CASE-SENSITIVELY. With `/i`, the
  // word "or" in "condo or townhouse" was read as Oregon, and the platform
  // search then filtered `state in ('OR')` — an empty page for every
  // either/or buyer. Full names map to their USPS code (listings.state holds
  // "TX", never "TEXAS", which is what `.toUpperCase()` used to produce).
  const STATE_NAMES: Record<string, string> = { texas: 'TX', california: 'CA', florida: 'FL' }
  const stateAbbrev = query.match(/\b(TX|CA|FL|NY|CO|WA|OR|AZ|GA|NC|TN|NV|UT)\b/)
  const stateName = lowerQuery.match(/\b(texas|california|florida)\b/)
  const stateCode = stateAbbrev?.[1] ?? (stateName ? STATE_NAMES[stateName[1]] : undefined)
  if (stateCode) {
    intent.states = [stateCode]
    confidencePoints += 10
  }

  // 6. FEATURES EXTRACTION
  const featureKeywords = [
    'pool', 'garage', 'backyard', 'yard', 'patio', 'fireplace',
    'hardwood', 'granite', 'stainless', 'updated', 'renovated',
    'walk-in closet', 'master suite', 'ensuite', 'office',
    'study', 'den', 'bonus room', 'finished basement',
  ]

  const detectedFeatures: string[] = []
  for (const feature of featureKeywords) {
    if (lowerQuery.includes(feature)) {
      detectedFeatures.push(feature)
    }
  }

  if (detectedFeatures.length > 0) {
    intent.features = detectedFeatures
    confidencePoints += 5
  }

  // 7. URGENCY SIGNALS
  const urgencySignals = {
    high: ['asap', 'urgent', 'immediately', 'right away', 'soon', 'quickly', 'fast'],
    medium: ['next month', 'within', 'by', 'before'],
    low: ['browsing', 'exploring', 'considering', 'looking around', 'just started'],
  }

  for (const [level, signals] of Object.entries(urgencySignals)) {
    if (signals.some(signal => lowerQuery.includes(signal))) {
      intent.urgency = level as 'low' | 'medium' | 'high'
      confidencePoints += 5
      break
    }
  }

  // 8. LIFESTYLE SIGNALS
  // FAIR HOUSING: we do NOT infer familial status (family/kids/schools) or age (senior/retiree) —
  // those are protected classes and steering on them is illegal. Only buyer-INTENT signals that are
  // not protected classes are inferred (commute/transit = relocation intent; investment = investor).
  const lifestyleMap = {
    professional: ['commute', 'downtown', 'walkable', 'transit', 'work', 'office'],
    investor: ['investment', 'rental', 'cash flow', 'roi', 'appreciation'],
  }

  for (const [lifestyle, keywords] of Object.entries(lifestyleMap)) {
    if (keywords.some(kw => lowerQuery.includes(kw))) {
      intent.lifestyle = lifestyle
      confidencePoints += 5
      break
    }
  }

  // 9. MUST-HAVES vs NICE-TO-HAVES
  if (lowerQuery.includes('must have') || lowerQuery.includes('need')) {
    const mustHaveMatch = query.match(/(?:must have|need)\s+(.+?)(?:\.|,|and|$)/i)
    if (mustHaveMatch) {
      intent.mustHaves = [mustHaveMatch[1].trim()]
    }
  }

  if (lowerQuery.includes('nice to have') || lowerQuery.includes('would like')) {
    const niceToHaveMatch = query.match(/(?:nice to have|would like)\s+(.+?)(?:\.|,|and|$)/i)
    if (niceToHaveMatch) {
      intent.niceToHaves = [niceToHaveMatch[1].trim()]
    }
  }

  // 10. CALCULATE CONFIDENCE
  intent.confidence = Math.min(1, confidencePoints / 100)

  // 11. FLAG AMBIGUITIES
  if (!intent.maxPrice && !intent.minPrice) {
    intent.ambiguities?.push('No price range specified')
  }
  if (!intent.cities && !intent.states) {
    intent.ambiguities?.push('No location specified')
  }
  if (!intent.minBeds) {
    intent.ambiguities?.push('No bedroom count specified')
  }

  return intent
}

/**
 * Merge parsed intent with conversation context signals
 * Conversation insights may provide missing constraints
 */
export function mergeIntentWithContext(
  parsedIntent: ParsedBuyerIntent,
  conversationContext?: {
    inferred_intent?: string | null
    urgency_level?: string | null
    existing_preferences?: Record<string, any>
  }
): ParsedBuyerIntent {
  const merged = { ...parsedIntent }

  if (!conversationContext) return merged

  // Use conversation urgency if not detected in query
  if (!merged.urgency && conversationContext.urgency_level) {
    merged.urgency = conversationContext.urgency_level as 'low' | 'medium' | 'high'
  }

  // Apply existing preferences from past conversations
  if (conversationContext.existing_preferences) {
    const prefs = conversationContext.existing_preferences

    if (!merged.maxPrice && prefs.maxPrice) {
      merged.maxPrice = prefs.maxPrice
      merged.ambiguities = merged.ambiguities?.filter(a => !a.includes('price'))
    }

    if (!merged.cities && prefs.preferredCities) {
      merged.cities = prefs.preferredCities
      merged.ambiguities = merged.ambiguities?.filter(a => !a.includes('location'))
    }

    if (!merged.minBeds && prefs.minBeds) {
      merged.minBeds = prefs.minBeds
      merged.ambiguities = merged.ambiguities?.filter(a => !a.includes('bedroom'))
    }
  }

  // Boost confidence if context fills gaps
  if (conversationContext.existing_preferences) {
    merged.confidence = Math.min(1, merged.confidence + 0.15)
  }

  return merged
}

/**
 * Parse a price token to a number, scaling the k (thousands) / m (millions) suffix.
 * "$500k" → 500000, "1.5m" → 1500000, "400,000" → 400000, "450" → 450.
 */
function parsePrice(value: string): number {
  const cleaned = value.replace(/[$,\s]/g, '').toLowerCase()
  const num = parseFloat(cleaned)
  if (Number.isNaN(num)) return NaN
  if (cleaned.endsWith('k')) return Math.round(num * 1000)
  if (cleaned.endsWith('m') || cleaned.endsWith('mil') || cleaned.endsWith('million')) return Math.round(num * 1_000_000)
  return Math.round(num)
}

/**
 * A bare FOR-SALE figure the buyer said without a unit ("under 450") is in
 * thousands: no home sells for $450, and "under 450" is how buyers say it.
 * Only a figure from 50 to 9,999 with NO k/m/million suffix is scaled; a
 * renter's figure is their monthly rent and is never scaled. PURE.
 */
function scaleBarePrice(value: number, raw: string, rentContext: boolean): number {
  if (!Number.isFinite(value) || rentContext) return value
  if (/(?:k|m|mil|million)\s*$/i.test(raw.trim())) return value
  if (value >= 50 && value < 10_000) return value * 1000
  return value
}

/**
 * Convert intent to SQL-compatible filters
 * Returns filter object for Supabase queries
 */
export function intentToFilters(intent: ParsedBuyerIntent): {
  priceRange?: { min?: number; max?: number }
  bedrooms?: { min?: number; max?: number }
  bathrooms?: { min?: number }
  propertyTypes?: string[]
  cities?: string[]
  states?: string[]
  features?: string[]
} {
  return {
    priceRange: intent.minPrice || intent.maxPrice 
      ? { min: intent.minPrice, max: intent.maxPrice } 
      : undefined,
    bedrooms: intent.minBeds || intent.maxBeds 
      ? { min: intent.minBeds, max: intent.maxBeds } 
      : undefined,
    bathrooms: intent.minBaths ? { min: intent.minBaths } : undefined,
    propertyTypes: intent.propertyTypes,
    cities: intent.cities,
    states: intent.states,
    features: intent.features,
  }
}
