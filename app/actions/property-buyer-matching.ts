'use server'

/**
 * SYSTEM 5.1A - PROPERTY → BUYER SMART MATCH ENGINE
 * Server actions for internal listing-to-buyer matching
 * 
 * CONSTRAINTS:
 * - READ ONLY: listings, contacts, conversations, conversation_insights
 * - WRITE ONLY: activities (signals), contacts.notes (append, optional)
 * - NO schema modifications
 * - Scores are runtime-only, never persisted
 * - Internal use only (agent/broker/team leader)
 */

import { createServiceClient } from '@/lib/supabase/service'
import { isValidUUID } from '@/lib/validations'
import { handleError } from '@/lib/errors'
import {
  scoreBuyerForListing,
  rankBuyersForListing,
  filterViableBuyers,
  logBuyerMatchSignal,
  logBatchMatchSignals,
  type BuyerProfile,
  type ListingProfile,
  type MatchScore,
} from '@/lib/property-matching'

/**
 * Run smart matching for a listing
 * Returns ranked list of potential buyers with match scores
 * 
 * USAGE: Agent lists a new property, system suggests best-fit buyers
 */
export async function matchBuyersForListing(params: {
  listingId: string
  minScore?: number // Default 45 (medium confidence threshold)
  limit?: number // Max results to return
  logSignals?: boolean // Whether to log to activities
}) {
  const { listingId, minScore = 45, limit = 50, logSignals = true } = params

  if (!isValidUUID(listingId)) {
    return { success: false, error: 'Invalid listing ID' }
  }

  try {
    const supabase = createServiceClient()

    console.log('[v0] Running buyer match for listing:', listingId)

    // 1. Fetch listing data
    const { data: listing, error: listingError } = await supabase
      .from('listings')
      .select('id, price:list_price, bedrooms, bathrooms, square_feet:sqft, property_type, city, state, zip, status, created_at')
      .eq('id', listingId)
      .single()

    if (listingError || !listing) {
      return { success: false, error: 'Listing not found' }
    }

    if (listing.status !== 'active') {
      return { success: false, error: 'Listing is not active', status: listing.status }
    }

    // 2. Fetch eligible buyer contacts
    // Filter: type = buyer or lead, status active/qualified
    const { data: contacts, error: contactsError } = await supabase
      .from('contacts')
      .select('id, first_name, last_name, notes, created_at, contact_type, status')
      .in('contact_type', ['buyer', 'lead'])
      .in('status', ['active', 'qualified', 'nurture'])
      .not('deleted_at', 'is', null)
      .order('created_at', { ascending: false })
      .limit(500) // Cap at 500 buyers for performance

    if (contactsError) {
      return { success: false, error: 'Failed to fetch contacts' }
    }

    if (!contacts || contacts.length === 0) {
      return { success: true, matches: [], message: 'No eligible buyers found' }
    }

    // 3. Enrich buyer profiles with conversation insights
    const contactIds = contacts.map((c) => c.id)
    const { data: insights } = await supabase
      .from('conversation_insights')
      .select('contact_id, inferred_intent:context_summary, urgency_level:escalation_urgency, overall_sentiment, health_score, updated_at')
      .in('contact_id', contactIds)

    const insightsMap = new Map(insights?.map((i) => [i.contact_id, i]) || [])

    const buyerProfiles: BuyerProfile[] = contacts.map((c) => {
      const insight = insightsMap.get(c.id)
      return {
        contact_id: c.id,
        first_name: c.first_name || 'Unknown',
        last_name: c.last_name || '',
        notes: c.notes,
        created_at: c.created_at,
        inferred_intent: insight?.inferred_intent,
        urgency_level: insight?.urgency_level,
        sentiment: insight?.overall_sentiment,
        health_score: insight?.health_score,
        updated_at: insight?.updated_at,
      }
    })

    // 4. Score and rank buyers
    const allMatches = rankBuyersForListing(buyerProfiles, listing as ListingProfile)
    const viableMatches = filterViableBuyers(allMatches, minScore)

    // 5. Limit results
    const topMatches = viableMatches.slice(0, limit)

    console.log('[v0] Match results:', {
      totalBuyers: buyerProfiles.length,
      viableMatches: viableMatches.length,
      topMatches: topMatches.length,
    })

    // 6. Log signals to activities (optional)
    if (logSignals && topMatches.length > 0) {
      await logBatchMatchSignals(listingId, topMatches)
    }

    return {
      success: true,
      matches: topMatches.map((m) => ({
        contact_id: m.contact_id,
        match_confidence: m.match_confidence,
        score: m.score,
        match_factors: m.match_factors,
        caution_notes: m.caution_notes,
        // Enrich with contact details for UI
        buyer_name: buyerProfiles.find((b) => b.contact_id === m.contact_id)?.first_name || 'Unknown',
      })),
      metadata: {
        listing_id: listingId,
        total_buyers_evaluated: buyerProfiles.length,
        viable_matches: viableMatches.length,
        min_score_threshold: minScore,
      },
    }
  } catch (error) {
    console.error('[v0] Error in matchBuyersForListing:', error)
    return handleError(error, 'matchBuyersForListing')
  }
}

