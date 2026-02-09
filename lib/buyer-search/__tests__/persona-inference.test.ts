/**
 * SYSTEM 5.1B - PERSONA INFERENCE TESTS
 * Unit tests for buyer persona detection
 */

import { inferBuyerPersona, getPersonaMessagingGuidelines } from '../persona-inference'
import { parseNaturalLanguageQuery } from '../intent-parser'

describe('inferBuyerPersona', () => {
  test('detects first-time buyer from query', () => {
    const intent = parseNaturalLanguageQuery('First home under $300k, 3 beds')
    const persona = inferBuyerPersona(intent)
    
    expect(persona.persona).toBe('first_time_buyer')
    expect(persona.tone).toBe('educational')
    expect(persona.focusAreas).toContain('affordability')
    expect(persona.confidence).toBeGreaterThan(0.6)
  })

  test('detects investor from query', () => {
    const intent = parseNaturalLanguageQuery('Investment property with good cash flow and rental potential')
    const persona = inferBuyerPersona(intent)
    
    expect(persona.persona).toBe('investor')
    expect(persona.tone).toBe('analytical')
    expect(persona.focusAreas).toContain('rental_potential')
    expect(persona.focusAreas).toContain('cap_rate')
  })

  test('detects relocation from query', () => {
    const intent = parseNaturalLanguageQuery('Moving to Austin for work, need house near downtown')
    const persona = inferBuyerPersona(intent)
    
    expect(persona.persona).toBe('relocation')
    expect(persona.tone).toBe('professional')
    expect(persona.focusAreas).toContain('commute')
  })

  test('detects downsizer from query', () => {
    const intent = parseNaturalLanguageQuery('Downsizing to single story, 2 bed with low maintenance')
    const persona = inferBuyerPersona(intent)
    
    expect(persona.persona).toBe('downsizer')
    expect(persona.tone).toBe('warm')
    expect(persona.focusAreas).toContain('maintenance')
    expect(persona.focusAreas).toContain('accessibility')
  })

  test('detects luxury buyer from price', () => {
    const intent = parseNaturalLanguageQuery('Estate home $2M-$3M with premium features')
    const persona = inferBuyerPersona(intent)
    
    expect(persona.persona).toBe('luxury_buyer')
    expect(persona.tone).toBe('professional')
    expect(persona.focusAreas).toContain('exclusivity')
  })

  test('detects move-up buyer from conversation context', () => {
    const intent = parseNaturalLanguageQuery('4 bed house under $600k')
    const persona = inferBuyerPersona(intent, {
      inferred_intent: 'Looking to upgrade to larger home',
    })
    
    expect(persona.persona).toBe('move_up_buyer')
    expect(persona.focusAreas).toContain('space')
  })

  test('detects bargain hunter from query', () => {
    const intent = parseNaturalLanguageQuery('Looking for fixer-upper or good deal below market value')
    const persona = inferBuyerPersona(intent)
    
    expect(persona.persona).toBe('bargain_hunter')
    expect(persona.tone).toBe('direct')
    expect(persona.focusAreas).toContain('value')
  })

  test('defaults to undetermined for vague query', () => {
    const intent = parseNaturalLanguageQuery('Show me houses')
    const persona = inferBuyerPersona(intent)
    
    expect(persona.persona).toBe('undetermined')
    expect(persona.tone).toBe('warm')
    expect(persona.confidence).toBeLessThan(0.6)
  })

  test('boosts confidence with high health score', () => {
    const intent = parseNaturalLanguageQuery('3 bed house under $400k')
    const personaLowHealth = inferBuyerPersona(intent, { health_score: 20 })
    const personaHighHealth = inferBuyerPersona(intent, { health_score: 85 })
    
    expect(personaHighHealth.confidence).toBeGreaterThan(personaLowHealth.confidence)
  })

  test('includes indicators for transparency', () => {
    const intent = parseNaturalLanguageQuery('First home for my family under $350k')
    const persona = inferBuyerPersona(intent)
    
    expect(persona.indicators.length).toBeGreaterThan(0)
    expect(persona.indicators.some(i => i.includes('first-time'))).toBe(true)
  })

  test('handles multi-signal persona (investor + relocation)', () => {
    const intent = parseNaturalLanguageQuery('Relocating to Austin, looking for investment rental property')
    const persona = inferBuyerPersona(intent)
    
    // Should pick the stronger signal (investor has higher score in this case)
    expect(['investor', 'relocation']).toContain(persona.persona)
  })

  test('family lifestyle influences first-time buyer detection', () => {
    const intent = parseNaturalLanguageQuery('Need family home near good schools, 3 bed under $300k')
    const persona = inferBuyerPersona(intent)
    
    expect(persona.persona).toBe('first_time_buyer')
    expect(persona.focusAreas).toContain('schools')
  })

  test('retirement signals trigger downsizer persona', () => {
    const intent = parseNaturalLanguageQuery('Retirement home, single story, quiet neighborhood')
    const persona = inferBuyerPersona(intent)
    
    expect(persona.persona).toBe('downsizer')
    expect(persona.focusAreas).toContain('community')
  })

  test('multiple property types with investor language', () => {
    const intent = parseNaturalLanguageQuery('Multi-family or duplex for rental income')
    const persona = inferBuyerPersona(intent)
    
    expect(persona.persona).toBe('investor')
    expect(persona.tone).toBe('analytical')
  })
})

