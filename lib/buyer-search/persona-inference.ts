/**
 * SYSTEM 5.1B - BUYER PERSONA INFERENCE
 * Infer buyer persona dynamically from intent and conversation signals
 * 
 * CONSTRAINTS:
 * - Runtime-only inference (NOT persisted to schema)
 * - Affects explanation tone and focus ONLY
 * - Does NOT create user profiles or segments
 */

import type { ParsedBuyerIntent } from './intent-parser'

export type BuyerPersona = 
  | 'first_time_buyer'
  | 'move_up_buyer'
  | 'investor'
  | 'relocation'
  | 'downsizer'
  | 'luxury_buyer'
  | 'bargain_hunter'
  | 'undetermined'

export interface PersonaProfile {
  persona: BuyerPersona
  confidence: number // 0-1
  indicators: string[] // What led to this inference
  tone: 'educational' | 'professional' | 'analytical' | 'warm' | 'direct'
  focusAreas: string[] // What to emphasize in explanations
}

/**
 * Infer buyer persona from intent signals and conversation context
 * NEVER persisted - computed at runtime only
 */
export function inferBuyerPersona(
  intent: ParsedBuyerIntent,
  conversationContext?: {
    sentiment?: string | null
    inferred_intent?: string | null
    health_score?: number | null
  }
): PersonaProfile {
  const indicators: string[] = []
  let confidence = 0.5 // Base confidence

  // Default fallback
  let persona: BuyerPersona = 'undetermined'
  let tone: PersonaProfile['tone'] = 'warm'
  let focusAreas: string[] = ['location', 'price', 'features']

  // 1. FIRST-TIME BUYER SIGNALS
  const firstTimeBuyerSignals = [
    intent.rawQuery.toLowerCase().includes('first home'),
    intent.rawQuery.toLowerCase().includes('first time'),
    intent.rawQuery.toLowerCase().includes('starter home'),
    intent.maxPrice && intent.maxPrice < 300000,
    intent.lifestyle === 'family',
  ]

  const firstTimeBuyerScore = firstTimeBuyerSignals.filter(Boolean).length

  if (firstTimeBuyerScore >= 2) {
    persona = 'first_time_buyer'
    tone = 'educational'
    focusAreas = ['neighborhood', 'affordability', 'schools', 'safety', 'commute']
    indicators.push('First-time buyer language detected')
    if (intent.maxPrice && intent.maxPrice < 300000) {
      indicators.push('Budget aligns with starter home')
    }
    confidence = Math.min(0.9, 0.5 + firstTimeBuyerScore * 0.15)
  }

  // 2. INVESTOR SIGNALS
  const investorSignals = [
    intent.lifestyle === 'investor',
    intent.rawQuery.toLowerCase().includes('investment'),
    intent.rawQuery.toLowerCase().includes('rental'),
    intent.rawQuery.toLowerCase().includes('cash flow'),
    intent.rawQuery.toLowerCase().includes('roi'),
    intent.propertyTypes?.includes('multi_family'),
  ]

  const investorScore = investorSignals.filter(Boolean).length

  if (investorScore >= 2 && investorScore > firstTimeBuyerScore) {
    persona = 'investor'
    tone = 'analytical'
    focusAreas = ['price_per_sqft', 'rental_potential', 'appreciation', 'cap_rate', 'condition']
    indicators.push('Investment-focused language')
    confidence = Math.min(0.95, 0.5 + investorScore * 0.15)
  }

  // 3. RELOCATION SIGNALS
  const relocationSignals = [
    intent.rawQuery.toLowerCase().includes('moving to'),
    intent.rawQuery.toLowerCase().includes('relocating'),
    intent.rawQuery.toLowerCase().includes('transfer'),
    intent.rawQuery.toLowerCase().includes('new to'),
    intent.lifestyle === 'professional',
    intent.urgency === 'high',
  ]

  const relocationScore = relocationSignals.filter(Boolean).length

  if (relocationScore >= 2 && relocationScore > Math.max(firstTimeBuyerScore, investorScore)) {
    persona = 'relocation'
    tone = 'professional'
    focusAreas = ['commute', 'amenities', 'neighborhood_info', 'schools', 'move_in_ready']
    indicators.push('Relocation context detected')
    confidence = Math.min(0.85, 0.5 + relocationScore * 0.12)
  }

  // 4. DOWNSIZER SIGNALS
  const downsizerSignals = [
    intent.rawQuery.toLowerCase().includes('downsize'),
    intent.rawQuery.toLowerCase().includes('empty nest'),
    intent.rawQuery.toLowerCase().includes('retirement'),
    intent.lifestyle === 'retiree',
    intent.minBeds && intent.minBeds <= 2,
    intent.features?.includes('single story') || intent.rawQuery.toLowerCase().includes('single story'),
    intent.features?.includes('low maintenance'),
  ]

  const downsizerScore = downsizerSignals.filter(Boolean).length

  if (downsizerScore >= 2 && downsizerScore > Math.max(firstTimeBuyerScore, investorScore, relocationScore)) {
    persona = 'downsizer'
    tone = 'warm'
    focusAreas = ['maintenance', 'accessibility', 'community', 'walkability', 'amenities']
    indicators.push('Downsizing indicators present')
    confidence = Math.min(0.85, 0.5 + downsizerScore * 0.12)
  }

  // 5. LUXURY BUYER SIGNALS
  const luxuryBuyerSignals = [
    intent.minPrice && intent.minPrice > 1000000,
    intent.maxPrice && intent.maxPrice > 1500000,
    intent.rawQuery.toLowerCase().includes('luxury'),
    intent.rawQuery.toLowerCase().includes('high-end'),
    intent.rawQuery.toLowerCase().includes('estate'),
    intent.features && intent.features.length > 5,
  ]

  const luxuryBuyerScore = luxuryBuyerSignals.filter(Boolean).length

  if (luxuryBuyerScore >= 2) {
    persona = 'luxury_buyer'
    tone = 'professional'
    focusAreas = ['exclusivity', 'premium_features', 'location_prestige', 'views', 'privacy']
    indicators.push('Luxury-tier budget and preferences')
    confidence = Math.min(0.9, 0.5 + luxuryBuyerScore * 0.15)
  }

  // 6. MOVE-UP BUYER SIGNALS (requires previous home ownership context)
  if (conversationContext?.inferred_intent?.toLowerCase().includes('upgrade') ||
      conversationContext?.inferred_intent?.toLowerCase().includes('larger home')) {
    if (persona === 'undetermined') {
      persona = 'move_up_buyer'
      tone = 'professional'
      focusAreas = ['space', 'upgraded_features', 'schools', 'neighborhood', 'resale_value']
      indicators.push('Move-up buyer context from conversations')
      confidence = 0.7
    }
  }

  // 7. BARGAIN HUNTER SIGNALS
  const bargainHunterSignals = [
    intent.rawQuery.toLowerCase().includes('deal'),
    intent.rawQuery.toLowerCase().includes('bargain'),
    intent.rawQuery.toLowerCase().includes('fixer'),
    intent.rawQuery.toLowerCase().includes('needs work'),
    intent.rawQuery.toLowerCase().includes('below market'),
    intent.urgency === 'low',
  ]

  const bargainHunterScore = bargainHunterSignals.filter(Boolean).length

  if (bargainHunterScore >= 2 && persona === 'undetermined') {
    persona = 'bargain_hunter'
    tone = 'direct'
    focusAreas = ['value', 'price_reduction', 'potential', 'negotiation', 'comparables']
    indicators.push('Bargain-hunting behavior detected')
    confidence = Math.min(0.8, 0.5 + bargainHunterScore * 0.1)
  }

  // 8. ADJUST CONFIDENCE BASED ON CONVERSATION HEALTH
  if (conversationContext?.health_score) {
    if (conversationContext.health_score > 70) {
      confidence = Math.min(1, confidence + 0.1) // More data = more confidence
    } else if (conversationContext.health_score < 30) {
      confidence = Math.max(0.3, confidence - 0.15) // Little data = less confidence
    }
  }

  // 9. FALLBACK FOR UNDETERMINED
  if (persona === 'undetermined') {
    indicators.push('Insufficient signals for specific persona')
    tone = 'warm' // Neutral, friendly tone
    focusAreas = ['location', 'price', 'features', 'neighborhood']
  }

  return {
    persona,
    confidence,
    indicators,
    tone,
    focusAreas,
  }
}

