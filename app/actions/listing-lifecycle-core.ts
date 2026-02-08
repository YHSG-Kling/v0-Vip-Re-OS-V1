'use server'

/**
 * System 4.1 - Listing Lifecycle Core Server Actions
 * 
 * Main integration layer for listing lifecycle management.
 * Orchestrates validation, logging, and workflow triggering.
 */

import { createClient } from '@/lib/supabase/server'
import {
  ListingStatus,
  ListingStage,
  isValidTransition,
  getAvailableTransitions,
  getRecommendedStatus,
  getStatusLabel,
  getStageLabel
} from '@/lib/listing-lifecycle/state-machine'
import {
  validateStatusTransition,
  validateStageProgression,
  canGoLive,
  canAcceptOffer,
  canWithdraw,
  canMarkSold,
  canArchive,
  getListingValidationErrors,
  getListingRecommendations,
  ValidationResult
} from '@/lib/listing-lifecycle/transition-validator'
import {
  logStatusTransition,
  logStageProgression,
  logListingWentLive,
  logOfferAccepted,
  logSaleClosed,
  logListingExpired,
  logListingWithdrawn,
  logPriceChange,
  logError,
  getListingTimeline
} from '@/lib/listing-lifecycle/event-logger'
import {
  executeStatusWorkflows,
  triggerPriceReductionWorkflow
} from '@/lib/listing-lifecycle/workflow-triggers'

/**
 * Transition listing status with validation
 */
export async function transitionListingStatus(params: {
  listing_id: string
  to_status: ListingStatus
  agent_id: string
  notes?: string
  metadata?: Record<string, any>
}) {
  const { listing_id, to_status, agent_id, notes, metadata } = params

  const supabase = await createClient()

  try {
    // Fetch current listing
    const { data: listing, error: fetchError } = await supabase
      .from('listings')
      .select('*')
      .eq('id', listing_id)
      .single()

    if (fetchError || !listing) {
      return {
        success: false,
        error: 'Listing not found'
      }
    }

    const currentStatus = listing.status as ListingStatus

    // Validate transition
    const validation = validateStatusTransition(currentStatus, to_status, {
      ...listing,
      ...metadata
    })

    if (!validation.valid) {
      return {
        success: false,
        error: validation.errors.join(', '),
        validation
      }
    }

    // Update listing status
    const { error: updateError } = await supabase
      .from('listings')
      .update({
        status: to_status,
        updated_at: new Date().toISOString()
      })
      .eq('id', listing_id)

    if (updateError) {
      await logError('STATUS_UPDATE_ERROR', updateError.message, { listing_id, to_status })
      return {
        success: false,
        error: 'Failed to update listing status'
      }
    }

    // Log transition
    await logStatusTransition({
      listing_id,
      agent_id,
      event_type: 'STATUS_TRANSITION',
      from_status: currentStatus,
      to_status,
      notes,
      metadata
    })

    // Execute workflows
    await executeStatusWorkflows(
      listing_id,
      currentStatus,
      to_status,
      agent_id,
      listing.contact_id,
      metadata
    )

    // Log specific events
    if (to_status === 'active' && currentStatus === 'draft') {
      await logListingWentLive({ listing_id, agent_id, event_type: 'LISTING_WENT_LIVE', metadata })
    } else if (to_status === 'pending') {
      await logOfferAccepted({ listing_id, agent_id, event_type: 'OFFER_ACCEPTED', metadata })
    } else if (to_status === 'sold') {
      await logSaleClosed({ listing_id, agent_id, event_type: 'SALE_CLOSED', metadata })
    } else if (to_status === 'expired') {
      await logListingExpired({ listing_id, agent_id, event_type: 'LISTING_EXPIRED', metadata })
    } else if (to_status === 'withdrawn') {
      await logListingWithdrawn({ listing_id, agent_id, event_type: 'LISTING_WITHDRAWN', metadata, notes })
    }

    return {
      success: true,
      from_status: currentStatus,
      to_status,
      validation
    }

  } catch (error: any) {
    console.error('[v0] Listing status transition error:', error)
    await logError('STATUS_TRANSITION_ERROR', error.message, params)
    return {
      success: false,
      error: error.message
    }
  }
}

/**
 * Progress listing stage
 */
export async function progressListingStage(params: {
  listing_id: string
  to_stage: ListingStage
  agent_id: string
  notes?: string
}) {
  const { listing_id, to_stage, agent_id, notes } = params

  const supabase = await createClient()

  try {
    // Fetch current listing
    const { data: listing, error: fetchError } = await supabase
      .from('listings')
      .select('*')
      .eq('id', listing_id)
      .single()

    if (fetchError || !listing) {
      return {
        success: false,
        error: 'Listing not found'
      }
    }

    const currentStage = (listing.stage || 'prospecting') as ListingStage

    // Validate stage progression
    const validation = validateStageProgression(currentStage, to_stage)

    if (!validation.valid) {
      return {
        success: false,
        error: validation.errors.join(', '),
        validation
      }
    }

    // Update listing stage
    const { error: updateError } = await supabase
      .from('listings')
      .update({
        stage: to_stage,
        updated_at: new Date().toISOString()
      })
      .eq('id', listing_id)

    if (updateError) {
      await logError('STAGE_UPDATE_ERROR', updateError.message, { listing_id, to_stage })
      return {
        success: false,
        error: 'Failed to update listing stage'
      }
    }

    // Log stage progression
    await logStageProgression({
      listing_id,
      agent_id,
      event_type: 'STAGE_PROGRESSION',
      from_stage: currentStage,
      to_stage,
      notes
    })

    return {
      success: true,
      from_stage: currentStage,
      to_stage
    }

  } catch (error: any) {
    console.error('[v0] Listing stage progression error:', error)
    await logError('STAGE_PROGRESSION_ERROR', error.message, params)
    return {
      success: false,
      error: error.message
    }
  }
}

