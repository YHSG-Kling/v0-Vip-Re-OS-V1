/**
 * System 4.1 - Automated Workflow Triggers
 * 
 * Triggers automated workflows based on status changes.
 * EMITS SIGNALS to activities table for downstream systems to consume.
 */

import { createClient } from '@/lib/supabase/server'
import { ListingStatus } from './state-machine'
import { logError } from './event-logger'

export interface WorkflowTrigger {
  listing_id: string
  workflow_name: string
  agent_id?: string
  contact_id?: string
  metadata?: Record<string, any>
}

/**
 * Trigger workflow signal - emits to activities table
 */
async function emitWorkflowSignal(trigger: WorkflowTrigger) {
  const supabase = await createClient()

  try {
    const { error } = await supabase.from('activities').insert({
      type: 'WORKFLOW_TRIGGER',
      entity_type: 'listing',
      entity_id: trigger.listing_id,
      metadata: {
        workflow_name: trigger.workflow_name,
        agent_id: trigger.agent_id,
        contact_id: trigger.contact_id,
        system: 'System 4.1 - Listing Lifecycle',
        ...trigger.metadata
      },
      created_at: new Date().toISOString()
    })

    if (error) {
      console.error('[v0] Failed to emit workflow signal:', error)
      await logError('WORKFLOW_SIGNAL_ERROR', error.message, { trigger })
    }

    return { success: !error }
  } catch (error: any) {
    console.error('[v0] Workflow signal error:', error)
    return { success: false, error: error.message }
  }
}

/**
 * Listing went live workflow
 */
export async function triggerListingWentLiveWorkflow(
  listingId: string,
  agentId: string,
  metadata?: Record<string, any>
) {
  await emitWorkflowSignal({
    listing_id: listingId,
    workflow_name: 'listing_went_live_workflow',
    agent_id: agentId,
    metadata: {
      ...metadata,
      tasks_to_create: [
        'share_on_social_media',
        'send_to_sphere',
        'schedule_open_house',
        'create_video_tour'
      ]
    }
  })
}

/**
 * Offer accepted workflow
 */
export async function triggerOfferAcceptedWorkflow(
  listingId: string,
  agentId: string,
  contactId: string,
  metadata?: Record<string, any>
) {
  await emitWorkflowSignal({
    listing_id: listingId,
    workflow_name: 'offer_accepted_workflow',
    agent_id: agentId,
    contact_id: contactId,
    metadata: {
      ...metadata,
      tasks_to_create: [
        'prepare_contract_documents',
        'schedule_inspection',
        'order_appraisal',
        'review_contingencies'
      ]
    }
  })
}

/**
 * Under contract workflow
 */
export async function triggerUnderContractWorkflow(
  listingId: string,
  agentId: string,
  contactId: string,
  metadata?: Record<string, any>
) {
  await emitWorkflowSignal({
    listing_id: listingId,
    workflow_name: 'under_contract_workflow',
    agent_id: agentId,
    contact_id: contactId,
    metadata: {
      ...metadata,
      tasks_to_create: [
        'monitor_contingency_periods',
        'coordinate_with_escrow',
        'track_inspection_completion',
        'verify_financing_progress'
      ]
    }
  })
}

/**
 * Sale closed workflow
 */
export async function triggerSaleClosedWorkflow(
  listingId: string,
  agentId: string,
  contactId: string,
  metadata?: Record<string, any>
) {
  await emitWorkflowSignal({
    listing_id: listingId,
    workflow_name: 'sale_closed_workflow',
    agent_id: agentId,
    contact_id: contactId,
    metadata: {
      ...metadata,
      tasks_to_create: [
        'send_closing_gift',
        'request_review',
        'update_crm',
        'archive_documents'
      ],
      communication_sequence: 'post_close_nurture'
    }
  })
}

/**
 * Listing expired workflow
 */
export async function triggerListingExpiredWorkflow(
  listingId: string,
  agentId: string,
  contactId: string,
  metadata?: Record<string, any>
) {
  await emitWorkflowSignal({
    listing_id: listingId,
    workflow_name: 'listing_expired_workflow',
    agent_id: agentId,
    contact_id: contactId,
    metadata: {
      ...metadata,
      tasks_to_create: [
        'schedule_renewal_meeting',
        'review_pricing_strategy',
        'analyze_market_feedback',
        'discuss_marketing_improvements'
      ]
    }
  })
}

/**
 * Listing withdrawn workflow
 */
export async function triggerListingWithdrawnWorkflow(
  listingId: string,
  agentId: string,
  contactId: string,
  metadata?: Record<string, any>
) {
  await emitWorkflowSignal({
    listing_id: listingId,
    workflow_name: 'listing_withdrawn_workflow',
    agent_id: agentId,
    contact_id: contactId,
    metadata: {
      ...metadata,
      tasks_to_create: [
        'remove_from_mls',
        'update_marketing_materials',
        'notify_interested_buyers',
        'follow_up_with_seller'
      ]
    }
  })
}

