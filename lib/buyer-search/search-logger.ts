/**
 * SYSTEM 5.1B - BUYER SEARCH SIGNAL LOGGER
 * Logs buyer search and match signals to activities table
 * 
 * CONSTRAINTS:
 * - WRITE ONLY to activities table
 * - Buyer-facing signals (not internal match scores)
 */

import { createServiceClient } from '@/lib/supabase/service'
import type { ParsedBuyerIntent } from './intent-parser'
import type { PersonaProfile } from './persona-inference'

export interface BuyerSearchSignalPayload {
  listing_id: string
  confidence_level: 'low' | 'medium' | 'high'
  inferred_focus: string // Internal: what persona emphasized
  match_factors_shown: string[] // What we told the buyer
  generated_at: string
}

/**
 * Log buyer search match signal
 * Records when a buyer searches and sees a listing
 */
export async function logBuyerSearchMatch(
  contactId: string,
  listingId: string,
  intent: ParsedBuyerIntent,
  persona: PersonaProfile,
  matchScore: number
): Promise<{ success: boolean; error?: string }> {
  const supabase = createServiceClient()

  const confidenceLevel = matchScore >= 70 ? 'high' : matchScore >= 50 ? 'medium' : 'low'

  const payload: BuyerSearchSignalPayload = {
    listing_id: listingId,
    confidence_level: confidenceLevel,
    inferred_focus: persona.focusAreas.join(', '),
    match_factors_shown: [], // To be filled by caller
    generated_at: new Date().toISOString(),
  }

  console.log('[v0] Logging buyer search match:', contactId, listingId, confidenceLevel)

  const { error } = await supabase.from('activities').insert({
    entity_type: 'contact',
    entity_id: contactId,
    activity_type: 'buyer_search_match',
    title: `Property Match: ${confidenceLevel.toUpperCase()}`,
    description: `Matched listing ${listingId} via natural language search`,
    notes: JSON.stringify({
      ...payload,
      search_query_length: intent.rawQuery.length,
      persona_detected: persona.persona,
      persona_confidence: persona.confidence,
    }),
    status: 'completed',
    created_at: new Date().toISOString(),
  })

  if (error) {
    console.error('[v0] Failed to log search match:', error)
    return { success: false, error: error.message }
  }

  return { success: true }
}

/**
 * Log batch of buyer search matches
 */
export async function logBatchBuyerSearchMatches(
  contactId: string,
  matches: Array<{
    listingId: string
    matchScore: number
    confidenceLevel: 'low' | 'medium' | 'high'
  }>,
  intent: ParsedBuyerIntent,
  persona: PersonaProfile
): Promise<{ success: boolean; logged: number; errors?: string[] }> {
  const supabase = createServiceClient()
  const errors: string[] = []
  let logged = 0

  const records = matches.map(match => ({
    entity_type: 'contact',
    entity_id: contactId,
    activity_type: 'buyer_search_match',
    title: `Property Match: ${match.confidenceLevel.toUpperCase()}`,
    description: `Matched listing ${match.listingId} via natural language search`,
    notes: JSON.stringify({
      listing_id: match.listingId,
      confidence_level: match.confidenceLevel,
      inferred_focus: persona.focusAreas.join(', '),
      persona_detected: persona.persona,
      generated_at: new Date().toISOString(),
    }),
    status: 'completed',
    created_at: new Date().toISOString(),
  }))

  console.log('[v0] Logging batch buyer search matches:', contactId, matches.length)

  const { error, count } = await supabase.from('activities').insert(records)

  if (error) {
    console.error('[v0] Failed to log batch search matches:', error)
    errors.push(error.message)
  } else {
    logged = count || records.length
  }

  return { success: !error, logged, errors: errors.length > 0 ? errors : undefined }
}

/**
 * Log buyer preference inference to contacts.notes (optional)
 * MUST append only, never overwrite
 */
export async function appendBuyerSearchPreferences(
  contactId: string,
  intent: ParsedBuyerIntent,
  persona: PersonaProfile
): Promise<{ success: boolean; error?: string }> {
  const supabase = createServiceClient()

  console.log('[v0] Appending search preferences for contact:', contactId)

  // Fetch existing notes
  const { data: contact, error: fetchError } = await supabase
    .from('contacts')
    .select('notes')
    .eq('id', contactId)
    .single()

  if (fetchError) {
    console.error('[v0] Failed to fetch contact notes:', fetchError)
    return { success: false, error: fetchError.message }
  }

  let notesObj: any = {}

  // Parse existing notes if JSON
  if (contact?.notes) {
    try {
      notesObj = JSON.parse(contact.notes)
    } catch {
      // Not JSON, preserve as-is
      notesObj = { original_notes: contact.notes }
    }
  }

  // Append to ai_inference.search namespace
  notesObj.ai_inference = {
    ...notesObj.ai_inference,
    search: {
      last_search_at: new Date().toISOString(),
      recent_intent: {
        price_range: intent.maxPrice ? { max: intent.maxPrice } : undefined,
        min_beds: intent.minBeds,
        cities: intent.cities,
        features: intent.features,
      },
      inferred_persona: {
        type: persona.persona,
        confidence: persona.confidence,
        last_updated: new Date().toISOString(),
      },
    },
  }

  const { error: updateError } = await supabase
    .from('contacts')
    .update({ notes: JSON.stringify(notesObj) })
    .eq('id', contactId)

  if (updateError) {
    console.error('[v0] Failed to update contact notes:', updateError)
    return { success: false, error: updateError.message }
  }

  return { success: true }
}

/**
 * Get recent buyer search history (from activities)
 */
export async function getBuyerSearchHistory(params: {
  contactId: string
  limit?: number
}) {
  const { contactId, limit = 20 } = params
  const supabase = createServiceClient()

  const { data: activities, error } = await supabase
    .from('activities')
    .select('id, title, description, notes, created_at')
    .eq('entity_type', 'contact')
    .eq('entity_id', contactId)
    .eq('activity_type', 'buyer_search_match')
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) {
    return { success: false, error: error.message }
  }

  const searches = activities?.map(a => {
    let payload = null
    try {
      payload = JSON.parse(a.notes || '{}')
    } catch {
      payload = {}
    }

    return {
      search_id: a.id,
      listing_id: payload.listing_id,
      confidence_level: payload.confidence_level,
      persona_detected: payload.persona_detected,
      searched_at: a.created_at,
    }
  })

  return {
    success: true,
    searches: searches || [],
    metadata: {
      contact_id: contactId,
      total_searches: searches?.length || 0,
    },
  }
}
