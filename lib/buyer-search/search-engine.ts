/**
 * SYSTEM 5.1B: BUYER SEARCH ENGINE — LIB LAYER
 *
 * Pure domain logic for natural-language property search.
 * No "use server" directive — this is a lib module callable from
 * both server actions and other lib modules (e.g. voice-assistant).
 *
 * Dependency direction: lib/buyer-search → lib/property-matching → lib/external
 * The action layer (app/actions/buyer-property-search.ts) re-exports from here.
 */

import { createServiceClient } from '@/lib/supabase/service'
import { isValidUUID } from '@/lib/validations'
import { handleError } from '@/lib/errors'
import { parseNaturalLanguageQuery, mergeIntentWithContext, intentToFilters } from './intent-parser'
import { inferBuyerPersona } from './persona-inference'
import { generateMatchExplanation } from './explanation-generator'
import { logBatchBuyerSearchMatches, appendBuyerSearchPreferences } from './search-logger'
import { scoreBuyerForListing } from '@/lib/property-matching/match-scorer'
import type { BuyerProfile, ListingProfile } from '@/lib/property-matching/match-scorer'
import type { ParsedBuyerIntent } from './intent-parser'

// ─── TYPES ────────────────────────────────────────────────────────────────────

export interface BuyerSearchResult {
  listing_id: string
  headline: string
  bullets: string[]
  narrative: string
  callToAction: string
  price: number | null
  bedrooms: number | null
  bathrooms: number | null
  city: string | null
  state: string | null
  property_type: string | null
  features: string[] | null
  internal_match_score: number
  internal_confidence: 'low' | 'medium' | 'high'
}

export interface BuyerSearchParams {
  contactId: string
  naturalLanguageQuery: string
  options?: {
    limit?: number
    minScore?: number
    logSignals?: boolean
    includeDebugInfo?: boolean
  }
}

// ─── CORE SEARCH (lib-level, no "use server") ─────────────────────────────────

/**
 * Natural language → scored property matches.
 * Used by:
 *   - app/actions/buyer-property-search.ts  (action wrapper, adds "use server")
 *   - lib/buyer-execution/voice-assistant-integration.ts  (voice path, lib→lib)
 */
export async function searchPropertiesCore(params: BuyerSearchParams) {
  const { contactId, naturalLanguageQuery, options = {} } = params
  const { limit = 20, minScore = 40, logSignals = true, includeDebugInfo = false } = options

  if (!isValidUUID(contactId)) return { success: false, error: 'Invalid contact ID' }
  if (!naturalLanguageQuery || naturalLanguageQuery.trim().length < 5) {
    return { success: false, error: 'Search query too short' }
  }

  try {
    const supabase = createServiceClient()

    // 1. Parse NL intent
    const parsedIntent = parseNaturalLanguageQuery(naturalLanguageQuery)

    // 2. Fetch contact + conversation context
    const { data: contact } = await supabase
      .from('contacts')
      .select('id, first_name, last_name, notes, created_at')
      .eq('id', contactId)
      .single()

    if (!contact) return { success: false, error: 'Contact not found' }

    const { data: insight } = await supabase
      .from('conversation_insights')
      .select('inferred_intent, urgency_level, overall_sentiment, health_score, updated_at')
      .eq('contact_id', contactId)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    let existingPreferences: any = null
    if (contact.notes) {
      try {
        const n = JSON.parse(contact.notes)
        existingPreferences = n.ai_inference?.buyer_preferences || n.ai_inference?.search?.recent_intent
      } catch { /* non-JSON notes */ }
    }

    const enrichedIntent = mergeIntentWithContext(parsedIntent, {
      inferred_intent: insight?.inferred_intent,
      urgency_level: insight?.urgency_level,
      existing_preferences: existingPreferences,
    })

    // 3. Persona
    const persona = inferBuyerPersona(enrichedIntent, {
      sentiment: insight?.overall_sentiment,
      inferred_intent: insight?.inferred_intent,
      health_score: insight?.health_score,
    })

    // 4. Query listings
    const filters = intentToFilters(enrichedIntent)
    let q = supabase
      .from('listings')
      .select('id, price, bedrooms, bathrooms, square_feet, property_type, city, state, zip, features, status, created_at')
      .eq('status', 'active')
      .not('deleted_at', 'is', null)

    if (filters.priceRange?.max) q = q.lte('price', filters.priceRange.max)
    if (filters.priceRange?.min) q = q.gte('price', filters.priceRange.min)
    if (filters.bedrooms?.min)   q = q.gte('bedrooms', filters.bedrooms.min)
    if (filters.bedrooms?.max)   q = q.lte('bedrooms', filters.bedrooms.max)
    if (filters.bathrooms?.min)  q = q.gte('bathrooms', filters.bathrooms.min)
    if (filters.cities?.length)  q = q.in('city', filters.cities)
    if (filters.states?.length)  q = q.in('state', filters.states)
    if (filters.propertyTypes?.length) q = q.in('property_type', filters.propertyTypes)

    const { data: listings, error: listingsError } = await q
      .order('created_at', { ascending: false })
      .limit(200)

    if (listingsError) return { success: false, error: 'Failed to fetch listings' }

    if (!listings || listings.length === 0) {
      return {
        success: true,
        results: [],
        message: 'No properties found matching your criteria',
        intent_summary: {
          parsed_successfully: true,
          confidence: enrichedIntent.confidence,
          ambiguities: enrichedIntent.ambiguities,
        },
      }
    }

    // 5. Score
    const buyerProfile: BuyerProfile = {
      contact_id: contactId,
      first_name: contact.first_name || 'Buyer',
      last_name: contact.last_name || '',
      notes: contact.notes,
      created_at: contact.created_at,
      inferred_intent: insight?.inferred_intent,
      urgency_level: insight?.urgency_level,
      sentiment: insight?.overall_sentiment,
      health_score: insight?.health_score,
      updated_at: insight?.updated_at,
    }

    const viableListings = listings
      .map(listing => {
        const ms = scoreBuyerForListing(buyerProfile, listing as ListingProfile)
        return { listing: listing as ListingProfile, matchScore: ms.score, confidence: ms.match_confidence }
      })
      .filter(s => s.matchScore >= minScore)
      .sort((a, b) => b.matchScore - a.matchScore)
      .slice(0, limit)

    // 6. Generate buyer-friendly explanations
    const results: BuyerSearchResult[] = viableListings.map(({ listing, matchScore, confidence }) => {
      const exp = generateMatchExplanation(listing, enrichedIntent, persona, matchScore)
      return {
        listing_id: listing.id,
        headline: exp.headline,
        bullets: exp.bullets,
        narrative: exp.narrative,
        callToAction: exp.callToAction,
        price: listing.price,
        bedrooms: listing.bedrooms,
        bathrooms: listing.bathrooms,
        city: listing.city,
        state: listing.state,
        property_type: listing.property_type,
        features: listing.features,
        internal_match_score: matchScore,
        internal_confidence: confidence,
      }
    })

    // 7. Log signals
    if (logSignals && results.length > 0) {
      await logBatchBuyerSearchMatches(
        contactId,
        results.map(r => ({ listingId: r.listing_id, matchScore: r.internal_match_score, confidenceLevel: r.internal_confidence })),
        enrichedIntent,
        persona
      )
      await appendBuyerSearchPreferences(contactId, enrichedIntent, persona)
    }

    return {
      success: true,
      results,
      metadata: {
        total_listings_evaluated: listings.length,
        results_returned: results.length,
        search_confidence: enrichedIntent.confidence,
        ...(includeDebugInfo && {
          debug: {
            persona_detected: persona.persona,
            persona_confidence: persona.confidence,
            parsed_intent: enrichedIntent,
          },
        }),
      },
    }
  } catch (error) {
    console.error('[v0] Error in searchPropertiesCore:', error)
    return handleError(error, 'searchPropertiesCore')
  }
}

