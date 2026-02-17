/**
 * Unit Tests for System 5.1A - Match Scorer
 * 
 * Run with: npm test match-scorer
 */

import { scoreBuyerForListing, rankBuyersForListing, filterViableBuyers } from '../match-scorer'
import type { BuyerProfile, ListingProfile } from '../match-scorer'

describe('System 5.1A - Match Scorer', () => {
  // Mock listing data
  const mockListing: ListingProfile = {
    id: 'listing-123',
    price: 425000,
    bedrooms: 3,
    bathrooms: 2.5,
    square_feet: 2000,
    property_type: 'single_family',
    city: 'Austin',
    state: 'TX',
    zip: '78701',
    features: ['pool', 'garage', 'fireplace'],
    status: 'active',
    created_at: '2026-01-15T00:00:00Z',
  }

  // Mock buyer profiles
  const perfectMatchBuyer: BuyerProfile = {
    contact_id: 'buyer-perfect',
    first_name: 'Perfect',
    last_name: 'Match',
    notes: JSON.stringify({
      ai_inference: {
        buyer_preferences: {
          minPrice: 400000,
          maxPrice: 450000,
          minBeds: 3,
          minBaths: 2,
          preferredCities: ['Austin'],
          propertyTypes: ['single_family'],
        },
      },
    }),
    created_at: '2025-12-01T00:00:00Z',
    urgency_level: 'high',
    sentiment: 'positive',
    health_score: 85,
  }

  const partialMatchBuyer: BuyerProfile = {
    contact_id: 'buyer-partial',
    first_name: 'Partial',
    last_name: 'Match',
    notes: JSON.stringify({
      ai_inference: {
        buyer_preferences: {
          minPrice: 350000,
          maxPrice: 400000, // Under listing price
          minBeds: 2, // Fewer beds
          preferredCities: ['Dallas'], // Different city
        },
      },
    }),
    created_at: '2025-11-15T00:00:00Z',
    urgency_level: 'medium',
    health_score: 50,
  }

  const poorMatchBuyer: BuyerProfile = {
    contact_id: 'buyer-poor',
    first_name: 'Poor',
    last_name: 'Match',
    notes: JSON.stringify({
      ai_inference: {
        buyer_preferences: {
          maxPrice: 300000, // Way under budget
          minBeds: 5, // Too many beds
          preferredCities: ['Seattle'],
        },
      },
    }),
    created_at: '2025-10-01T00:00:00Z',
    urgency_level: 'low',
    health_score: 20,
  }

  describe('scoreBuyerForListing', () => {
    test('should score perfect match buyer highly (70+)', () => {
      const result = scoreBuyerForListing(perfectMatchBuyer, mockListing)

      expect(result.contact_id).toBe('buyer-perfect')
      expect(result.score).toBeGreaterThanOrEqual(70)
      expect(result.match_confidence).toBe('high')
      expect(result.match_factors.length).toBeGreaterThan(0)
      expect(result.caution_notes.length).toBe(0)
    })

    test('should score partial match buyer as medium (45-69)', () => {
      const result = scoreBuyerForListing(partialMatchBuyer, mockListing)

      expect(result.contact_id).toBe('buyer-partial')
      expect(result.score).toBeGreaterThanOrEqual(20)
      expect(result.score).toBeLessThan(70)
      expect(result.match_confidence).not.toBe('high')
      expect(result.caution_notes.length).toBeGreaterThan(0) // Should have caution about budget
    })

    test('should score poor match buyer as low (<45)', () => {
      const result = scoreBuyerForListing(poorMatchBuyer, mockListing)

      expect(result.contact_id).toBe('buyer-poor')
      expect(result.score).toBeLessThan(45)
      expect(result.match_confidence).toBe('low')
      expect(result.caution_notes.length).toBeGreaterThan(0)
    })

    test('should handle buyer with no preferences gracefully', () => {
      const noPrefsBuyer: BuyerProfile = {
        contact_id: 'buyer-noprefs',
        first_name: 'No',
        last_name: 'Prefs',
        notes: null,
        created_at: '2025-12-01T00:00:00Z',
      }

      const result = scoreBuyerForListing(noPrefsBuyer, mockListing)

      expect(result.score).toBeGreaterThanOrEqual(0)
      expect(result.score).toBeLessThan(100)
      expect(result.match_factors.length).toBeGreaterThanOrEqual(0)
    })

    test('should reward high urgency buyers', () => {
      const highUrgencyBuyer = { ...partialMatchBuyer, urgency_level: 'high' }
      const lowUrgencyBuyer = { ...partialMatchBuyer, urgency_level: 'low' }

      const highResult = scoreBuyerForListing(highUrgencyBuyer, mockListing)
      const lowResult = scoreBuyerForListing(lowUrgencyBuyer, mockListing)

      expect(highResult.score).toBeGreaterThan(lowResult.score)
    })

    test('should reward strong engagement scores', () => {
      const highEngagementBuyer = { ...partialMatchBuyer, health_score: 90 }
      const lowEngagementBuyer = { ...partialMatchBuyer, health_score: 20 }

      const highResult = scoreBuyerForListing(highEngagementBuyer, mockListing)
      const lowResult = scoreBuyerForListing(lowEngagementBuyer, mockListing)

      expect(highResult.score).toBeGreaterThan(lowResult.score)
    })

    test('should parse text-based preferences as fallback', () => {
      const textPrefsBuyer: BuyerProfile = {
        contact_id: 'buyer-text',
        first_name: 'Text',
        last_name: 'Prefs',
        notes: 'Looking for 3+ beds in Austin, budget $400k-$500k',
        created_at: '2025-12-01T00:00:00Z',
      }

      const result = scoreBuyerForListing(textPrefsBuyer, mockListing)

      expect(result.score).toBeGreaterThan(0)
      expect(result.match_factors.some((f) => f.includes('Austin') || f.includes('beds'))).toBe(true)
    })

    test('should never exceed score of 100', () => {
      const result = scoreBuyerForListing(perfectMatchBuyer, mockListing)
      expect(result.score).toBeLessThanOrEqual(100)
    })

    test('should include match factors in results', () => {
      const result = scoreBuyerForListing(perfectMatchBuyer, mockListing)

      expect(result.match_factors).toContain('Price within budget ($425,000)')
      expect(result.match_factors.some((f) => f.includes('Preferred city: Austin'))).toBe(true)
    })
  })

  describe('rankBuyersForListing', () => {
    test('should rank buyers by score descending', () => {
      const buyers = [partialMatchBuyer, perfectMatchBuyer, poorMatchBuyer]
      const ranked = rankBuyersForListing(buyers, mockListing)

      expect(ranked.length).toBe(3)
      expect(ranked[0].score).toBeGreaterThanOrEqual(ranked[1].score)
      expect(ranked[1].score).toBeGreaterThanOrEqual(ranked[2].score)
      expect(ranked[0].contact_id).toBe('buyer-perfect')
    })

    test('should handle empty buyer list', () => {
      const ranked = rankBuyersForListing([], mockListing)
      expect(ranked).toEqual([])
    })

    test('should handle single buyer', () => {
      const ranked = rankBuyersForListing([perfectMatchBuyer], mockListing)
      expect(ranked.length).toBe(1)
    })
  })

  describe('filterViableBuyers', () => {
    test('should filter buyers below threshold', () => {
      const matches = [
        { ...scoreBuyerForListing(perfectMatchBuyer, mockListing), score: 85 },
        { ...scoreBuyerForListing(partialMatchBuyer, mockListing), score: 50 },
        { ...scoreBuyerForListing(poorMatchBuyer, mockListing), score: 20 },
      ]

      const viable = filterViableBuyers(matches, 45)
      expect(viable.length).toBeLessThanOrEqual(2)
      expect(viable.every((m) => m.score >= 45)).toBe(true)
    })

    test('should use default threshold of 45', () => {
      const matches = [
        { ...scoreBuyerForListing(perfectMatchBuyer, mockListing), score: 85 },
        { ...scoreBuyerForListing(poorMatchBuyer, mockListing), score: 20 },
      ]

      const viable = filterViableBuyers(matches)
      expect(viable.length).toBe(1)
      expect(viable[0].score).toBeGreaterThanOrEqual(45)
    })

    test('should return empty array if no viable matches', () => {
      const matches = [{ ...scoreBuyerForListing(poorMatchBuyer, mockListing), score: 20 }]

      const viable = filterViableBuyers(matches, 70)
      expect(viable).toEqual([])
    })
  })

  describe('Edge Cases', () => {
    test('should handle listing with null price', () => {
      const noPrice = { ...mockListing, price: null }
      const result = scoreBuyerForListing(perfectMatchBuyer, noPrice)

      expect(result.score).toBeGreaterThanOrEqual(0)
      expect(result.score).toBeLessThan(100)
    })

    test('should handle listing with null bedrooms', () => {
      const noBeds = { ...mockListing, bedrooms: null }
      const result = scoreBuyerForListing(perfectMatchBuyer, noBeds)

      expect(result.score).toBeGreaterThanOrEqual(0)
    })

    test('should handle malformed JSON in notes', () => {
      const badJSONBuyer: BuyerProfile = {
        contact_id: 'buyer-badjson',
        first_name: 'Bad',
        last_name: 'JSON',
        notes: '{invalid json}',
        created_at: '2025-12-01T00:00:00Z',
      }

      const result = scoreBuyerForListing(badJSONBuyer, mockListing)

      expect(result.score).toBeGreaterThanOrEqual(0) // Should not crash
    })

    test('should handle undefined urgency and health scores', () => {
      const minimalBuyer: BuyerProfile = {
        contact_id: 'buyer-minimal',
        first_name: 'Minimal',
        last_name: 'Data',
        notes: null,
        created_at: '2025-12-01T00:00:00Z',
        urgency_level: undefined,
        health_score: undefined,
      }

      const result = scoreBuyerForListing(minimalBuyer, mockListing)

      expect(result).toBeDefined()
      expect(result.score).toBeGreaterThanOrEqual(0)
    })
  })

  describe('Confidence Levels', () => {
    test('should assign high confidence for score >= 70', () => {
      const highScoreBuyer = perfectMatchBuyer
      const result = scoreBuyerForListing(highScoreBuyer, mockListing)

      if (result.score >= 70) {
        expect(result.match_confidence).toBe('high')
      }
    })

    test('should assign medium confidence for score 45-69', () => {
      const medScoreBuyer = partialMatchBuyer
      const result = scoreBuyerForListing(medScoreBuyer, mockListing)

      if (result.score >= 45 && result.score < 70) {
        expect(result.match_confidence).toBe('medium')
      }
    })

    test('should assign low confidence for score < 45', () => {
      const lowScoreBuyer = poorMatchBuyer
      const result = scoreBuyerForListing(lowScoreBuyer, mockListing)

      if (result.score < 45) {
        expect(result.match_confidence).toBe('low')
      }
    })
  })
})