/**
 * Update listing price
 */
export async function updateListingPrice(params: {
  listing_id: string
  new_price: number
  agent_id: string
  reason?: string
}) {
  const { listing_id, new_price, agent_id, reason } = params

  const supabase = await createClient()

  try {
    // Fetch current listing
    const { data: listing, error: fetchError } = await supabase
      .from('listings')
      .select('price')
      .eq('id', listing_id)
      .single()

    if (fetchError || !listing) {
      return {
        success: false,
        error: 'Listing not found'
      }
    }

    const oldPrice = listing.price

    // Update price
    const { error: updateError } = await supabase
      .from('listings')
      .update({
        price: new_price,
        updated_at: new Date().toISOString()
      })
      .eq('id', listing_id)

    if (updateError) {
      await logError('PRICE_UPDATE_ERROR', updateError.message, { listing_id, new_price })
      return {
        success: false,
        error: 'Failed to update listing price'
      }
    }

    // Log price change
    const changePercentage = ((oldPrice - new_price) / oldPrice) * 100
    await logPriceChange({
      listing_id,
      agent_id,
      event_type: 'PRICE_CHANGE',
      metadata: {
        old_price: oldPrice,
        new_price,
        change_percentage: changePercentage.toFixed(2),
        reason
      }
    })

    // Trigger workflow if price reduction
    if (new_price < oldPrice) {
      await triggerPriceReductionWorkflow(listing_id, agent_id, oldPrice, new_price)
    }

    return {
      success: true,
      old_price: oldPrice,
      new_price,
      change_percentage: changePercentage.toFixed(2)
    }

  } catch (error: any) {
    console.error('[v0] Listing price update error:', error)
    await logError('PRICE_UPDATE_ERROR', error.message, params)
    return {
      success: false,
      error: error.message
    }
  }
}

/**
 * Get available transitions for a listing
 */
export async function getListingTransitions(listingId: string) {
  const supabase = await createClient()

  try {
    const { data: listing, error } = await supabase
      .from('listings')
      .select('status')
      .eq('id', listingId)
      .single()

    if (error || !listing) {
      return {
        success: false,
        error: 'Listing not found'
      }
    }

    const currentStatus = listing.status as ListingStatus
    const transitions = getAvailableTransitions(currentStatus)

    return {
      success: true,
      current_status: currentStatus,
      available_transitions: transitions.map(t => ({
        to: t.to,
        description: t.description,
        requires: t.requires || [],
        label: getStatusLabel(t.to)
      }))
    }

  } catch (error: any) {
    console.error('[v0] Get listing transitions error:', error)
    return {
      success: false,
      error: error.message
    }
  }
}

/**
 * Validate listing can go live
 */
export async function validateListingGoLive(listingId: string): Promise<{ success: boolean; validation?: ValidationResult; error?: string }> {
  const supabase = await createClient()

  try {
    const { data: listing, error } = await supabase
      .from('listings')
      .select('*')
      .eq('id', listingId)
      .single()

    if (error || !listing) {
      return {
        success: false,
        error: 'Listing not found'
      }
    }

    const validation = canGoLive(listing as any)

    return {
      success: true,
      validation
    }

  } catch (error: any) {
    console.error('[v0] Validate listing go live error:', error)
    return {
      success: false,
      error: error.message
    }
  }
}

/**
 * Get listing lifecycle timeline
 */
export async function getListingLifecycleTimeline(listingId: string) {
  return await getListingTimeline(listingId)
}

/**
 * Get listing health check
 */
export async function getListingHealthCheck(listingId: string) {
  const supabase = await createClient()

  try {
    const { data: listing, error } = await supabase
      .from('listings')
      .select('*')
      .eq('id', listingId)
      .single()

    if (error || !listing) {
      return {
        success: false,
        error: 'Listing not found'
      }
    }

    const errors = getListingValidationErrors(listing as any)
    const recommendations = getListingRecommendations(listing as any)

    return {
      success: true,
      health: {
        status: listing.status,
        stage: listing.stage || 'prospecting',
        status_label: getStatusLabel(listing.status as ListingStatus),
        stage_label: getStageLabel((listing.stage || 'prospecting') as ListingStage),
        errors,
        recommendations,
        is_healthy: errors.length === 0
      }
    }

  } catch (error: any) {
    console.error('[v0] Get listing health check error:', error)
    return {
      success: false,
      error: error.message
    }
  }
}

// Export validation functions for use in other modules
export {
  validateStatusTransition,
  canGoLive,
  canAcceptOffer,
  canWithdraw,
  canMarkSold,
  canArchive,
  isValidTransition,
  getStatusLabel,
  getStageLabel
}
