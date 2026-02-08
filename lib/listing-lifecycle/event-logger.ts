/**
 * System 4.1 - Lifecycle Event Logger
 * 
 * Logs all listing lifecycle events to activities table.
 * WRITES ONLY to activities and automation_errors tables.
 */

import { createClient } from '@/lib/supabase/server'
import { ListingStatus, ListingStage } from './state-machine'

export interface LifecycleEvent {
  listing_id: string
  agent_id?: string
  event_type: string
  from_status?: ListingStatus
  to_status?: ListingStatus
  from_stage?: ListingStage
  to_stage?: ListingStage
  metadata?: Record<string, any>
  notes?: string
}

/**
 * Log status transition to activities table
 */
export async function logStatusTransition(event: LifecycleEvent) {
  const supabase = await createClient()

  try {
    const { error } = await supabase.from('activities').insert({
      type: 'LISTING_STATUS_CHANGE',
      entity_type: 'listing',
      entity_id: event.listing_id,
      metadata: {
        from_status: event.from_status,
        to_status: event.to_status,
        agent_id: event.agent_id,
        notes: event.notes,
        ...event.metadata
      },
      created_at: new Date().toISOString()
    })

    if (error) {
      console.error('[v0] Failed to log status transition:', error)
      await logError('STATUS_TRANSITION_LOG_ERROR', error.message, { event })
    }

    return { success: !error }
  } catch (error: any) {
    console.error('[v0] Status transition logging error:', error)
    return { success: false, error: error.message }
  }
}

/**
 * Log stage progression to activities table
 */
export async function logStageProgression(event: LifecycleEvent) {
  const supabase = await createClient()

  try {
    const { error } = await supabase.from('activities').insert({
      type: 'LISTING_STAGE_CHANGE',
      entity_type: 'listing',
      entity_id: event.listing_id,
      metadata: {
        from_stage: event.from_stage,
        to_stage: event.to_stage,
        agent_id: event.agent_id,
        notes: event.notes,
        ...event.metadata
      },
      created_at: new Date().toISOString()
    })

    if (error) {
      console.error('[v0] Failed to log stage progression:', error)
      await logError('STAGE_PROGRESSION_LOG_ERROR', error.message, { event })
    }

    return { success: !error }
  } catch (error: any) {
    console.error('[v0] Stage progression logging error:', error)
    return { success: false, error: error.message }
  }
}

/**
 * Log listing went live event
 */
export async function logListingWentLive(event: LifecycleEvent) {
  const supabase = await createClient()

  try {
    const { error } = await supabase.from('activities').insert({
      type: 'LISTING_WENT_LIVE',
      entity_type: 'listing',
      entity_id: event.listing_id,
      metadata: {
        mls_number: event.metadata?.mls_number,
        mls_link: event.metadata?.mls_link,
        agent_id: event.agent_id,
        ...event.metadata
      },
      created_at: new Date().toISOString()
    })

    if (error) {
      await logError('LISTING_LIVE_LOG_ERROR', error.message, { event })
    }

    return { success: !error }
  } catch (error: any) {
    console.error('[v0] Listing went live logging error:', error)
    return { success: false, error: error.message }
  }
}

/**
 * Log offer accepted event
 */
export async function logOfferAccepted(event: LifecycleEvent) {
  const supabase = await createClient()

  try {
    const { error } = await supabase.from('activities').insert({
      type: 'OFFER_ACCEPTED',
      entity_type: 'listing',
      entity_id: event.listing_id,
      metadata: {
        offer_amount: event.metadata?.offer_amount,
        buyer_id: event.metadata?.buyer_id,
        agent_id: event.agent_id,
        ...event.metadata
      },
      created_at: new Date().toISOString()
    })

    if (error) {
      await logError('OFFER_ACCEPTED_LOG_ERROR', error.message, { event })
    }

    return { success: !error }
  } catch (error: any) {
    console.error('[v0] Offer accepted logging error:', error)
    return { success: false, error: error.message }
  }
}

/**
 * Log sale closed event
 */
export async function logSaleClosed(event: LifecycleEvent) {
  const supabase = await createClient()

  try {
    const { error } = await supabase.from('activities').insert({
      type: 'SALE_CLOSED',
      entity_type: 'listing',
      entity_id: event.listing_id,
      metadata: {
        closing_date: event.metadata?.closing_date,
        sale_price: event.metadata?.sale_price,
        commission: event.metadata?.commission,
        agent_id: event.agent_id,
        ...event.metadata
      },
      created_at: new Date().toISOString()
    })

    if (error) {
      await logError('SALE_CLOSED_LOG_ERROR', error.message, { event })
    }

    return { success: !error }
  } catch (error: any) {
    console.error('[v0] Sale closed logging error:', error)
    return { success: false, error: error.message }
  }
}

