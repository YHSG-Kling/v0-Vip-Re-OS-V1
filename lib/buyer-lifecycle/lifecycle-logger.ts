/**
 * System 5.1C: Buyer Lifecycle Governance Core - Lifecycle Logger
 * 
 * Emits lifecycle transition events to activities table.
 * Every state transition MUST be logged for auditability.
 * 
 * This is GOVERNANCE ONLY - only logs events, does not execute transitions
 */

import { createServiceClient } from "@/lib/supabase/service"
import type { BuyerState } from "./lifecycle-definitions"

export interface LifecycleTransitionEvent {
  contactId: string
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
 * Emit a lifecycle transition event to activities table
 */
export async function emitLifecycleTransition(
  event: LifecycleTransitionEvent
): Promise<{ success: boolean; error?: string; activityId?: string }> {
  const {
    contactId,
    fromState,
    toState,
    triggeredBy,
    authorityRole,
    userId,
    sourceSystem,
    overrideReason,
    metadata,
  } = event
  
  const supabase = createServiceClient()
  
  const { data, error } = await supabase
    .from("activities")
    .insert({
      type: "buyer.lifecycle.transition",
      entity_type: "contact",
      entity_id: contactId,
      user_id: userId,
      metadata: {
        from_state: fromState,
        to_state: toState,
        triggered_by: triggeredBy,
        authority_role: authorityRole,
        source_system: sourceSystem,
        override_reason: overrideReason,
        ...metadata,
      },
    })
    .select("id")
    .single()
  
  if (error) {
    console.error("[buyer-lifecycle] Error emitting lifecycle transition:", error)
    return { success: false, error: error.message }
  }
  
  return { success: true, activityId: data?.id }
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
