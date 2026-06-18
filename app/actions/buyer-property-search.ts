'use server'

/**
 * SYSTEM 5.1B - BUYER-INITIATED SEARCH & SMART MATCH
 * Thin action wrappers — core logic lives in lib/buyer-search/search-engine.ts
 */

import {
  searchPropertiesCore,
  explainPropertyMatchCore,
  parseNaturalLanguageQuery,
  mergeIntentWithContext,
  inferBuyerPersona,
} from '@/lib/buyer-search'
import { isValidUUID } from '@/lib/validations'
import { handleError } from '@/lib/errors'
import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'

// Search actions burn paid AI inference + read contact context. Was
// unauthenticated previously — any caller could probe contacts by UUID.
async function requireContactAccess(contactId: string): Promise<
  | { ok: true; brokerageId: string }
  | { ok: false; error: string }
> {
  if (!isValidUUID(contactId)) return { ok: false, error: 'Invalid contact ID' }
  const authClient = await createClient()
  const { data: { user } } = await authClient.auth.getUser()
  if (!user) return { ok: false, error: 'Unauthorized' }
  const svc = createServiceClient()
  const { data: contact } = await svc
    .from('contacts')
    .select('brokerage_id, contact_user_id, email')
    .eq('id', contactId)
    .maybeSingle()
  if (!contact?.brokerage_id) return { ok: false, error: 'Contact not found' }
  // The contact viewing their own portal.
  const isSelf =
    contact.contact_user_id === user.id ||
    !!(contact.email && user.email && contact.email.toLowerCase() === user.email.toLowerCase())
  if (isSelf) return { ok: true, brokerageId: contact.brokerage_id }
  // Otherwise must be staff in the same brokerage (matches the portal layout whitelist).
  const { data: callerRow } = await svc
    .from('users')
    .select('brokerage_id, user_type')
    .eq('id', user.id)
    .maybeSingle()
  if (
    callerRow?.brokerage_id === contact.brokerage_id &&
    ["agent","team_lead","tc","admin","broker","superadmin"].includes(((callerRow as any)?.user_type) ?? "")
  ) {
    return { ok: true, brokerageId: contact.brokerage_id }
  }
  return { ok: false, error: 'Forbidden' }
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
    limit?: number
    minScore?: number
    logSignals?: boolean
    includeDebugInfo?: boolean
  }
}) {
  const gate = await requireContactAccess(params.contactId)
  if (!gate.ok) return { success: false, error: gate.error }
  return searchPropertiesCore(params)
}

export async function explainPropertyMatchForBuyer(params: {
  contactId: string
  listingId: string
  context?: string
}) {
  const gate = await requireContactAccess(params.contactId)
  if (!gate.ok) return { success: false, error: gate.error }
  return explainPropertyMatchCore(params)
}

export async function previewSearchIntent(params: {
  contactId: string
  naturalLanguageQuery: string
}) {
  const { contactId, naturalLanguageQuery } = params
  const gate = await requireContactAccess(contactId)
  if (!gate.ok) return { success: false, error: gate.error }

  try {
    const supabase = createServiceClient()
    const parsedIntent = parseNaturalLanguageQuery(naturalLanguageQuery)

    const [{ data: contact }, { data: insight }] = await Promise.all([
      supabase.from('contacts').select('notes').eq('id', contactId).single(),
      supabase.from('conversation_insights').select('inferred_intent:context_summary, urgency_level:escalation_urgency, health_score')
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
