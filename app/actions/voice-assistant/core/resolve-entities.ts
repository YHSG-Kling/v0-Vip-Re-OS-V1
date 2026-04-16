'use server'

/**
 * SYSTEM 6.1 - Entity Resolution
 * Resolves natural language references to database IDs
 * Handles: address → listing_id, contact name → contact_id, etc.
 */

import { createClient } from '@/lib/supabase/server'

export interface EntityResolutionResult {
  success: boolean
  resolved_entities?: Record<string, any>
  requires_clarification?: boolean
  disambiguation_options?: string[]
  clarification_message?: string
  error?: string
  listing_id?: string
  contact_id?: string
}

interface ResolveEntitiesRequest {
  entities: Record<string, any>
  user_id: string
  brokerage_id: string
  context?: Record<string, any>
}

/**
 * Resolve natural language entity references to database IDs
 */
export async function resolveEntities(request: ResolveEntitiesRequest): Promise<EntityResolutionResult> {
  const { entities, user_id, brokerage_id, context } = request
  const supabase = await createClient()
  const resolved: Record<string, any> = {}

  try {
    // Resolve address to listing_id
    if (entities.address) {
      const listingResult = await resolveAddress(entities.address, brokerage_id, supabase)
      if (!listingResult.success) {
        return listingResult
      }
      resolved.listing_id = listingResult.listing_id
    }

    // Resolve contact name to contact_id
    if (entities.contact_name) {
      const contactResult = await resolveContactName(entities.contact_name, user_id, brokerage_id, supabase)
      if (!contactResult.success) {
        return contactResult
      }
      resolved.contact_id = contactResult.contact_id
      resolved.buyer_id = contactResult.contact_id // Alias for buyer commands
    }

    // Use context if entities not found in transcript
    if (!resolved.listing_id && context?.current_listing_id) {
      resolved.listing_id = context.current_listing_id
    }

    if (!resolved.buyer_id && context?.current_buyer_id) {
      resolved.buyer_id = context.current_buyer_id
      resolved.contact_id = context.current_buyer_id
    }

    return {
      success: true,
      resolved_entities: resolved
    }

  } catch (error) {
    console.error('[resolve-entities] Error:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Entity resolution failed'
    }
  }
}

/**
 * Resolve address to listing_id
 */
async function resolveAddress(
  address: string,
  brokerageId: string,
  supabase: Awaited<ReturnType<typeof createClient>>
): Promise<EntityResolutionResult> {
  const { data: listings, error } = await supabase
    .from('listings')
    .select('id, address, city, state, zip')
    .eq('brokerage_id', brokerageId)
    .ilike('address', `%${address}%`)
    .limit(5)

  if (error) {
    return { success: false, error: error.message }
  }

  if (!listings || listings.length === 0) {
    return {
      success: false,
      error: `No listings found matching "${address}"`
    }
  }

  // Multiple matches - require disambiguation
  if (listings.length > 1) {
    return {
      success: false,
      requires_clarification: true,
      disambiguation_options: listings.map((l: any) => `${l.address}, ${l.city}, ${l.state} ${l.zip}`),
      clarification_message: `I found ${listings.length} properties matching "${address}". Which one did you mean?`
    }
  }

  // Single match
  return {
    success: true,
    listing_id: listings[0].id
  }
}

/**
 * Resolve contact name to contact_id
 */
async function resolveContactName(
  name: string,
  userId: string,
  brokerageId: string,
  supabase: Awaited<ReturnType<typeof createClient>>
): Promise<EntityResolutionResult> {
  const nameParts = name.trim().split(/\s+/)
  const firstName = nameParts[0]
  const lastName = nameParts.length > 1 ? nameParts[nameParts.length - 1] : ''

  // Query contacts
  let query = supabase
    .from('contacts')
    .select('id, first_name, last_name, email')
    .eq('brokerage_id', brokerageId)

  // Match first name
  query = query.ilike('first_name', `%${firstName}%`)

  // Match last name if provided
  if (lastName) {
    query = query.ilike('last_name', `%${lastName}%`)
  }

  const { data: contacts, error } = await query.limit(5)

  if (error) {
    return { success: false, error: error.message }
  }

  if (!contacts || contacts.length === 0) {
    return {
      success: false,
      error: `No contacts found matching "${name}"`
    }
  }

  // Multiple matches - require disambiguation
  if (contacts.length > 1) {
    return {
      success: false,
      requires_clarification: true,
      disambiguation_options: contacts.map((c: any) => `${c.first_name} ${c.last_name} (${c.email || 'no email'})`),
      clarification_message: `I found ${contacts.length} contacts matching "${name}". Which one did you mean?`
    }
  }

  // Single match
  return {
    success: true,
    contact_id: contacts[0].id
  }
}
