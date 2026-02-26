/**
 * System 5.1: Buyer Core Execution Engine
 * 
 * Orchestrates buyer journey from contact → search → tour → offer → close
 * Enforces financial verification gates
 * Powers progress tracking and buyer-facing journey UI
 * Integrates with voice assistant
 * 
 * CONSTRAINTS:
 * - READ: contacts, activities, conversations, conversation_insights, documents, listings
 * - WRITE: activities (ALL events/signals)
 * - NO new tables, NO new columns
 * - Lifecycle is INFERRED from activities
 */

import { createServiceClient } from '@/lib/supabase/service'
import {
  checkFinancialVerification,
  isSystemGateEnabled,
  type FinancialVerificationResult,
  type BuyerState,
} from '@/lib/buyer-lifecycle'
import { getCurrentState } from '@/lib/buyer-lifecycle/transition-validator'

export interface BuyerExecutionContext {
  contactId: string
  userId?: string // User performing action (agent, lender, admin)
  source: 'buyer_portal' | 'voice_assistant' | 'agent_action' | 'automation' | 'lender_update'
}

export interface BuyerJourneyStatus {
  contactId: string
  currentState: BuyerState
  financialVerification: FinancialVerificationResult
  systemGatesEnabled: string[]
  canSearch: boolean
  canTour: boolean
  canOffer: boolean
  progressPercentage: number
  nextSteps: string[]
  blockers: string[]
  milestones: {
    state: string
    completed: boolean
    completedAt?: Date
  }[]
}

/**
 * Get complete buyer journey status
 * Powers progress bars, journey UI, and gate enforcement
 */
export async function getBuyerJourneyStatus(
  context: BuyerExecutionContext
): Promise<{ success: boolean; status?: BuyerJourneyStatus; error?: string }> {
  const { contactId } = context
  
  try {
    const supabase = createServiceClient()
    
    // 1. Get current state (inferred from activities)
    const currentStateResult = await getCurrentState(contactId)
    
    if (!currentStateResult.success || !currentStateResult.currentState) {
      return {
        success: false,
        error: 'Unable to determine buyer state'
      }
    }
    
    const currentState = currentStateResult.currentState
    
    // 2. Check financial verification
    const financialVerification = await checkFinancialVerification({ contactId })
    
    // 3. Determine system gates enabled
    const systemGatesEnabled = isSystemGateEnabled(currentState, 'property_search') ? ['property_search'] : []
    if (isSystemGateEnabled(currentState, 'tour_scheduling')) {
      systemGatesEnabled.push('tour_scheduling')
    }
    if (isSystemGateEnabled(currentState, 'offer_creation')) {
      systemGatesEnabled.push('offer_creation')
    }
    
    // 4. Determine what buyer CAN do
    const canSearch = financialVerification.isVerified && 
      (currentState === 'BUYER_FINANCIALLY_VERIFIED' || 
       currentState === 'BUYER_SEARCH_CONFIGURED' || 
       currentState === 'BUYER_SEARCHING' ||
       currentState === 'BUYER_TOUR_ELIGIBLE' ||
       currentState === 'BUYER_TOURING' ||
       currentState === 'BUYER_OFFER_ELIGIBLE' ||
       currentState === 'BUYER_OFFER_SUBMITTED')
    
    const canTour = financialVerification.isVerified && 
      (currentState === 'BUYER_TOUR_ELIGIBLE' || 
       currentState === 'BUYER_TOURING' ||
       currentState === 'BUYER_OFFER_ELIGIBLE' ||
       currentState === 'BUYER_OFFER_SUBMITTED')
    
    const canOffer = financialVerification.isVerified && 
      (currentState === 'BUYER_OFFER_ELIGIBLE' || 
       currentState === 'BUYER_OFFER_SUBMITTED')
    
    // 5. Calculate progress percentage
    const stateProgress: Record<BuyerState, number> = {
      'BUYER_CONTACT_CREATED': 5,
      'BUYER_FINANCIALLY_VERIFIED': 15,
      'BUYER_SEARCH_CONFIGURED': 25,
      'BUYER_SEARCHING': 35,
      'BUYER_TOUR_ELIGIBLE': 45,
      'BUYER_TOURING': 55,
      'BUYER_OFFER_ELIGIBLE': 65,
      'BUYER_OFFER_SUBMITTED': 75,
      'BUYER_UNDER_CONTRACT': 85,
      'BUYER_ON_HOLD': 30,
      'BUYER_DISENGAGED': 10,
      'BUYER_CLOSED': 100,
      'BUYER_LIFETIME': 100,
    }
    
    const progressPercentage = stateProgress[currentState] || 0
    
    // 6. Determine next steps and blockers
    const nextSteps: string[] = []
    const blockers: string[] = []
    
    if (!financialVerification.isVerified) {
      blockers.push('Financial verification required before searching')
      nextSteps.push('Upload pre-approval letter or proof of funds')
    } else if (currentState === 'BUYER_CONTACT_CREATED') {
      nextSteps.push('Complete financial verification to start searching')
    } else if (currentState === 'BUYER_FINANCIALLY_VERIFIED') {
      nextSteps.push('Configure your search preferences')
    } else if (currentState === 'BUYER_SEARCH_CONFIGURED') {
      nextSteps.push('Start viewing properties that match your criteria')
    } else if (currentState === 'BUYER_SEARCHING') {
      nextSteps.push('Schedule tours for properties you like')
    } else if (currentState === 'BUYER_TOUR_ELIGIBLE' || currentState === 'BUYER_TOURING') {
      nextSteps.push('Continue viewing properties')
      nextSteps.push('When ready, prepare to submit an offer')
    } else if (currentState === 'BUYER_OFFER_ELIGIBLE') {
      nextSteps.push('Work with your agent to prepare an offer')
    } else if (currentState === 'BUYER_OFFER_SUBMITTED') {
      nextSteps.push('Wait for seller response')
    } else if (currentState === 'BUYER_UNDER_CONTRACT') {
      nextSteps.push('Complete inspections and contingencies')
    }
    
    // 7. Get milestone completion status
    const milestoneStates: BuyerState[] = [
      'BUYER_CONTACT_CREATED',
      'BUYER_FINANCIALLY_VERIFIED',
      'BUYER_SEARCHING',
      'BUYER_TOURING',
      'BUYER_OFFER_SUBMITTED',
      'BUYER_UNDER_CONTRACT',
      'BUYER_CLOSED',
    ]
    
    // Query activities for milestone completion dates
    const { data: milestoneEvents } = await supabase
      .from('activities')
      .select('type, created_at')
      .eq('entity_type', 'contact')
      .eq('entity_id', contactId)
      .in('type', [
        'buyer.lifecycle.transitioned',
      ])
      .order('created_at', { ascending: true })
    
    const milestones = milestoneStates.map(state => {
      const stateIndex = milestoneStates.indexOf(currentState)
      const milestoneIndex = milestoneStates.indexOf(state)
      const completed = milestoneIndex <= stateIndex
      
      // Find completion date from events
      let completedAt: Date | undefined
      if (milestoneEvents) {
        const event = milestoneEvents.find(e => {
          const metadata = e.type === 'buyer.lifecycle.transitioned' && e.metadata
          return metadata && typeof metadata === 'object' && 'to_state' in metadata && metadata.to_state === state
        })
        if (event) {
          completedAt = new Date(event.created_at)
        }
      }
      
      return {
        state,
        completed,
        completedAt,
      }
    })
    
    return {
      success: true,
      status: {
        contactId,
        currentState,
        financialVerification,
        systemGatesEnabled,
        canSearch,
        canTour,
        canOffer,
        progressPercentage,
        nextSteps,
        blockers,
        milestones,
      }
    }
  } catch (error) {
    console.error('[buyer-execution] Error getting journey status:', error)
    return {
      success: false,
      error: 'Failed to get journey status'
    }
  }
}