/**
 * Score a specific buyer against a specific listing
 * Useful for on-demand "How well does this buyer match this listing?" queries
 */
export async function scoreSingleBuyerForListing(params: {
  listingId: string
  contactId: string
  logSignal?: boolean
}) {
  const { listingId, contactId, logSignal = false } = params

  if (!isValidUUID(listingId) || !isValidUUID(contactId)) {
    return { success: false, error: 'Invalid listing or contact ID' }
  }

  try {
    const supabase = createServiceClient()

    console.log('[v0] Scoring single buyer:', contactId, 'for listing:', listingId)

    // Fetch listing
    const { data: listing, error: listingError } = await supabase
      .from('listings')
      .select('id, price:list_price, bedrooms, bathrooms, square_feet:sqft, property_type, city, state, zip, status, created_at')
      .eq('id', listingId)
      .single()

    if (listingError || !listing) {
      return { success: false, error: 'Listing not found' }
    }

    // Fetch buyer contact
    const { data: contact, error: contactError } = await supabase
      .from('contacts')
      .select('id, first_name, last_name, notes, created_at')
      .eq('id', contactId)
      .single()

    if (contactError || !contact) {
      return { success: false, error: 'Contact not found' }
    }

    // Fetch conversation insights
    const { data: insight } = await supabase
      .from('conversation_insights')
      .select('inferred_intent:context_summary, urgency_level:escalation_urgency, overall_sentiment, health_score, updated_at')
      .eq('contact_id', contactId)
      .order('updated_at', { ascending: false })
      .limit(1)
      .single()

    const buyer: BuyerProfile = {
      contact_id: contact.id,
      first_name: contact.first_name || 'Unknown',
      last_name: contact.last_name || '',
      notes: contact.notes,
      created_at: contact.created_at,
      inferred_intent: insight?.inferred_intent,
      urgency_level: insight?.urgency_level,
      sentiment: insight?.overall_sentiment,
      health_score: insight?.health_score,
      updated_at: insight?.updated_at,
    }

    // Score the match
    const match = scoreBuyerForListing(buyer, listing as ListingProfile)

    // Log signal if requested
    if (logSignal) {
      await logBuyerMatchSignal(listingId, match)
    }

    return {
      success: true,
      match: {
        ...match,
        buyer_name: `${buyer.first_name} ${buyer.last_name}`.trim(),
        listing_address: `${listing.city}, ${listing.state}`,
      },
    }
  } catch (error) {
    console.error('[v0] Error in scoreSingleBuyerForListing:', error)
    return handleError(error, 'scoreSingleBuyerForListing')
  }
}

/**
 * Get recent match signals for a listing (from activities log)
 * Useful for viewing past matching results
 */
export async function getListingMatchHistory(params: {
  listingId: string
  limit?: number
}) {
  const { listingId, limit = 50 } = params

  if (!isValidUUID(listingId)) {
    return { success: false, error: 'Invalid listing ID' }
  }

  try {
    const supabase = createServiceClient()

    const { data: activities, error } = await supabase
      .from('activities')
      .select('id, title, description, notes, created_at')
      .eq('entity_type', 'listing')
      .eq('entity_id', listingId)
      .eq('activity_type', 'buyer_match_signal')
      .order('created_at', { ascending: false })
      .limit(limit)

    if (error) {
      return { success: false, error: error.message }
    }

    const signals = activities?.map((a) => {
      let payload = null
      try {
        payload = JSON.parse(a.notes || '{}')
      } catch {
        payload = {}
      }

      return {
        signal_id: a.id,
        contact_id: payload.contact_id,
        match_confidence: payload.match_confidence,
        match_score: payload.match_score,
        top_factors: payload.top_factors || [],
        caution_notes: payload.caution_notes || [],
        generated_at: payload.generated_at || a.created_at,
      }
    })

    return {
      success: true,
      signals: signals || [],
      metadata: {
        listing_id: listingId,
        total_signals: signals?.length || 0,
      },
    }
  } catch (error) {
    console.error('[v0] Error in getListingMatchHistory:', error)
    return handleError(error, 'getListingMatchHistory')
  }
}
