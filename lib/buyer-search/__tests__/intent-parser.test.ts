/**
 * SYSTEM 5.1B - INTENT PARSER TESTS
 * Unit tests for natural language query parsing
 */

import { parseNaturalLanguageQuery, mergeIntentWithContext, intentToFilters } from '../intent-parser'

describe('parseNaturalLanguageQuery', () => {
  test('parses basic price and bedroom query', () => {
    const intent = parseNaturalLanguageQuery('Looking for 3 bedroom house under $400k')
    
    expect(intent.maxPrice).toBe(400000)
    expect(intent.minBeds).toBe(3)
    expect(intent.confidence).toBeGreaterThan(0.4)
  })

  test('parses price range', () => {
    const intent = parseNaturalLanguageQuery('Budget between $300k-$450k')
    
    expect(intent.minPrice).toBe(300000)
    expect(intent.maxPrice).toBe(450000)
  })

  test('parses location with city', () => {
    const intent = parseNaturalLanguageQuery('House in Austin with pool')
    
    expect(intent.cities).toContain('Austin')
    expect(intent.features).toContain('pool')
  })

  test('parses multiple features', () => {
    const intent = parseNaturalLanguageQuery('Need pool, garage, and backyard')
    
    expect(intent.features).toContain('pool')
    expect(intent.features).toContain('garage')
    expect(intent.features).toContain('backyard')
  })

  test('detects high urgency signals', () => {
    const intent = parseNaturalLanguageQuery('Need a house asap')
    
    expect(intent.urgency).toBe('high')
  })

  test('detects low urgency signals', () => {
    const intent = parseNaturalLanguageQuery('Just browsing and exploring options')
    
    expect(intent.urgency).toBe('low')
  })

  test('detects family lifestyle', () => {
    const intent = parseNaturalLanguageQuery('Looking for family home near good schools')
    
    expect(intent.lifestyle).toBe('family')
  })

  test('detects investor lifestyle', () => {
    const intent = parseNaturalLanguageQuery('Investment property with good cash flow')
    
    expect(intent.lifestyle).toBe('investor')
  })

  test('parses property type', () => {
    const intent = parseNaturalLanguageQuery('3 bed condo under $300k')
    
    expect(intent.propertyTypes).toContain('condo')
    expect(intent.minBeds).toBe(3)
    expect(intent.maxPrice).toBe(300000)
  })

  test('handles bathroom decimals', () => {
    const intent = parseNaturalLanguageQuery('At least 2.5 bathrooms')
    
    expect(intent.minBaths).toBe(2.5)
  })

  test('flags ambiguities when price missing', () => {
    const intent = parseNaturalLanguageQuery('3 bedroom house in Austin')
    
    expect(intent.ambiguities).toContain('No price range specified')
  })

  test('flags ambiguities when location missing', () => {
    const intent = parseNaturalLanguageQuery('3 bed under $400k')
    
    expect(intent.ambiguities).toContain('No location specified')
  })

  test('calculates high confidence for complete query', () => {
    const intent = parseNaturalLanguageQuery(
      'Looking for 3-4 bedroom house under $450k in Austin with pool and garage'
    )
    
    expect(intent.confidence).toBeGreaterThan(0.7)
    expect(intent.minBeds).toBe(3)
    expect(intent.maxBeds).toBe(4)
    expect(intent.maxPrice).toBe(450000)
    expect(intent.cities).toContain('Austin')
    expect(intent.features).toContain('pool')
    expect(intent.features).toContain('garage')
  })

  test('handles various price formats', () => {
    const queries = [
      { query: 'under $400,000', expected: 400000 },
      { query: 'below 500k', expected: 500000 },
      { query: 'max $450k', expected: 450000 },
      { query: 'budget of 350000', expected: 350000 },
    ]

    queries.forEach(({ query, expected }) => {
      const intent = parseNaturalLanguageQuery(query)
      expect(intent.maxPrice).toBe(expected)
    })
  })

  test('handles bedroom plus notation', () => {
    const intent = parseNaturalLanguageQuery('4+ bedrooms')
    
    expect(intent.minBeds).toBe(4)
    expect(intent.maxBeds).toBeUndefined()
  })

  test('detects state abbreviations', () => {
    const intent = parseNaturalLanguageQuery('House in TX under $400k')
    
    expect(intent.states).toContain('TX')
  })

  test('detects must-haves vs nice-to-haves', () => {
    const intent = parseNaturalLanguageQuery(
      'Must have a garage and would like a pool'
    )
    
    expect(intent.mustHaves).toBeDefined()
    expect(intent.niceToHaves).toBeDefined()
  })

  test('handles complex multi-constraint query', () => {
    const intent = parseNaturalLanguageQuery(
      'First time buyer looking for 3 bedroom single family house under $400k in Austin or Dallas with pool, garage, and updated kitchen. Need ASAP.'
    )
    
    expect(intent.maxPrice).toBe(400000)
    expect(intent.minBeds).toBe(3)
    expect(intent.cities).toContain('Austin')
    expect(intent.cities).toContain('Dallas')
    expect(intent.propertyTypes).toContain('single_family')
    expect(intent.features?.length).toBeGreaterThan(2)
    expect(intent.urgency).toBe('high')
    expect(intent.confidence).toBeGreaterThan(0.8)
  })
})