/**
 * Get persona-specific messaging guidelines
 * Used to craft buyer-friendly explanations
 */
export function getPersonaMessagingGuidelines(persona: BuyerPersona): {
  greetingStyle: string
  emphasisOn: string[]
  avoidMentioning: string[]
  examplePhrases: string[]
} {
  switch (persona) {
    case 'first_time_buyer':
      return {
        greetingStyle: 'Warm and educational',
        emphasisOn: ['neighborhood safety', 'school quality', 'commute times', 'affordability', 'move-in ready'],
        avoidMentioning: ['complex financial terms', 'advanced investment metrics'],
        examplePhrases: [
          'This home is perfect for starting your homeownership journey',
          'Located in a family-friendly neighborhood',
          'Well within your budget',
        ],
      }

    case 'investor':
      return {
        greetingStyle: 'Professional and analytical',
        emphasisOn: ['cap rate', 'rental income potential', 'appreciation trends', 'price per sqft', 'ROI'],
        avoidMentioning: ['emotional appeal', 'lifestyle features'],
        examplePhrases: [
          'Strong rental demand in this area',
          'Below-market price per square foot',
          'Excellent cash flow potential',
        ],
      }

    case 'relocation':
      return {
        greetingStyle: 'Professional and informative',
        emphasisOn: ['commute to major employers', 'neighborhood amenities', 'move-in ready status', 'schools'],
        avoidMentioning: ['local insider knowledge assumptions'],
        examplePhrases: [
          'Convenient to major employers',
          'Well-connected to transit options',
          'Ready for immediate occupancy',
        ],
      }

    case 'downsizer':
      return {
        greetingStyle: 'Warm and respectful',
        emphasisOn: ['low maintenance', 'single-story layout', 'community amenities', 'walkability', 'accessibility'],
        avoidMentioning: ['yardwork', 'DIY projects', 'complex renovations'],
        examplePhrases: [
          'Easy to maintain with minimal upkeep',
          'Active community with great amenities',
          'Everything you need on one level',
        ],
      }

    case 'luxury_buyer':
      return {
        greetingStyle: 'Sophisticated and discreet',
        emphasisOn: ['exclusivity', 'premium finishes', 'privacy', 'views', 'architectural significance'],
        avoidMentioning: ['budget concerns', 'bargain language'],
        examplePhrases: [
          'Rare opportunity in this prestigious neighborhood',
          'Uncompromising quality throughout',
          'Architectural masterpiece',
        ],
      }

    case 'move_up_buyer':
      return {
        greetingStyle: 'Professional and aspirational',
        emphasisOn: ['more space', 'upgraded features', 'better schools', 'neighborhood prestige', 'resale value'],
        avoidMentioning: ['starter home language', 'basic features'],
        examplePhrases: [
          'The perfect next step for your growing family',
          'Premium features throughout',
          'Top-rated school district',
        ],
      }

    case 'bargain_hunter':
      return {
        greetingStyle: 'Direct and value-focused',
        emphasisOn: ['price reductions', 'below-market value', 'potential', 'comparables', 'negotiation opportunity'],
        avoidMentioning: ['premium positioning', 'luxury language'],
        examplePhrases: [
          'Priced below market comps',
          'Great value opportunity',
          'Room to negotiate',
        ],
      }

    default: // undetermined
      return {
        greetingStyle: 'Friendly and neutral',
        emphasisOn: ['location', 'features', 'price', 'condition'],
        avoidMentioning: ['overly specific assumptions'],
        examplePhrases: [
          'This property matches your search criteria',
          'Located in a desirable area',
          'Well-priced for the market',
        ],
      }
  }
}
