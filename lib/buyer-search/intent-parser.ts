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
  states?: string[]
  neighborhoods?: string[]
  
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
  // Patterns: "$400k", "$400,000", "under 500k", "300-400k", "budget of 350000"
  const pricePatterns = [
    /\$?([\d,]+)k?\s*[-–to]+\s*\$?([\d,]+)k?/i, // Range: "300k-400k"
    /under\s+\$?([\d,]+)k?/i, // Max: "under 500k"
    /below\s+\$?([\d,]+)k?/i, // Max: "below 400k"
    /max\s+\$?([\d,]+)k?/i, // Max: "max 450k"
    /budget\s+of\s+\$?([\d,]+)k?/i, // Max: "budget of 400k"
    /around\s+\$?([\d,]+)k?/i, // Target: "around 350k"
  ]

  for (const pattern of pricePatterns) {
    const match = query.match(pattern)
    if (match) {
      if (match[2]) {
        // Range detected
        intent.minPrice = parsePrice(match[1])
        intent.maxPrice = parsePrice(match[2])
        confidencePoints += 20
      } else {
        // Single value - treat as max
        intent.maxPrice = parsePrice(match[1])
        confidencePoints += 15
      }
      break
    }
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
  const stateMatch = query.match(/\b(TX|CA|FL|NY|CO|WA|OR|AZ|GA|NC|TN|NV|UT|Texas|California|Florida)\b/i)
  if (stateMatch) {
    intent.states = [stateMatch[1].toUpperCase()]
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
  const lifestyleMap = {
    family: ['family', 'kids', 'children', 'school', 'playground', 'safe neighborhood'],
    professional: ['commute', 'downtown', 'walkable', 'transit', 'work', 'office'],
    retiree: ['retirement', 'senior', 'quiet', 'peaceful', 'low maintenance', 'single story'],
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
 * Parse price string to number
 */
function parsePrice(value: string): number {
  // Remove commas and handle "k" suffix
  const cleaned = value.replace(/,/g, '')
  
  if (cleaned.toLowerCase().endsWith('k')) {
    return parseInt(cleaned) * 1000
  }
  
  return parseInt(cleaned)
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