/**
 * Log listing expired event
 */
export async function logListingExpired(event: LifecycleEvent) {
  const supabase = await createClient()

  try {
    const { error } = await supabase.from('activities').insert({
      type: 'LISTING_EXPIRED',
      entity_type: 'listing',
      entity_id: event.listing_id,
      metadata: {
        expiration_date: event.metadata?.expiration_date,
        agent_id: event.agent_id,
        ...event.metadata
      },
      created_at: new Date().toISOString()
    })

    if (error) {
      await logError('LISTING_EXPIRED_LOG_ERROR', error.message, { event })
    }

    return { success: !error }
  } catch (error: any) {
    console.error('[v0] Listing expired logging error:', error)
    return { success: false, error: error.message }
  }
}

/**
 * Log listing withdrawn event
 */
export async function logListingWithdrawn(event: LifecycleEvent) {
  const supabase = await createClient()

  try {
    const { error } = await supabase.from('activities').insert({
      type: 'LISTING_WITHDRAWN',
      entity_type: 'listing',
      entity_id: event.listing_id,
      metadata: {
        reason: event.metadata?.reason,
        agent_id: event.agent_id,
        notes: event.notes,
        ...event.metadata
      },
      created_at: new Date().toISOString()
    })

    if (error) {
      await logError('LISTING_WITHDRAWN_LOG_ERROR', error.message, { event })
    }

    return { success: !error }
  } catch (error: any) {
    console.error('[v0] Listing withdrawn logging error:', error)
    return { success: false, error: error.message }
  }
}

/**
 * Log price change event
 */
export async function logPriceChange(event: LifecycleEvent) {
  const supabase = await createClient()

  try {
    const { error } = await supabase.from('activities').insert({
      type: 'LISTING_PRICE_CHANGE',
      entity_type: 'listing',
      entity_id: event.listing_id,
      metadata: {
        old_price: event.metadata?.old_price,
        new_price: event.metadata?.new_price,
        change_percentage: event.metadata?.change_percentage,
        agent_id: event.agent_id,
        ...event.metadata
      },
      created_at: new Date().toISOString()
    })

    if (error) {
      await logError('PRICE_CHANGE_LOG_ERROR', error.message, { event })
    }

    return { success: !error }
  } catch (error: any) {
    console.error('[v0] Price change logging error:', error)
    return { success: false, error: error.message }
  }
}

/**
 * Log general lifecycle event
 */
export async function logLifecycleEvent(event: LifecycleEvent) {
  const supabase = await createClient()

  try {
    const { error } = await supabase.from('activities').insert({
      type: event.event_type,
      entity_type: 'listing',
      entity_id: event.listing_id,
      metadata: {
        agent_id: event.agent_id,
        notes: event.notes,
        ...event.metadata
      },
      created_at: new Date().toISOString()
    })

    if (error) {
      await logError('LIFECYCLE_EVENT_LOG_ERROR', error.message, { event })
    }

    return { success: !error }
  } catch (error: any) {
    console.error('[v0] Lifecycle event logging error:', error)
    return { success: false, error: error.message }
  }
}

/**
 * Log error to automation_errors table
 */
export async function logError(errorType: string, errorMessage: string, context?: any) {
  const supabase = await createClient()

  try {
    await supabase.from('automation_errors').insert({
      system_name: 'System 4.1 - Listing Lifecycle',
      error_type: errorType,
      error_message: errorMessage,
      context: context || {},
      occurred_at: new Date().toISOString()
    })
  } catch (error) {
    console.error('[v0] Failed to log error to automation_errors:', error)
  }
}

/**
 * Get lifecycle timeline for a listing
 */
export async function getListingTimeline(listingId: string) {
  const supabase = await createClient()

  try {
    const { data, error } = await supabase
      .from('activities')
      .select('*')
      .eq('entity_type', 'listing')
      .eq('entity_id', listingId)
      .order('created_at', { ascending: false })

    if (error) {
      console.error('[v0] Failed to fetch listing timeline:', error)
      return { success: false, error: error.message }
    }

    return { success: true, timeline: data }
  } catch (error: any) {
    console.error('[v0] Get listing timeline error:', error)
    return { success: false, error: error.message }
  }
}
