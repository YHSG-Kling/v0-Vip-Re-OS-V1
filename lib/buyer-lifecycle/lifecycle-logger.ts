/**
 * System 5.1C: Buyer Lifecycle Governance Core - Lifecycle Logger
 * 
 * Emits lifecycle transition events to activities table.
 * Every state transition MUST be logged for auditability.
 * 
 * This is GOVERNANCE ONLY - only logs events, does not execute transitions
 */

import { transitionLifecycle } from "@/lib/kernel/lifecycle"
import { KernelEvent }         from "@/lib/kernel/events"
import { createServiceClient } from "@/lib/supabase/service"
import type { BuyerState } from "./lifecycle-definitions"

export interface LifecycleTransitionEvent {
  contactId: string
  brokerageId: string
  fromState: BuyerState | null
  toState: BuyerState
  triggeredBy: "agent" | "system" | "ai_isa" | "voice"
  authorityRole: string
  userId: string
  sourceSystem: string
  overrideReason?: string
  metadata?: Record<string, unknown>
}

/**
 * Emit a lifecycle transition event — routes through transitionLifecycle()
 * which writes lifecycle_events + updates contacts.buyer_stage atomically,
 * then fires the kernel event for downstream automation.
 */
export async function emitLifecycleTransition(
  event: LifecycleTransitionEvent
): Promise<{ success: boolean; error?: string }> {
  const { contactId, brokerageId, fromState, toState, userId, metadata } = event

  // Map buyer state transition to the correct kernel event
  const eventType = resolveBuyerKernelEvent(toState)

  try {
    const result = await transitionLifecycle({
      entityType:  "buyer_lifecycle",
      entityId:    contactId,
      fromState:   fromState ?? "prospect",
      toState,
      eventType,
      actorUserId: userId,
      brokerageId,
      metadata: {
        triggered_by:   event.triggeredBy,
        authority_role: event.authorityRole,
        source_system:  event.sourceSystem,
        override_reason: event.overrideReason,
        ...metadata,
      },
    })
    if (!result.success) {
      return { success: false, error: result.error }
    }
    return { success: true }
  } catch (err: any) {
    console.error("[buyer-lifecycle] emitLifecycleTransition failed:", err)
    return { success: false, error: err.message }
  }
}

function resolveBuyerKernelEvent(toState: BuyerState): KernelEvent {
  const map: Partial<Record<BuyerState, KernelEvent>> = {
    BUYER_FINANCIALLY_VERIFIED: KernelEvent.BUYER_FINANCIALLY_VERIFIED,
    BUYER_SEARCH_CONFIGURED:    KernelEvent.BUYER_SEARCH_CONFIGURED,
    BUYER_SEARCHING:            KernelEvent.BUYER_SEARCH_EXECUTED,
    BUYER_TOUR_ELIGIBLE:        KernelEvent.TOUR_ELIGIBLE,
    BUYER_TOURING:              KernelEvent.TOUR_PLANNED,
    BUYER_OFFER_ELIGIBLE:       KernelEvent.OFFER_ELIGIBLE,
    BUYER_OFFER_SUBMITTED:      KernelEvent.OFFER_SUBMITTED,
    BUYER_UNDER_CONTRACT:       KernelEvent.CONTRACT_SIGNED,
    BUYER_ON_HOLD:              KernelEvent.DEAL_ON_HOLD,
    BUYER_DISENGAGED:           KernelEvent.BUYER_DISENGAGED,
    BUYER_CLOSED:               KernelEvent.DEAL_CLOSED,
    BUYER_LIFETIME:             KernelEvent.LIFETIME_CUSTOMER,
  }
  return map[toState] ?? KernelEvent.BUYER_STATE_CHANGED
}

/**
 * Get lifecycle history for a buyer
 */
export interface LifecycleHistoryEntry {
  id: string
  fromState: BuyerState | null
  toState: BuyerState
  occurredAt: Date
  triggeredBy: string
  authorityRole: string
  userId: string
  sourceSystem: string
  overrideReason?: string
}

