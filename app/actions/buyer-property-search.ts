'use server'

/**
 * SYSTEM 5.1B - BUYER-INITIATED SEARCH & SMART MATCH
 * Thin action wrappers — core logic lives in lib/buyer-search/search-engine.ts
 */

import {
  searchPropertiesCore,
  explainPropertyMatchCore,
  type BuyerSearchResult,
} from '@/lib/buyer-search/search-engine'
import { isValidUUID } from '@/lib/validations'
import { handleError } from '@/lib/errors'
import { parseNaturalLanguageQuery, mergeIntentWithContext } from '@/lib/buyer-search/intent-parser'
import { inferBuyerPersona } from '@/lib/buyer-search/persona-inference'
import { createServiceClient } from '@/lib/supabase/service'

export type { BuyerSearchResult }

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
    limit?: number
    minScore?: number
    logSignals?: boolean
    includeDebugInfo?: boolean
  }
}) {
  return searchPropertiesCore(params)
}

export async function explainPropertyMatchForBuyer(params: {
  contactId: string
  listingId: string
  context?: string
}) {
  return explainPropertyMatchCore(params)
}

export async function previewSearchIntent(params: {
  contactId: string
  naturalLanguageQuery: string
}) {
  const { contactId, naturalLanguageQuery } = params
  if (!isValidUUID(contactId)) return { success: false, error: 'Invalid contact ID' }

  try {
    const supabase = createServiceClient()
    const parsedIntent = parseNaturalLanguageQuery(naturalLanguageQuery)

    const [{ data: contact }, { data: insight }] = await Promise.all([
      supabase.from('contacts').select('notes').eq('id', contactId).single(),
      supabase.from('conversation_insights').select('inferred_intent, urgency_level, health_score')
        .eq('contact_id', contactId).order('updated_at', { ascending: false }).limit(1).maybeSingle(),
    ])

    let existingPreferences: any = null
    if (contact?.notes) {
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

    const persona = inferBuyerPersona(enrichedIntent, {
      inferred_intent: insight?.inferred_intent,
      health_score: insight?.health_score,
    })

    return {
      success: true,
      preview: {
        understood: {
          price_range: enrichedIntent.maxPrice ? `Up to $${(enrichedIntent.maxPrice / 1000).toFixed(0)}K` : 'Not specified',
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
