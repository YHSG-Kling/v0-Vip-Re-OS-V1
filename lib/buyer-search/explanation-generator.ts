/**
 * SYSTEM 5.1B - BUYER-PERSONA EXPLANATION GENERATOR
 * Generate natural, buyer-friendly match explanations
 * 
 * CONSTRAINTS:
 * - Use second-person language ("you", "your")
 * - Reference what the buyer said or implied
 * - NO mention of AI, algorithms, scores, internal logic
 * - Persona-aware tone and focus
 */

import type { ParsedBuyerIntent } from './intent-parser'
import type { PersonaProfile } from './persona-inference'
import type { ListingProfile } from '@/lib/property-matching'

export interface BuyerFacingExplanation {
  headline: string // Short, compelling match reason
  bullets: string[] // 3-5 bullet points
  narrative: string // 2-3 sentence natural explanation
  callToAction: string // Next step suggestion
}

/**
 * Generate buyer-friendly explanation for why a listing matches
 * Tailored to buyer persona and intent
 */
export function generateMatchExplanation(
  listing: ListingProfile,
  intent: ParsedBuyerIntent,
  persona: PersonaProfile,
  matchScore: number // Internal score, used for calibration only
): BuyerFacingExplanation {
  const bullets: string[] = []
  let headline = ''
  let narrative = ''
  let callToAction = ''

  // Get persona-specific guidelines
  const { emphasisOn, examplePhrases } = getPersonaGuidelines(persona.persona)

  // 1. HEADLINE - Strong, persona-aligned hook
  if (matchScore >= 80) {
    headline = generateStrongMatchHeadline(listing, intent, persona)
  } else if (matchScore >= 60) {
    headline = generateGoodMatchHeadline(listing, intent, persona)
  } else {
    headline = generateViableMatchHeadline(listing, intent, persona)
  }

  // 2. BULLETS - Top reasons, persona-focused
  
  // Price bullet
  if (intent.maxPrice && listing.price && listing.price <= intent.maxPrice) {
    const priceFriendly = formatPrice(listing.price)
    if (persona.persona === 'investor') {
      bullets.push(`Listed at ${priceFriendly}, below your target threshold`)
    } else if (persona.persona === 'first_time_buyer') {
      bullets.push(`Priced at ${priceFriendly} – within your budget`)
    } else if (persona.persona === 'bargain_hunter') {
      bullets.push(`${priceFriendly} asking price – room to negotiate`)
    } else {
      bullets.push(`${priceFriendly} aligns with your budget`)
    }
  }

  // Bedroom bullet
  if (intent.minBeds && listing.bedrooms && listing.bedrooms >= intent.minBeds) {
    if (persona.persona === 'first_time_buyer' || persona.persona === 'move_up_buyer') {
      bullets.push(`${listing.bedrooms} bedrooms for your ${intent.lifestyle === 'family' ? 'growing family' : 'needs'}`)
    } else if (persona.persona === 'investor') {
      bullets.push(`${listing.bedrooms} beds – strong rental appeal`)
    } else {
      bullets.push(`${listing.bedrooms} bedrooms as you requested`)
    }
  }

  // Location bullet
  if (intent.cities && listing.city && intent.cities.some(c => c.toLowerCase() === (listing.city ?? "").toLowerCase())) {
    if (persona.persona === 'relocation') {
      bullets.push(`Located in ${listing.city} where you're relocating`)
    } else if (persona.persona === 'first_time_buyer') {
      bullets.push(`In your preferred area: ${listing.city}`)
    } else {
      bullets.push(`${listing.city} location matches your search`)
    }
  }

  // Property type bullet
  if (intent.propertyTypes && listing.property_type && intent.propertyTypes.includes(listing.property_type)) {
    const typeFriendly = formatPropertyType(listing.property_type)
    bullets.push(`${typeFriendly} as you're looking for`)
  }

  // Features bullet (persona-specific)
  if (listing.features && listing.features.length > 0) {
    const relevantFeatures = getRelevantFeatures(listing.features, persona, intent)
    if (relevantFeatures.length > 0) {
      const featureList = relevantFeatures.slice(0, 3).join(', ')
      bullets.push(`Features: ${featureList}`)
    }
  }

  // Size/space bullet (if relevant to persona)
  if (listing.square_feet && ['move_up_buyer', 'family', 'investor'].includes(persona.persona)) {
    const sqftFriendly = listing.square_feet.toLocaleString()
    if (persona.persona === 'move_up_buyer') {
      bullets.push(`${sqftFriendly} sq ft – plenty of space to grow`)
    } else if (persona.persona === 'investor') {
      bullets.push(`${sqftFriendly} sq ft at ${formatPricePerSqft(listing.price, listing.square_feet)}/sq ft`)
    }
  }

  // Urgency-based bullet
  if (intent.urgency === 'high' && listing.status === 'active') {
    bullets.push('Available now – move-in ready')
  }

  // Limit to 5 bullets max
  const finalBullets = bullets.slice(0, 5)

  // 3. NARRATIVE - Natural language explanation
  narrative = generateNarrative(listing, intent, persona, finalBullets)

  // 4. CALL TO ACTION - Next step
  callToAction = generateCallToAction(persona, intent.urgency)

  return {
    headline,
    bullets: finalBullets,
    narrative,
    callToAction,
  }
}