describe('getPersonaMessagingGuidelines', () => {
  test('first-time buyer guidelines emphasize education', () => {
    const guidelines = getPersonaMessagingGuidelines('first_time_buyer')
    
    expect(guidelines.greetingStyle).toContain('educational')
    expect(guidelines.emphasisOn).toContain('affordability')
    expect(guidelines.avoidMentioning).toContain('complex financial terms')
    expect(guidelines.examplePhrases.length).toBeGreaterThan(0)
  })

  test('investor guidelines emphasize analytics', () => {
    const guidelines = getPersonaMessagingGuidelines('investor')
    
    expect(guidelines.greetingStyle).toContain('analytical')
    expect(guidelines.emphasisOn).toContain('cap rate')
    expect(guidelines.emphasisOn).toContain('ROI')
    expect(guidelines.avoidMentioning).toContain('emotional appeal')
  })

  test('relocation guidelines emphasize practicality', () => {
    const guidelines = getPersonaMessagingGuidelines('relocation')
    
    expect(guidelines.emphasisOn).toContain('commute to major employers')
    expect(guidelines.emphasisOn).toContain('move-in ready status')
    expect(guidelines.avoidMentioning).toContain('local insider knowledge')
  })

  test('downsizer guidelines emphasize comfort', () => {
    const guidelines = getPersonaMessagingGuidelines('downsizer')
    
    expect(guidelines.greetingStyle).toContain('warm')
    expect(guidelines.emphasisOn).toContain('low maintenance')
    expect(guidelines.avoidMentioning).toContain('yardwork')
  })

  test('luxury buyer guidelines emphasize exclusivity', () => {
    const guidelines = getPersonaMessagingGuidelines('luxury_buyer')
    
    expect(guidelines.greetingStyle).toContain('Sophisticated')
    expect(guidelines.emphasisOn).toContain('exclusivity')
    expect(guidelines.avoidMentioning).toContain('budget concerns')
  })

  test('move-up buyer guidelines emphasize aspiration', () => {
    const guidelines = getPersonaMessagingGuidelines('move_up_buyer')
    
    expect(guidelines.emphasisOn).toContain('more space')
    expect(guidelines.emphasisOn).toContain('better schools')
    expect(guidelines.avoidMentioning).toContain('starter home language')
  })

  test('bargain hunter guidelines emphasize value', () => {
    const guidelines = getPersonaMessagingGuidelines('bargain_hunter')
    
    expect(guidelines.greetingStyle).toContain('Direct')
    expect(guidelines.emphasisOn).toContain('below-market value')
    expect(guidelines.avoidMentioning).toContain('luxury language')
  })

  test('undetermined guidelines are neutral', () => {
    const guidelines = getPersonaMessagingGuidelines('undetermined')
    
    expect(guidelines.greetingStyle).toContain('neutral')
    expect(guidelines.emphasisOn).toContain('location')
    expect(guidelines.emphasisOn).toContain('features')
  })
})