/**
 * Back on market workflow
 */
export async function triggerBackOnMarketWorkflow(
  listingId: string,
  agentId: string,
  contactId: string,
  metadata?: Record<string, any>
) {
  await emitWorkflowSignal({
    listing_id: listingId,
    workflow_name: 'back_on_market_workflow',
    agent_id: agentId,
    contact_id: contactId,
    metadata: {
      ...metadata,
      tasks_to_create: [
        'update_mls_status',
        'notify_previous_interested_buyers',
        'revise_marketing_strategy',
        'consider_price_adjustment'
      ]
    }
  })
}

/**
 * Listing renewed workflow
 */
export async function triggerListingRenewedWorkflow(
  listingId: string,
  agentId: string,
  contactId: string,
  metadata?: Record<string, any>
) {
  await emitWorkflowSignal({
    listing_id: listingId,
    workflow_name: 'listing_renewed_workflow',
    agent_id: agentId,
    contact_id: contactId,
    metadata: {
      ...metadata,
      tasks_to_create: [
        'update_listing_photos',
        'refresh_description',
        'implement_new_pricing',
        'relaunch_marketing_campaign'
      ]
    }
  })
}

/**
 * Listing relisted workflow
 */
export async function triggerListingRelistedWorkflow(
  listingId: string,
  agentId: string,
  contactId: string,
  metadata?: Record<string, any>
) {
  await emitWorkflowSignal({
    listing_id: listingId,
    workflow_name: 'listing_relisted_workflow',
    agent_id: agentId,
    contact_id: contactId,
    metadata: {
      ...metadata,
      tasks_to_create: [
        'update_mls_listing',
        'refresh_all_marketing',
        'announce_back_on_market',
        'schedule_new_open_houses'
      ]
    }
  })
}

/**
 * Price reduction workflow
 */
export async function triggerPriceReductionWorkflow(
  listingId: string,
  agentId: string,
  oldPrice: number,
  newPrice: number
) {
  const changePercentage = ((oldPrice - newPrice) / oldPrice) * 100

  await emitWorkflowSignal({
    listing_id: listingId,
    workflow_name: 'price_reduction_workflow',
    agent_id: agentId,
    metadata: {
      old_price: oldPrice,
      new_price: newPrice,
      change_percentage: changePercentage.toFixed(2),
      tasks_to_create: [
        'update_all_marketing_materials',
        'notify_interested_buyers',
        'update_mls',
        'send_price_drop_alert'
      ]
    }
  })
}

/**
 * Execute workflow triggers based on status transition
 */
export async function executeStatusWorkflows(
  listingId: string,
  fromStatus: ListingStatus,
  toStatus: ListingStatus,
  agentId: string,
  contactId?: string,
  metadata?: Record<string, any>
) {
  // Map status transitions to workflows
  const workflowMap: Record<string, () => Promise<void>> = {
    'draft->active': () => triggerListingWentLiveWorkflow(listingId, agentId, metadata),
    'active->pending': () => triggerOfferAcceptedWorkflow(listingId, agentId, contactId!, metadata),
    'pending->under_contract': () => triggerUnderContractWorkflow(listingId, agentId, contactId!, metadata),
    'under_contract->sold': () => triggerSaleClosedWorkflow(listingId, agentId, contactId!, metadata),
    'active->expired': () => triggerListingExpiredWorkflow(listingId, agentId, contactId!, metadata),
    'active->withdrawn': () => triggerListingWithdrawnWorkflow(listingId, agentId, contactId!, metadata),
    'pending->withdrawn': () => triggerListingWithdrawnWorkflow(listingId, agentId, contactId!, metadata),
    'under_contract->active': () => triggerBackOnMarketWorkflow(listingId, agentId, contactId!, metadata),
    'pending->active': () => triggerBackOnMarketWorkflow(listingId, agentId, contactId!, metadata),
    'expired->active': () => triggerListingRenewedWorkflow(listingId, agentId, contactId!, metadata),
    'withdrawn->active': () => triggerListingRelistedWorkflow(listingId, agentId, contactId!, metadata)
  }

  const transitionKey = `${fromStatus}->${toStatus}`
  const workflowFn = workflowMap[transitionKey]

  if (workflowFn) {
    try {
      await workflowFn()
    } catch (error: any) {
      console.error('[v0] Workflow execution error:', error)
      await logError('WORKFLOW_EXECUTION_ERROR', error.message, {
        listing_id: listingId,
        transition: transitionKey
      })
    }
  }
}
