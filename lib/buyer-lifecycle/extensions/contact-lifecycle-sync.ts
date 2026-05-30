/**
 * System 5.1D: Buyer Lifecycle Governance Hardening
 * Extension 7: Contact Lifecycle Synchronization
 * 
 * Emits sync signals to keep buyer lifecycle aligned with contact lifecycle.
 * Ensures journeys, CRM views, and analytics stay in sync.
 */

import { createServiceClient } from "@/lib/supabase/service"
import type { BuyerState } from "../lifecycle-definitions"

export type ContactSyncTrigger = "buyer_engaged" | "buyer_under_contract" | "buyer_lifetime"

/**
 * States that trigger contact lifecycle sync
 */
export const CONTACT_SYNC_STATES: BuyerState[] = [
  "BUYER_FINANCIALLY_VERIFIED", // Maps to ENGAGED
  "BUYER_UNDER_CONTRACT", // Maps to UNDER_CONTRACT
  "BUYER_LIFETIME", // Maps to LIFETIME_CUSTOMER
]

/**
 * Map buyer state to contact lifecycle stage
 */
export function mapBuyerStateToContactStage(buyerState: BuyerState): string | null {
  const stageMap: Record<BuyerState, string | null> = {
    BUYER_CONTACT_CREATED: "lead",
    BUYER_FINANCIALLY_VERIFIED: "qualified",
    BUYER_SEARCH_CONFIGURED: "engaged",
    BUYER_SEARCHING: "engaged",
    BUYER_TOUR_ELIGIBLE: "engaged",
    BUYER_TOURING: "active",
    BUYER_OFFER_ELIGIBLE: "active",
    BUYER_OFFER_SUBMITTED: "under_negotiation",
    BUYER_UNDER_CONTRACT: "under_contract",
    BUYER_ON_HOLD: "on_hold",
    BUYER_DISENGAGED: "disengaged",
    BUYER_CLOSED: "closed",
    BUYER_LIFETIME: "lifetime_customer",
  }

  return stageMap[buyerState] || null
}

/**
 * Check if buyer state should trigger contact sync
 */
export function shouldTriggerContactSync(buyerState: BuyerState): boolean {
  return CONTACT_SYNC_STATES.includes(buyerState)
}

/**
 * Emit contact lifecycle sync signal
 */
export async function emitContactLifecycleSync(params: {
  contactId: string
  buyerState: BuyerState
  userId: string
  metadata?: Record<string, unknown>
}): Promise<{ success: boolean; error?: string; activityId?: string }> {
  const { contactId, buyerState, userId, metadata } = params

  const contactStage = mapBuyerStateToContactStage(buyerState)

  if (!contactStage) {
    return {
      success: false,
      error: `No contact stage mapping for buyer state: ${buyerState}`,
    }
  }

  const supabase = createServiceClient()

  const { data, error } = await supabase
    .from("activities")
    .insert({
      activity_type: "contact.lifecycle.sync",
      entity_type: "contact",
      entity_id: contactId,
      agent_user_id: userId,
      metadata: {
        buyer_state: buyerState,
        contact_stage: contactStage,
        source: "buyer_lifecycle",
        ...metadata,
      },
    })
    .select("id")
    .single()

  if (error) {
    console.error("[5.1D] Error emitting contact lifecycle sync:", error)
    return { success: false, error: error.message }
  }

  return { success: true, activityId: data?.id }
}

// Agent task (correct location, no changes) — type: buyer.engagement.signal, buyer.under_contract.signal, buyer.lifetime.signal
/**
 * Emit buyer engagement signal (FINANCIALLY_VERIFIED reached)
 */
export async function emitBuyerEngagementSignal(params: {
  contactId: string
  userId: string
  verificationType: string
  maxBudget?: number
}): Promise<{ success: boolean; error?: string }> {
  const { contactId, userId, verificationType, maxBudget } = params

  const supabase = createServiceClient()

  const { error } = await supabase.from("activities").insert({
    activity_type: "buyer.engagement.signal",
    entity_type: "contact",
    entity_id: contactId,
    agent_user_id: userId,
    metadata: {
      trigger: "financial_verification_complete",
      verification_type: verificationType,
      max_budget: maxBudget,
      contact_stage: "qualified",
    },
  })

  if (error) {
    console.error("[5.1D] Error emitting buyer engagement signal:", error)
    return { success: false, error: error.message }
  }

  return { success: true }
}

/**
 * Emit buyer under contract signal
 */