/**
 * Enforce financial verification gate
 * Called before ANY search, tour, or offer action
 */
export async function enforceFinancialGate(
  context: BuyerExecutionContext,
  action: 'search' | 'tour' | 'offer'
): Promise<{ allowed: boolean; reason?: string; verification?: FinancialVerificationResult }> {
  const { contactId } = context
  
  const verification = await checkFinancialVerification({ contactId })
  
  if (!verification.isVerified) {
    return {
      allowed: false,
      reason: `Financial verification required before ${action}`,
      verification
    }
  }
  
  // Check expiration
  if (verification.expiresAt && new Date() > verification.expiresAt) {
    return {
      allowed: false,
      reason: 'Financial verification has expired',
      verification
    }
  }
  
  return {
    allowed: true,
    verification
  }
}

/**
 * Get buyer-friendly journey message
 * Used in buyer portal and voice assistant
 */
export function getBuyerFriendlyMessage(status: BuyerJourneyStatus): {
  greeting: string
  statusMessage: string
  nextAction: string
  encouragement: string
} {
  const { currentState, progressPercentage, nextSteps, blockers } = status
  
  const greeting = `You're ${progressPercentage}% through your home buying journey!`
  
  let statusMessage = ''
  if (currentState === 'BUYER_CONTACT_CREATED') {
    statusMessage = "Welcome! Let's get you started on finding your perfect home."
  } else if (currentState === 'BUYER_FINANCIALLY_VERIFIED') {
    statusMessage = "Great! You're financially verified. Now let's set up your search."
  } else if (currentState === 'BUYER_SEARCHING') {
    statusMessage = "You're actively searching. We're finding homes that match what you're looking for."
  } else if (currentState === 'BUYER_TOURING') {
    statusMessage = "You're viewing properties. Take your time to find the right one."
  } else if (currentState === 'BUYER_OFFER_SUBMITTED') {
    statusMessage = "Your offer is submitted! We'll keep you updated on the seller's response."
  } else if (currentState === 'BUYER_UNDER_CONTRACT') {
    statusMessage = "Congratulations! You're under contract. Let's get to closing."
  } else if (currentState === 'BUYER_CLOSED') {
    statusMessage = "Congratulations on your new home!"
  }
  
  const nextAction = blockers.length > 0 
    ? blockers[0] 
    : nextSteps.length > 0 
      ? nextSteps[0] 
      : "Stay in touch with your agent"
  
  const encouragement = progressPercentage < 50
    ? "You're making great progress!"
    : progressPercentage < 85
      ? "You're almost there!"
      : "The finish line is in sight!"
  
  return {
    greeting,
    statusMessage,
    nextAction,
    encouragement
  }
}

/**
 * Log buyer execution event
 * Standardized logging for all buyer actions
 */
export async function logBuyerExecutionEvent(params: {
  contactId: string
  eventType: string
  userId?: string
  source: string
  metadata?: Record<string, unknown>
}): Promise<{ success: boolean; error?: string }> {
  const { contactId, eventType, userId, source, metadata } = params
  const supabase = createServiceClient()
  
  const { error } = await supabase.from('activities').insert({
    type: eventType,
    entity_type: 'contact',
    entity_id: contactId,
    user_id: userId,
    metadata: {
      ...metadata,
      source,
      timestamp: new Date().toISOString(),
    }
  })
  
  if (error) {
    console.error('[buyer-execution] Error logging event:', error)
    return { success: false, error: error.message }
  }
  
  return { success: true }
}
