'use server'

/**
 * SYSTEM 5.1B - BUYER-INITIATED SEARCH & SMART MATCH
 * Server actions for buyer-facing natural language property search
 * 
 * CONSTRAINTS:
 * - READ ONLY: listings, contacts, conversations, conversation_insights
 * - WRITE ONLY: activities (signals), contacts.notes (append, optional)
 * - NO schema modifications
 * - Scores are runtime-only, never persisted
 * - Buyer-facing (contact-authenticated or service-mediated)
 */

import { createServiceClient } from '@/lib/supabase/service'
import { isValidUUID } from '@/lib/validations'
import { handleError } from '@/lib/errors'
import { parseNaturalLanguageQuery, mergeIntentWithContext, intentToFilters } from '@/lib/buyer-search/intent-parser'
import { inferBuyerPersona } from '@/lib/buyer-search/persona-inference'
import { generateMatchExplanation } from '@/lib/buyer-search/explanation-generator'
import { logBatchBuyerSearchMatches, appendBuyerSearchPreferences } from '@/lib/buyer-search/search-logger'
import { scoreBuyerForListing } from '@/lib/property-matching/match-scorer'
import type { BuyerProfile, ListingProfile } from '@/lib/property-matching/match-scorer'
import type { ParsedBuyerIntent } from '@/lib/buyer-search/intent-parser'

export interface BuyerSearchResult {
  listing_id: string
  headline: string
  bullets: string[]
  narrative: string
  callToAction: string
  // Listing basics for UI
  price: number | null
  bedrooms: number | null
  bathrooms: number | null
  city: string | null
  state: string | null
  property_type: string | null
  features: string[] | null
  // Internal (not shown to buyer)
  internal_match_score: number
  internal_confidence: 'low' | 'medium' | 'high'
}

/**
 * Main buyer-facing search: Natural language → Smart matches
 * Returns buyer-friendly property recommendations
 * 
 * USAGE: Buyer submits "Looking for 3 bed house under $400k in Austin"
 */