export async function emitBuyerUnderContractSignal(params: {
  contactId: string
  listingId: string
  offerId: string
  userId: string
}): Promise<{ success: boolean; error?: string }> {
  const { contactId, listingId, offerId, userId } = params

  const supabase = createServiceClient()

  const { error } = await supabase.from("activities").insert({
    activity_type: "buyer.under_contract.signal",
    entity_type: "contact",
    entity_id: contactId,
    agent_user_id: userId,
    metadata: {
      listing_id: listingId,
      offer_id: offerId,
      contact_stage: "under_contract",
    },
  })

  if (error) {
    console.error("[5.1D] Error emitting buyer under contract signal:", error)
    return { success: false, error: error.message }
  }

  return { success: true }
}

/**
 * Emit buyer lifetime signal
 */
export async function emitBuyerLifetimeSignal(params: {
  contactId: string
  transactionId: string
  userId: string
}): Promise<{ success: boolean; error?: string }> {
  const { contactId, transactionId, userId } = params

  const supabase = createServiceClient()

  const { error } = await supabase.from("activities").insert({
    activity_type: "buyer.lifetime.signal",
    entity_type: "contact",
    entity_id: contactId,
    agent_user_id: userId,
    metadata: {
      transaction_id: transactionId,
      contact_stage: "lifetime_customer",
    },
  })

  if (error) {
    console.error("[5.1D] Error emitting buyer lifetime signal:", error)
    return { success: false, error: error.message }
  }

  return { success: true }
}

/**
 * Query contact sync history
 */
export interface ContactSyncEvent {
  id: string
  buyerState: BuyerState
  contactStage: string
  occurredAt: Date
  userId: string
}

export async function getContactSyncHistory(
  contactId: string,
  options?: { limit?: number }
): Promise<ContactSyncEvent[]> {
  const { limit = 20 } = options || {}
  const supabase = createServiceClient()

  const { data: events, error } = await supabase
    .from("activities")
    .select("id, created_at, user_id, metadata")
    .eq("type", "contact.lifecycle.sync")
    .eq("entity_type", "contact")
    .eq("entity_id", contactId)
    .order("created_at", { ascending: false })
    .limit(limit)

  if (error) {
    console.error("[5.1D] Error querying contact sync history:", error)
    return []
  }

  if (!events) {
    return []
  }

  return events.map((event) => {
    const metadata = (event.metadata as Record<string, unknown>) || {}
    return {
      id: event.id,
      buyerState: metadata.buyer_state as BuyerState,
      contactStage: metadata.contact_stage as string,
      occurredAt: new Date(event.created_at),
      userId: event.user_id || "system",
    }
  })
}

/**
 * Get most recent contact sync
 */
export async function getMostRecentContactSync(contactId: string): Promise<ContactSyncEvent | null> {
  const history = await getContactSyncHistory(contactId, { limit: 1 })
  return history.length > 0 ? history[0] : null
}

/**
 * Check if contact sync is needed (buyer state changed but no sync emitted)
 */
export interface SyncCheckResult {
  syncNeeded: boolean
  currentBuyerState?: BuyerState
  currentContactStage?: string
  lastSyncDate?: Date
}

export async function checkContactSyncStatus(contactId: string): Promise<SyncCheckResult> {
  // Get current buyer state
  const { getCurrentBuyerState } = require("../lifecycle-logger")
  const currentBuyerState = await getCurrentBuyerState(contactId)

  if (!currentBuyerState) {
    return { syncNeeded: false }
  }

  // Check if this state requires sync
  if (!shouldTriggerContactSync(currentBuyerState)) {
    return {
      syncNeeded: false,
      currentBuyerState,
    }
  }

  // Get most recent sync
  const lastSync = await getMostRecentContactSync(contactId)

  // If no sync exists for this state, sync needed
  if (!lastSync || lastSync.buyerState !== currentBuyerState) {
    return {
      syncNeeded: true,
      currentBuyerState,
      currentContactStage: mapBuyerStateToContactStage(currentBuyerState) || undefined,
      lastSyncDate: lastSync?.occurredAt,
    }
  }

  return {
    syncNeeded: false,
    currentBuyerState,
    currentContactStage: lastSync.contactStage,
    lastSyncDate: lastSync.occurredAt,
  }
}

/**
 * Batch emit contact sync signals for multiple buyers
 */
export async function batchEmitContactSyncs(
  params: Array<{
    contactId: string
    buyerState: BuyerState
    userId: string
  }>
): Promise<{
  success: boolean
  successCount: number
  failureCount: number
  errors: Array<{ contactId: string; error: string }>
}> {
  let successCount = 0
  let failureCount = 0
  const errors: Array<{ contactId: string; error: string }> = []

  for (const item of params) {
    const result = await emitContactLifecycleSync(item)
    if (result.success) {
      successCount++
    } else {
      failureCount++
      errors.push({
        contactId: item.contactId,
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