export async function getLifecycleHistory(
  contactId: string,
  options?: {
    limit?: number
    startDate?: Date
    endDate?: Date
  }
): Promise<LifecycleHistoryEntry[]> {
  const { limit = 100, startDate, endDate } = options || {}
  const supabase = createServiceClient()
  
  let query = supabase
    .from("activities")
    .select("id, created_at, user_id, metadata")
    .eq("type", "buyer.lifecycle.transition")
    .eq("entity_type", "contact")
    .eq("entity_id", contactId)
    .order("created_at", { ascending: false })
    .limit(limit)
  
  if (startDate) {
    query = query.gte("created_at", startDate.toISOString())
  }
  
  if (endDate) {
    query = query.lte("created_at", endDate.toISOString())
  }
  
  const { data: events, error } = await query
  
  if (error) {
    console.error("[buyer-lifecycle] Error fetching lifecycle history:", error)
    return []
  }
  
  if (!events) {
    return []
  }
  
  return events.map((event) => {
    const metadata = (event.metadata as Record<string, unknown>) || {}
    return {
      id: event.id,
      fromState: (metadata.from_state as BuyerState) || null,
      toState: metadata.to_state as BuyerState,
      occurredAt: new Date(event.created_at),
      triggeredBy: (metadata.triggered_by as string) || "unknown",
      authorityRole: (metadata.authority_role as string) || "unknown",
      userId: event.user_id || "system",
      sourceSystem: (metadata.source_system as string) || "unknown",
      overrideReason: metadata.override_reason as string | undefined,
    }
  })
}

/**
 * Get current buyer state (most recent transition)
 */
export async function getCurrentBuyerState(contactId: string): Promise<BuyerState | null> {
  const history = await getLifecycleHistory(contactId, { limit: 1 })
  
  if (history.length === 0) {
    return null
  }
  
  return history[0].toState
}

/**
 * Get lifecycle statistics for brokerage
 */
export interface LifecycleStatistics {
  totalBuyers: number
  byState: Record<BuyerState, number>
  averageTimeToVerification?: number // days
  averageTimeToContract?: number // days
  conversionRate?: number // percentage who reach UNDER_CONTRACT
}

export async function getLifecycleStatistics(
  brokerageId: string,
  options?: {
    startDate?: Date
    endDate?: Date
  }
): Promise<LifecycleStatistics> {
  const { startDate, endDate } = options || {}
  const supabase = createServiceClient()
  
  // Get all buyers for brokerage
  let contactQuery = supabase
    .from("contacts")
    .select("id")
    .eq("brokerage_id", brokerageId)
  
  if (startDate) {
    contactQuery = contactQuery.gte("created_at", startDate.toISOString())
  }
  
  if (endDate) {
    contactQuery = contactQuery.lte("created_at", endDate.toISOString())
  }
  
  const { data: contacts, error: contactError } = await contactQuery
  
  if (contactError || !contacts) {
    console.error("[buyer-lifecycle] Error fetching contacts:", contactError)
    return {
      totalBuyers: 0,
      byState: {} as Record<BuyerState, number>,
    }
  }
  
  const contactIds = contacts.map((c) => c.id)
  
  // Get current states for all buyers
  const byState: Record<string, number> = {}
  
  for (const contactId of contactIds) {
    const currentState = await getCurrentBuyerState(contactId)
    if (currentState) {
      byState[currentState] = (byState[currentState] || 0) + 1
    }
  }
  
  return {
    totalBuyers: contactIds.length,
    byState: byState as Record<BuyerState, number>,
    // TODO: Calculate timing metrics from history
  }
}

/**
 * Get buyers in specific state
 */
export async function getBuyersInState(
  brokerageId: string,
  state: BuyerState,
  options?: {
    limit?: number
  }
): Promise<string[]> {
  const { limit = 100 } = options || {}
  const supabase = createServiceClient()
  
  // Get all contacts for brokerage
  const { data: contacts, error } = await supabase
    .from("contacts")
    .select("id")
    .eq("brokerage_id", brokerageId)
    .limit(limit)
  
  if (error || !contacts) {
    return []
  }
  
  // Filter by current state
  const buyersInState: string[] = []
  
  for (const contact of contacts) {
    const currentState = await getCurrentBuyerState(contact.id)
    if (currentState === state) {
      buyersInState.push(contact.id)
    }
  }
  
  return buyersInState
}

/**
 * Batch emit lifecycle transitions (for migration/admin tools)
 */
export async function batchEmitLifecycleTransitions(
  events: LifecycleTransitionEvent[]
): Promise<{
  success: boolean
  successCount: number
  failureCount: number
  errors: Array<{ contactId: string; error: string }>
}> {
  let successCount = 0
  let failureCount = 0
  const errors: Array<{ contactId: string; error: string }> = []
  
  for (const event of events) {
    const result = await emitLifecycleTransition(event)
    if (result.success) {
      successCount++
    } else {
      failureCount++
      errors.push({
        contactId: event.contactId,
        error: result.error || "Unknown error",
      })
    }
  }
  
  return {
    success: failureCount === 0,
    successCount,
    failureCount,
    errors,
  }
}
