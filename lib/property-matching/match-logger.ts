// Agent task (correct location, no changes) — activity_type: buyer_match_signal
/**
 * SYSTEM 5.1A - MATCH SIGNAL LOGGER
 * Logs buyer match signals to activities table for audit trail
 * 
 * CONSTRAINTS:
 * - WRITE ONLY to activities table
 * - Internal signals only (not buyer-facing)
 */

import { createServiceClient } from '@/lib/supabase/service'
import type { MatchScore } from './match-scorer'

export interface MatchSignalPayload {
  contact_id: string
  match_confidence: string
  match_score: number
  top_factors: string[]
  caution_notes: string[]
  generated_at: string
}

/**
 * Log a buyer match signal to activities table
 * Creates an audit record for internal use
 */
export async function logBuyerMatchSignal(
  listingId: string,
  match: MatchScore
): Promise<{ success: boolean; error?: string }> {
  const supabase = createServiceClient()

  const payload: MatchSignalPayload = {
    contact_id: match.contact_id,
    match_confidence: match.match_confidence,
    match_score: match.score,
    top_factors: match.match_factors.slice(0, 5), // Top 5 factors
    caution_notes: match.caution_notes,
    generated_at: new Date().toISOString(),
  }

  console.log('[MatchLogger] Logging buyer match signal:', listingId, match.contact_id, match.score)

  const { error } = await supabase.from('activities').insert({
    entity_type: 'listing',
    entity_id: listingId,
    activity_type: 'buyer_match_signal',
    title: `Buyer Match: ${match.match_confidence.toUpperCase()} (${match.score}/100)`,
    description: `Identified ${match.match_confidence} confidence match for buyer`,
    notes: JSON.stringify(payload),
    status: 'completed',
    created_at: new Date().toISOString(),
  })

  if (error) {
    console.error('[MatchLogger] Failed to log match signal:', error)
    return { success: false, error: error.message }
  }

  return { success: true }
}

/**
 * Log a batch of match signals efficiently
 */
export async function logBatchMatchSignals(
  listingId: string,
  matches: MatchScore[]
): Promise<{ success: boolean; logged: number; errors?: string[] }> {
  const supabase = createServiceClient()
  const errors: string[] = []
  let logged = 0

  const records = matches.map((match) => ({
    entity_type: 'listing',
    entity_id: listingId,
    activity_type: 'buyer_match_signal',
    title: `Buyer Match: ${match.match_confidence.toUpperCase()} (${match.score}/100)`,
    description: `Identified ${match.match_confidence} confidence match for buyer`,
    notes: JSON.stringify({
      contact_id: match.contact_id,
      match_confidence: match.match_confidence,
      match_score: match.score,
      top_factors: match.match_factors.slice(0, 5),
      caution_notes: match.caution_notes,
      generated_at: new Date().toISOString(),
    }),
    status: 'completed',
    created_at: new Date().toISOString(),
  }))

  console.log('[MatchLogger] Logging batch match signals:', listingId, matches.length)

  const { error, count } = await supabase.from('activities').insert(records)

  if (error) {
    console.error('[MatchLogger] Failed to log batch signals:', error)
    errors.push(error.message)
  } else {
    logged = count || records.length
  }

  return { success: !error, logged, errors: errors.length > 0 ? errors : undefined }
}

/**
 * Log buyer preference inference to contacts.notes (optional, non-authoritative)
 * MUST append only, never overwrite
 */
export async function appendBuyerPreferenceInference(
  contactId: string,
  inferredPreferences: Record<string, any>
): Promise<{ success: boolean; error?: string }> {
  const supabase = createServiceClient()

  console.log('[MatchLogger] Appending preference inference for contact:', contactId)

  // Fetch existing notes
  const { data: contact, error: fetchError } = await supabase
    .from('contacts')
    .select('notes')
    .eq('id', contactId)
    .single()

  if (fetchError) {
    console.error('[MatchLogger] Failed to fetch contact notes:', fetchError)
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

  // Append to ai_inference namespace
  notesObj.ai_inference = {
    ...notesObj.ai_inference,
    buyer_preferences: {
      ...notesObj.ai_inference?.buyer_preferences,
      ...inferredPreferences,
    },
    last_inference_at: new Date().toISOString(),
  }

  const { error: updateError } = await supabase
    .from('contacts')
    .update({ notes: JSON.stringify(notesObj) })
    .eq('id', contactId)

  if (updateError) {
    console.error('[MatchLogger] Failed to update contact notes:', updateError)
    return { success: false, error: updateError.message }
  }

  return { success: true }
}