describe('mergeIntentWithContext', () => {
  test('fills missing price from conversation context', () => {
    const parsedIntent = parseNaturalLanguageQuery('3 bedroom house in Austin')
    
    const merged = mergeIntentWithContext(parsedIntent, {
      existing_preferences: {
        maxPrice: 400000,
      },
    })
    
    expect(merged.maxPrice).toBe(400000)
    expect(merged.ambiguities).not.toContain('No price range specified')
  })

  test('uses conversation urgency if not in query', () => {
    const parsedIntent = parseNaturalLanguageQuery('3 bed under $400k')
    
    const merged = mergeIntentWithContext(parsedIntent, {
      urgency_level: 'high',
    })
    
    expect(merged.urgency).toBe('high')
  })

  test('prioritizes query over context', () => {
    const parsedIntent = parseNaturalLanguageQuery('4 bed under $500k')
    
    const merged = mergeIntentWithContext(parsedIntent, {
      existing_preferences: {
        minBeds: 3,
        maxPrice: 400000,
      },
    })
    
    // Query takes precedence
    expect(merged.minBeds).toBe(4)
    expect(merged.maxPrice).toBe(500000)
  })

  test('boosts confidence when context fills gaps', () => {
    const parsedIntent = parseNaturalLanguageQuery('3 bed house')
    const originalConfidence = parsedIntent.confidence
    
    const merged = mergeIntentWithContext(parsedIntent, {
      existing_preferences: {
        maxPrice: 400000,
        preferredCities: ['Austin'],
      },
    })
    
    expect(merged.confidence).toBeGreaterThan(originalConfidence)
    expect(merged.maxPrice).toBe(400000)
    expect(merged.cities).toContain('Austin')
  })

  test('handles missing context gracefully', () => {
    const parsedIntent = parseNaturalLanguageQuery('3 bed under $400k')
    
    const merged = mergeIntentWithContext(parsedIntent)
    
    expect(merged.minBeds).toBe(3)
    expect(merged.maxPrice).toBe(400000)
  })
})

describe('intentToFilters', () => {
  test('converts intent to SQL-compatible filters', () => {
    const intent = parseNaturalLanguageQuery('3-4 bed house under $400k in Austin')
    
    const filters = intentToFilters(intent)
    
    expect(filters.priceRange).toEqual({ min: undefined, max: 400000 })
    expect(filters.bedrooms).toEqual({ min: 3, max: 4 })
    expect(filters.cities).toContain('Austin')
    expect(filters.propertyTypes).toContain('single_family')
  })

  test('handles missing optional fields', () => {
    const intent = parseNaturalLanguageQuery('house under $300k')
    
    const filters = intentToFilters(intent)
    
    expect(filters.priceRange).toEqual({ min: undefined, max: 300000 })
    expect(filters.bedrooms).toBeUndefined()
    expect(filters.cities).toBeUndefined()
  })

  test('includes all parsed features', () => {
    const intent = parseNaturalLanguageQuery('House with pool, garage, and fireplace')
    
    const filters = intentToFilters(intent)
    
    expect(filters.features).toContain('pool')
    expect(filters.features).toContain('garage')
    expect(filters.features).toContain('fireplace')
  })

  test('handles bathroom minimum', () => {
    const intent = parseNaturalLanguageQuery('At least 2.5 baths')
    
    const filters = intentToFilters(intent)
    
    expect(filters.bathrooms).toEqual({ min: 2.5 })
  })

  test('handles multiple property types', () => {
    const intent = parseNaturalLanguageQuery('Condo or townhouse under $300k')
    
    const filters = intentToFilters(intent)
    
    expect(filters.propertyTypes).toContain('condo')
    expect(filters.propertyTypes).toContain('townhouse')
  })

  test('handles multiple cities', () => {
    const intent = parseNaturalLanguageQuery('House in Austin, Dallas, or Houston')
    
    const filters = intentToFilters(intent)
    
    expect(filters.cities).toContain('Austin')
    expect(filters.cities).toContain('Dallas')
    expect(filters.cities).toContain('Houston')
  })
})

describe('Edge Cases', () => {
  test('handles empty query', () => {
    const intent = parseNaturalLanguageQuery('')
    
    expect(intent.confidence).toBeLessThan(0.3)
    expect(intent.ambiguities?.length).toBeGreaterThan(0)
  })

  test('handles very short query', () => {
    const intent = parseNaturalLanguageQuery('house')
    
    expect(intent.confidence).toBeLessThan(0.3)
  })

  test('handles query with typos', () => {
    // Should still extract key information
    const intent = parseNaturalLanguageQuery('3 bedrom hous undr $400k in Austn')
    
    expect(intent.minBeds).toBe(3)
    expect(intent.maxPrice).toBe(400000)
    expect(intent.cities).toContain('Austin') // City should still match
  })

  test('handles query with all caps', () => {
    const intent = parseNaturalLanguageQuery('3 BED HOUSE UNDER $400K IN AUSTIN')
    
    expect(intent.minBeds).toBe(3)
    expect(intent.maxPrice).toBe(400000)
    expect(intent.cities).toContain('Austin')
  })

  test('handles query with special characters', () => {
    const intent = parseNaturalLanguageQuery('3-bed, $400k max, Austin area!!!')
    
    expect(intent.minBeds).toBe(3)
    expect(intent.maxPrice).toBe(400000)
  })

  test('handles unrealistic constraints', () => {
    const intent = parseNaturalLanguageQuery('5 bed mansion under $100k in Manhattan')
    
    expect(intent.minBeds).toBe(5)
    expect(intent.maxPrice).toBe(100000)
    // Should parse without crashing, even if unrealistic
  })

  test('handles ambiguous location', () => {
    const intent = parseNaturalLanguageQuery('House near downtown')
    
    // Should flag as ambiguous
    expect(intent.ambiguities).toContain('No location specified')
  })

  test('handles relative price terms', () => {
    const intent = parseNaturalLanguageQuery('Something affordable around $350k')
    
    expect(intent.maxPrice).toBe(350000)
  })
})