/**
 * Generate strong match headlines (80+ score)
 */
function generateStrongMatchHeadline(
  listing: ListingProfile,
  intent: ParsedBuyerIntent,
  persona: PersonaProfile
): string {
  const location = listing.city || 'this area'

  switch (persona.persona) {
    case 'first_time_buyer':
      return `Excellent starter home in ${location}`
    case 'investor':
      return `High-potential investment in ${location}`
    case 'relocation':
      return `Perfect fit for your move to ${location}`
    case 'downsizer':
      return `Ideal low-maintenance home in ${location}`
    case 'luxury_buyer':
      return `Premium property in ${location}`
    case 'move_up_buyer':
      return `Outstanding upgrade opportunity in ${location}`
    case 'bargain_hunter':
      return `Exceptional value in ${location}`
    default:
      return `Great match in ${location}`
  }
}

/**
 * Generate good match headlines (60-79 score)
 */
function generateGoodMatchHeadline(
  listing: ListingProfile,
  intent: ParsedBuyerIntent,
  persona: PersonaProfile
): string {
  const beds = listing.bedrooms ? `${listing.bedrooms}-bedroom ` : ''
  const type = formatPropertyType(listing.property_type)

  switch (persona.persona) {
    case 'first_time_buyer':
      return `Solid ${beds}${type} to start your journey`
    case 'investor':
      return `Promising ${beds}${type} with rental potential`
    case 'relocation':
      return `Well-located ${beds}${type} for your move`
    case 'downsizer':
      return `Comfortable ${beds}${type} with easy upkeep`
    case 'luxury_buyer':
      return `Quality ${beds}${type} in desirable location`
    case 'move_up_buyer':
      return `Spacious ${beds}${type} for your next chapter`
    case 'bargain_hunter':
      return `Good value ${beds}${type}`
    default:
      return `Nice ${beds}${type} matching your criteria`
  }
}

/**
 * Generate viable match headlines (45-59 score)
 */
function generateViableMatchHeadline(
  listing: ListingProfile,
  intent: ParsedBuyerIntent,
  persona: PersonaProfile
): string {
  return `${formatPropertyType(listing.property_type)} worth considering`
}

/**
 * Generate natural language narrative
 */
function generateNarrative(
  listing: ListingProfile,
  intent: ParsedBuyerIntent,
  persona: PersonaProfile,
  bullets: string[]
): string {
  const location = listing.city ? `in ${listing.city}` : 'in this area'
  const type = formatPropertyType(listing.property_type)

  // Build context-aware narrative
  let intro = ''
  let connection = ''
  let closing = ''

  // Intro - Acknowledge their search
  if (intent.rawQuery.length > 20) {
    intro = `Based on what you're looking for, `
  } else {
    intro = `This property `
  }

  // Connection - Link to their needs
  switch (persona.persona) {
    case 'first_time_buyer':
      connection = `this ${type} ${location} offers everything you need to confidently start homeownership. `
      closing = `It's move-in ready and positioned in a neighborhood that's perfect for building your future.`
      break

    case 'investor':
      connection = `this ${type} ${location} presents a solid investment opportunity. `
      closing = `The fundamentals are strong, and the area shows consistent demand.`
      break

    case 'relocation':
      connection = `this ${type} ${location} will help you settle in quickly. `
      closing = `It's convenient to major employment centers and offers immediate availability.`
      break

    case 'downsizer':
      connection = `this ${type} ${location} provides the comfort and convenience you're seeking. `
      closing = `Enjoy easy maintenance and access to community amenities.`
      break

    case 'luxury_buyer':
      connection = `this ${type} ${location} delivers the quality and exclusivity you expect. `
      closing = `Every detail reflects uncompromising standards.`
      break

    case 'move_up_buyer':
      connection = `this ${type} ${location} offers the space and upgrades you've been looking for. `
      closing = `It's positioned to meet your family's evolving needs while maintaining strong resale value.`
      break

    case 'bargain_hunter':
      connection = `this ${type} ${location} is priced competitively. `
      closing = `There's potential here, and the numbers work in your favor.`
      break

    default:
      connection = `matches several of your key criteria. `
      closing = `It's worth exploring further.`
  }

  return intro + connection + closing
}