/**
 * Explain a single property match for a buyer (lib-level).
 */
export async function explainPropertyMatchCore(params: {
  contactId: string
  listingId: string
  context?: string
}) {
  const { contactId, listingId, context } = params
  if (!isValidUUID(contactId) || !isValidUUID(listingId)) {
    return { success: false, error: 'Invalid contact or listing ID' }
  }

  try {
    const supabase = createServiceClient()

    const [{ data: listing, error: lErr }, { data: contact, error: cErr }] = await Promise.all([
      supabase.from('listings').select('id, price, bedrooms, bathrooms, square_feet, property_type, city, state, zip, features, status, created_at').eq('id', listingId).single(),
      supabase.from('contacts').select('id, first_name, last_name, notes, created_at').eq('id', contactId).single(),
    ])

    if (lErr || !listing) return { success: false, error: 'Listing not found' }
    if (cErr || !contact) return { success: false, error: 'Contact not found' }

    const { data: insight } = await supabase
      .from('conversation_insights')
      .select('inferred_intent, urgency_level, overall_sentiment, health_score')
      .eq('contact_id', contactId)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    const buyerProfile: BuyerProfile = {
      contact_id: contactId,
      first_name: contact.first_name || 'Buyer',
      last_name: contact.last_name || '',
      notes: contact.notes,
      created_at: contact.created_at,
      inferred_intent: insight?.inferred_intent,
      urgency_level: insight?.urgency_level,
      sentiment: insight?.overall_sentiment,
      health_score: insight?.health_score,
    }

    const matchScore = scoreBuyerForListing(buyerProfile, listing as ListingProfile)
    const minimalIntent: ParsedBuyerIntent = { rawQuery: context || 'Show me details', confidence: 0.5 }
    const persona = inferBuyerPersona(minimalIntent, {
      sentiment: insight?.overall_sentiment,
      inferred_intent: insight?.inferred_intent,
      health_score: insight?.health_score,
    })
    const explanation = generateMatchExplanation(listing as ListingProfile, minimalIntent, persona, matchScore.score)

    return {
      success: true,
      explanation: {
        headline: explanation.headline,
        bullets: explanation.bullets,
        narrative: explanation.narrative,
        callToAction: explanation.callToAction,
      },
      listing: { id: listing.id, price: listing.price, bedrooms: listing.bedrooms, city: listing.city, state: listing.state },
      match_quality: matchScore.match_confidence,
    }
  } catch (error) {
    console.error('[v0] Error in explainPropertyMatchCore:', error)
    return handleError(error, 'explainPropertyMatchCore')
  }
}