export async function searchPropertiesWithNaturalLanguage(params: {
  contactId: string
  naturalLanguageQuery: string
  options?: {
    limit?: number // Max results (default 20)
    minScore?: number // Internal threshold (default 40)
    logSignals?: boolean // Log to activities (default true)
    includeDebugInfo?: boolean // Include persona/intent in response (default false)
  }
}) {
  const {
    contactId,
    naturalLanguageQuery,
    options = {},
  } = params

  const {
    limit = 20,
    minScore = 40,
    logSignals = true,
    includeDebugInfo = false,
  } = options

  if (!isValidUUID(contactId)) {
    return { success: false, error: 'Invalid contact ID' }
  }

  if (!naturalLanguageQuery || naturalLanguageQuery.trim().length < 5) {
    return { success: false, error: 'Search query too short' }
  }

  try {
    const supabase = createServiceClient()

    console.log('[v0] Buyer search initiated:', contactId, naturalLanguageQuery)

    // 1. PARSE NATURAL LANGUAGE INTENT
    const parsedIntent = parseNaturalLanguageQuery(naturalLanguageQuery)

    // 2. FETCH CONVERSATION CONTEXT (enrich intent)
    const { data: contact } = await supabase
      .from('contacts')
      .select('id, first_name, last_name, notes, created_at')
      .eq('id', contactId)
      .single()

    if (!contact) {
      return { success: false, error: 'Contact not found' }
    }

    const { data: insight } = await supabase
      .from('conversation_insights')
      .select('inferred_intent, urgency_level, overall_sentiment, health_score, updated_at')
      .eq('contact_id', contactId)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    // Extract existing preferences from notes
    let existingPreferences: any = null
    if (contact.notes) {
      try {
        const notesObj = JSON.parse(contact.notes)
        existingPreferences = notesObj.ai_inference?.buyer_preferences || notesObj.ai_inference?.search?.recent_intent
      } catch {
        // Notes not JSON
      }
    }

    // Merge intent with context
    const enrichedIntent = mergeIntentWithContext(parsedIntent, {
      inferred_intent: insight?.inferred_intent,
      urgency_level: insight?.urgency_level,
      existing_preferences: existingPreferences,
    })

    console.log('[v0] Parsed intent:', {
      confidence: enrichedIntent.confidence,
      maxPrice: enrichedIntent.maxPrice,
      minBeds: enrichedIntent.minBeds,
      cities: enrichedIntent.cities,
      ambiguities: enrichedIntent.ambiguities,
    })

    // 3. INFER BUYER PERSONA
    const persona = inferBuyerPersona(enrichedIntent, {
      sentiment: insight?.overall_sentiment,
      inferred_intent: insight?.inferred_intent,
      health_score: insight?.health_score,
    })

    console.log('[v0] Inferred persona:', persona.persona, 'confidence:', persona.confidence)

    // 4. BUILD LISTING QUERY FROM INTENT
    const filters = intentToFilters(enrichedIntent)
    
    let listingsQuery = supabase
      .from('listings')
      .select('id, price, bedrooms, bathrooms, square_feet, property_type, city, state, zip, features, status, created_at')
      .eq('status', 'active')
      .not('deleted_at', 'is', null)

    // Apply filters
    if (filters.priceRange?.max) {
      listingsQuery = listingsQuery.lte('price', filters.priceRange.max)
    }
    if (filters.priceRange?.min) {
      listingsQuery = listingsQuery.gte('price', filters.priceRange.min)
    }
    if (filters.bedrooms?.min) {
      listingsQuery = listingsQuery.gte('bedrooms', filters.bedrooms.min)
    }
    if (filters.bedrooms?.max) {
      listingsQuery = listingsQuery.lte('bedrooms', filters.bedrooms.max)
    }
    if (filters.bathrooms?.min) {
      listingsQuery = listingsQuery.gte('bathrooms', filters.bathrooms.min)
    }
    if (filters.cities && filters.cities.length > 0) {
      listingsQuery = listingsQuery.in('city', filters.cities)
    }
    if (filters.states && filters.states.length > 0) {
      listingsQuery = listingsQuery.in('state', filters.states)
    }
    if (filters.propertyTypes && filters.propertyTypes.length > 0) {
      listingsQuery = listingsQuery.in('property_type', filters.propertyTypes)
    }

    listingsQuery = listingsQuery.order('created_at', { ascending: false }).limit(200) // Cap at 200 for performance

    const { data: listings, error: listingsError } = await listingsQuery

    if (listingsError) {
      return { success: false, error: 'Failed to fetch listings' }
    }

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

    console.log('[v0] Found listings:', listings.length)

    // 5. SCORE EACH LISTING (runtime only)
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

    const scoredListings = listings.map(listing => {
      const matchScore = scoreBuyerForListing(buyerProfile, listing as ListingProfile)
      return {
        listing: listing as ListingProfile,
        matchScore: matchScore.score,
        matchFactors: matchScore.match_factors,
        confidence: matchScore.match_confidence,
      }
    })

    // Filter by min score and sort
    const viableListings = scoredListings
      .filter(s => s.matchScore >= minScore)
      .sort((a, b) => b.matchScore - a.matchScore)
      .slice(0, limit)

    console.log('[v0] Viable listings:', viableListings.length)

    // 6. GENERATE BUYER-FRIENDLY EXPLANATIONS
    const results: BuyerSearchResult[] = viableListings.map(({ listing, matchScore, confidence }) => {
      const explanation = generateMatchExplanation(listing, enrichedIntent, persona, matchScore)

      return {
        listing_id: listing.id,
        headline: explanation.headline,
        bullets: explanation.bullets,
        narrative: explanation.narrative,
        callToAction: explanation.callToAction,
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

    // 7. LOG SEARCH SIGNALS (optional)
    if (logSignals && results.length > 0) {
      const matchSignals = results.map(r => ({
        listingId: r.listing_id,
        matchScore: r.internal_match_score,
        confidenceLevel: r.internal_confidence,
      }))

      await logBatchBuyerSearchMatches(contactId, matchSignals, enrichedIntent, persona)

      // Append preferences to notes (non-authoritative)
      await appendBuyerSearchPreferences(contactId, enrichedIntent, persona)
    }

    // 8. RETURN BUYER-FACING RESULTS
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
    console.error('[v0] Error in searchPropertiesWithNaturalLanguage:', error)
    return handleError(error, 'searchPropertiesWithNaturalLanguage')
  }
}

/**
 * Get single property match explanation for a buyer
 * Useful for "Why did you recommend this?" queries
 */
export async function explainPropertyMatchForBuyer(params: {
  contactId: string
  listingId: string
  context?: string // Optional buyer question like "why this one?"
}) {
  const { contactId, listingId, context } = params

  if (!isValidUUID(contactId) || !isValidUUID(listingId)) {
    return { success: false, error: 'Invalid contact or listing ID' }
  }

  try {
    const supabase = createServiceClient()

    // Fetch listing
    const { data: listing, error: listingError } = await supabase
      .from('listings')
      .select('id, price, bedrooms, bathrooms, square_feet, property_type, city, state, zip, features, status, created_at')
      .eq('id', listingId)
      .single()

    if (listingError || !listing) {
      return { success: false, error: 'Listing not found' }
    }

    // Fetch buyer profile
    const { data: contact, error: contactError } = await supabase
      .from('contacts')
      .select('id, first_name, last_name, notes, created_at')
      .eq('id', contactId)
      .single()

    if (contactError || !contact) {
      return { success: false, error: 'Contact not found' }
    }

    const { data: insight } = await supabase
      .from('conversation_insights')
      .select('inferred_intent, urgency_level, overall_sentiment, health_score')
      .eq('contact_id', contactId)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    // Build buyer profile
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

    // Score the match
    const matchScore = scoreBuyerForListing(buyerProfile, listing as ListingProfile)

    // Infer persona (use minimal intent if no recent search)
    const minimalIntent: ParsedBuyerIntent = {
      rawQuery: context || 'Show me details',
      confidence: 0.5,
    }

    const persona = inferBuyerPersona(minimalIntent, {
      sentiment: insight?.overall_sentiment,
      inferred_intent: insight?.inferred_intent,
      health_score: insight?.health_score,
    })

    // Generate explanation
    const explanation = generateMatchExplanation(listing as ListingProfile, minimalIntent, persona, matchScore.score)

    return {
      success: true,
      explanation: {
        headline: explanation.headline,
        bullets: explanation.bullets,
        narrative: explanation.narrative,
        callToAction: explanation.callToAction,
      },
      listing: {
        id: listing.id,
        price: listing.price,
        bedrooms: listing.bedrooms,
        city: listing.city,
        state: listing.state,
      },
      match_quality: matchScore.match_confidence,
    }
  } catch (error) {
    console.error('[v0] Error in explainPropertyMatchForBuyer:', error)
    return handleError(error, 'explainPropertyMatchForBuyer')
  }
}

/**
 * Preview search without executing
 * Useful for showing buyer what we understood from their query
 */
export async function previewSearchIntent(params: {
  contactId: string
  naturalLanguageQuery: string
}) {
  const { contactId, naturalLanguageQuery } = params

  if (!isValidUUID(contactId)) {
    return { success: false, error: 'Invalid contact ID' }
  }

  try {
    const supabase = createServiceClient()

    // Parse intent
    const parsedIntent = parseNaturalLanguageQuery(naturalLanguageQuery)

    // Fetch conversation context
    const { data: contact } = await supabase
      .from('contacts')
      .select('notes')
      .eq('id', contactId)
      .single()

    const { data: insight } = await supabase
      .from('conversation_insights')
      .select('inferred_intent, urgency_level, health_score')
      .eq('contact_id', contactId)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    let existingPreferences: any = null
    if (contact?.notes) {
      try {
        const notesObj = JSON.parse(contact.notes)
        existingPreferences = notesObj.ai_inference?.buyer_preferences || notesObj.ai_inference?.search?.recent_intent
      } catch {
        // Notes not JSON
      }
    }

    const enrichedIntent = mergeIntentWithContext(parsedIntent, {
      inferred_intent: insight?.inferred_intent,
      urgency_level: insight?.urgency_level,
      existing_preferences: existingPreferences,
    })

    // Infer persona
    const persona = inferBuyerPersona(enrichedIntent, {
      inferred_intent: insight?.inferred_intent,
      health_score: insight?.health_score,
    })

    // Return buyer-friendly preview
    return {
      success: true,
      preview: {
        understood: {
          price_range: enrichedIntent.maxPrice 
            ? `Up to $${(enrichedIntent.maxPrice / 1000).toFixed(0)}K` 
            : 'Not specified',
          bedrooms: enrichedIntent.minBeds ? `${enrichedIntent.minBeds}+ beds` : 'Not specified',
          location: enrichedIntent.cities?.join(', ') || enrichedIntent.states?.join(', ') || 'Not specified',
          property_type: enrichedIntent.propertyTypes?.join(', ') || 'Any type',
          features: enrichedIntent.features?.join(', ') || 'None specified',
        },
        confidence: enrichedIntent.confidence,
        ambiguities: enrichedIntent.ambiguities || [],
        persona_match: persona.persona,
      },
    }
  } catch (error) {
    console.error('[v0] Error in previewSearchIntent:', error)
    return handleError(error, 'previewSearchIntent')
  }
}