/**
 * Generate persona-appropriate call to action
 */
function generateCallToAction(persona: PersonaProfile, urgency?: string): string {
  if (urgency === 'high') {
    return 'Schedule a showing today'
  }

  switch (persona.persona) {
    case 'first_time_buyer':
      return 'Schedule a tour to see if it feels like home'
    case 'investor':
      return 'Request detailed financials and comparable sales'
    case 'relocation':
      return 'Book a virtual or in-person tour'
    case 'downsizer':
      return 'Schedule a relaxed walkthrough'
    case 'luxury_buyer':
      return 'Arrange a private showing'
    case 'move_up_buyer':
      return 'See it in person with your family'
    case 'bargain_hunter':
      return 'Submit an offer or request more details'
    default:
      return 'Schedule a showing to learn more'
  }
}

/**
 * Get persona-specific messaging guidelines
 */
function getPersonaGuidelines(persona: string) {
  // Simplified version for internal use
  const guidelines: Record<string, { emphasisOn: string[]; examplePhrases: string[] }> = {
    first_time_buyer: {
      emphasisOn: ['affordability', 'neighborhood', 'safety', 'schools'],
      examplePhrases: ['perfect to start', 'great neighborhood', 'within budget'],
    },
    investor: {
      emphasisOn: ['cash flow', 'cap rate', 'rental demand', 'appreciation'],
      examplePhrases: ['strong returns', 'solid fundamentals', 'rental potential'],
    },
    relocation: {
      emphasisOn: ['commute', 'amenities', 'move-in ready'],
      examplePhrases: ['convenient location', 'ready to occupy', 'well-connected'],
    },
    downsizer: {
      emphasisOn: ['low maintenance', 'accessibility', 'community'],
      examplePhrases: ['easy upkeep', 'active community', 'single level'],
    },
    luxury_buyer: {
      emphasisOn: ['exclusivity', 'quality', 'prestige'],
      examplePhrases: ['exceptional quality', 'rare opportunity', 'premium finishes'],
    },
    move_up_buyer: {
      emphasisOn: ['space', 'upgrades', 'schools', 'resale'],
      examplePhrases: ['room to grow', 'upgraded features', 'strong resale'],
    },
    bargain_hunter: {
      emphasisOn: ['value', 'price', 'potential'],
      examplePhrases: ['great value', 'below market', 'priced right'],
    },
  }

  return guidelines[persona] || { emphasisOn: [], examplePhrases: [] }
}

/**
 * Filter features relevant to persona and intent
 */
function getRelevantFeatures(
  features: string[],
  persona: PersonaProfile,
  intent: ParsedBuyerIntent
): string[] {
  const priorityFeatures: string[] = []

  // Filter based on persona focus
  features.forEach(feature => {
    const featureLower = feature.toLowerCase()

    if (persona.persona === 'first_time_buyer') {
      if (['updated kitchen', 'new appliances', 'move-in ready', 'garage'].some(p => featureLower.includes(p))) {
        priorityFeatures.push(feature)
      }
    } else if (persona.persona === 'investor') {
      if (['separate entrance', 'rental unit', 'income potential', 'low maintenance'].some(p => featureLower.includes(p))) {
        priorityFeatures.push(feature)
      }
    } else if (persona.persona === 'luxury_buyer') {
      if (['gourmet kitchen', 'wine cellar', 'smart home', 'pool', 'views'].some(p => featureLower.includes(p))) {
        priorityFeatures.push(feature)
      }
    } else if (persona.persona === 'downsizer') {
      if (['single story', 'elevator', 'no stairs', 'hoa amenities'].some(p => featureLower.includes(p))) {
        priorityFeatures.push(feature)
      }
    } else {
      // General relevance
      if (intent.features?.some(f => featureLower.includes(f.toLowerCase()))) {
        priorityFeatures.push(feature)
      } else {
        priorityFeatures.push(feature)
      }
    }
  })

  return priorityFeatures
}

/**
 * Format helpers
 */
function formatPrice(price: number | null): string {
  if (!price) return 'Price available upon request'
  return `$${(price / 1000).toFixed(0)}K`
}

function formatPricePerSqft(price: number | null, sqft: number | null): string {
  if (!price || !sqft) return 'N/A'
  const pricePerSqft = price / sqft
  return `$${pricePerSqft.toFixed(0)}`
}

function formatPropertyType(type: string | null): string {
  if (!type) return 'property'
  
  const typeMap: Record<string, string> = {
    single_family: 'single-family home',
    condo: 'condo',
    townhouse: 'townhouse',
    multi_family: 'multi-family property',
    apartment: 'apartment',
  }

  return typeMap[type] || type
}