describe('Persona Edge Cases', () => {
  test('handles conflicting signals gracefully', () => {
    // Query has both first-time and luxury signals
    const intent = parseNaturalLanguageQuery('First home, $2M budget, luxury finishes')
    const persona = inferBuyerPersona(intent)
    
    // Should pick the stronger signal (luxury due to price)
    expect(['first_time_buyer', 'luxury_buyer']).toContain(persona.persona)
    expect(persona.confidence).toBeLessThan(0.9) // Lower confidence due to conflict
  })

  test('handles minimal information', () => {
    const intent = parseNaturalLanguageQuery('house')
    const persona = inferBuyerPersona(intent)
    
    expect(persona.persona).toBe('undetermined')
    expect(persona.indicators).toContain('Insufficient signals for specific persona')
  })

  test('handles investor with family needs', () => {
    const intent = parseNaturalLanguageQuery('Investment rental near good schools')
    const persona = inferBuyerPersona(intent)
    
    // Investor should win
    expect(persona.persona).toBe('investor')
  })

  test('adjusts confidence based on conversation health', () => {
    const intent = parseNaturalLanguageQuery('3 bed house under $400k')
    
    const lowHealthPersona = inferBuyerPersona(intent, { health_score: 15 })
    const highHealthPersona = inferBuyerPersona(intent, { health_score: 85 })
    
    expect(highHealthPersona.confidence).toBeGreaterThan(lowHealthPersona.confidence)
  })

  test('handles negative urgency with bargain hunter', () => {
    const intent = parseNaturalLanguageQuery('Browsing for deals, no rush')
    const persona = inferBuyerPersona(intent)
    
    expect(persona.persona).toBe('bargain_hunter')
    expect(intent.urgency).toBe('low')
  })

  test('single-story feature triggers downsizer check', () => {
    const intent = parseNaturalLanguageQuery('2 bed single story with no stairs')
    const persona = inferBuyerPersona(intent)
    
    expect(persona.persona).toBe('downsizer')
    expect(persona.focusAreas).toContain('accessibility')
  })

  test('handles very high price without luxury keywords', () => {
    const intent = parseNaturalLanguageQuery('House under $1.5M, 4 beds')
    const persona = inferBuyerPersona(intent)
    
    expect(persona.persona).toBe('luxury_buyer')
  })

  test('sentiment affects persona selection', () => {
    const intent = parseNaturalLanguageQuery('Looking for a home')
    
    const neutralSentiment = inferBuyerPersona(intent, { sentiment: 'neutral' })
    const positiveSentiment = inferBuyerPersona(intent, { sentiment: 'positive' })
    
    // Both should be undetermined, but tone might differ
    expect(neutralSentiment.persona).toBe('undetermined')
    expect(positiveSentiment.persona).toBe('undetermined')
  })
})

describe('Persona Confidence Calibration', () => {
  test('high signal count yields high confidence', () => {
    const intent = parseNaturalLanguageQuery(
      'First home buyer, need affordable 3 bed under $280k for my family near schools'
    )
    const persona = inferBuyerPersona(intent)
    
    expect(persona.confidence).toBeGreaterThan(0.75)
  })

  test('low signal count yields lower confidence', () => {
    const intent = parseNaturalLanguageQuery('3 bed house')
    const persona = inferBuyerPersona(intent)
    
    expect(persona.confidence).toBeLessThan(0.6)
  })

  test('conversation context boosts confidence', () => {
    const intent = parseNaturalLanguageQuery('3 bed house')
    const personaNoContext = inferBuyerPersona(intent)
    const personaWithContext = inferBuyerPersona(intent, {
      health_score: 80,
      inferred_intent: 'Looking to upgrade home',
    })
    
    expect(personaWithContext.confidence).toBeGreaterThan(personaNoContext.confidence)
  })

  test('confidence never exceeds 1.0', () => {
    const intent = parseNaturalLanguageQuery(
      'First time home buyer looking for affordable starter home under $250k for my family with kids near excellent schools'
    )
    const persona = inferBuyerPersona(intent, { health_score: 95 })
    
    expect(persona.confidence).toBeLessThanOrEqual(1.0)
  })

  test('confidence never below 0.3', () => {
    const intent = parseNaturalLanguageQuery('house')
    const persona = inferBuyerPersona(intent, { health_score: 5 })
    
    expect(persona.confidence).toBeGreaterThanOrEqual(0.3)
  })
})
