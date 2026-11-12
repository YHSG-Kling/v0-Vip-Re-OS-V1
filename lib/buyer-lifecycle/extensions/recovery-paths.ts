/**
 * System 5.1D: Buyer Lifecycle Governance Hardening
 * Extension 4 & 5: ON_HOLD Recovery & DISENGAGED Re-engagement
 * 
 * Explicit recovery paths from ON_HOLD and DISENGAGED states.
 * All recoveries require triggering events with authority.
 */

import { createServiceClient } from "@/lib/supabase/service"
import { getCurrentBuyerState } from "../lifecycle-logger"
import { getEnhancedVerificationStatus } from "./financial-verification-schema"

export type RecoveryPath =
  | "ON_HOLD_TO_FINANCIALLY_VERIFIED"
  | "ON_HOLD_TO_SEARCH_CONFIGURED"
  | "ON_HOLD_TO_DISENGAGED"
  | "DISENGAGED_TO_ENGAGED"

export type RecoveryTrigger = "new_approval" | "criteria_update" | "timeout" | "buyer_initiated" | "agent_reactivation"

export interface RecoveryValidation {
  allowed: boolean
  recoveryPath: RecoveryPath
  reason?: string
  requiresFinancialVerification?: boolean
}

/**
 * Validate ON_HOLD recovery path
 */
export async function validateOnHoldRecovery(
  contactId: string,
  targetState: "BUYER_FINANCIALLY_VERIFIED" | "BUYER_SEARCH_CONFIGURED" | "BUYER_DISENGAGED",
  trigger: RecoveryTrigger
): Promise<RecoveryValidation> {
  const currentState = await getCurrentBuyerState(contactId)

  if (currentState !== "BUYER_ON_HOLD") {
    return {
      allowed: false,
      recoveryPath: `ON_HOLD_TO_${targetState.replace("BUYER_", "")}` as RecoveryPath,
      reason: `Buyer is not in ON_HOLD state (current: ${currentState})`,
    }
  }

  // Path 1: ON_HOLD → FINANCIALLY_VERIFIED
  if (targetState === "BUYER_FINANCIALLY_VERIFIED") {
    if (trigger !== "new_approval") {
      return {
        allowed: false,
        recoveryPath: "ON_HOLD_TO_FINANCIALLY_VERIFIED",
        reason: "Recovery to FINANCIALLY_VERIFIED requires 'new_approval' trigger",
      }
    }

    // Check if new verification exists
    const verification = await getEnhancedVerificationStatus(contactId)
    if (!verification.isVerified || verification.isExpired) {
      return {
        allowed: false,
        recoveryPath: "ON_HOLD_TO_FINANCIALLY_VERIFIED",
        reason: "New financial verification required",
        requiresFinancialVerification: true,
      }
    }

    return {
      allowed: true,
      recoveryPath: "ON_HOLD_TO_FINANCIALLY_VERIFIED",
    }
  }

  // Path 2: ON_HOLD → SEARCH_CONFIGURED
  if (targetState === "BUYER_SEARCH_CONFIGURED") {
    if (trigger !== "criteria_update") {
      return {
        allowed: false,
        recoveryPath: "ON_HOLD_TO_SEARCH_CONFIGURED",
        reason: "Recovery to SEARCH_CONFIGURED requires 'criteria_update' trigger",
      }
    }

    // Check financial verification
    const verification = await getEnhancedVerificationStatus(contactId)
    if (!verification.isVerified || verification.isExpired) {
      return {
        allowed: false,
        recoveryPath: "ON_HOLD_TO_SEARCH_CONFIGURED",
        reason: "Valid financial verification required",
        requiresFinancialVerification: true,
      }
    }

    return {
      allowed: true,
      recoveryPath: "ON_HOLD_TO_SEARCH_CONFIGURED",
    }
  }

  // Path 3: ON_HOLD → DISENGAGED
  if (targetState === "BUYER_DISENGAGED") {
    if (trigger !== "timeout") {
      return {
        allowed: false,
        recoveryPath: "ON_HOLD_TO_DISENGAGED",
        reason: "Recovery to DISENGAGED requires 'timeout' trigger",
      }
    }

    return {
      allowed: true,
      recoveryPath: "ON_HOLD_TO_DISENGAGED",
    }
  }

  return {
    allowed: false,
    recoveryPath: `ON_HOLD_TO_${(targetState as string).replace("BUYER_", "")}` as RecoveryPath,
    reason: "Invalid target state for ON_HOLD recovery",
  }
}

/**
 * Validate DISENGAGED re-engagement
 */
export async function validateDisengagedReengagement(params: {
  contactId: string
  trigger: RecoveryTrigger
  userId: string
  userRole: string
  source: "buyer" | "agent"
}): Promise<RecoveryValidation> {
  const { contactId, trigger, userRole, source } = params

  const currentState = await getCurrentBuyerState(contactId)

  if (currentState !== "BUYER_DISENGAGED") {
    return {
      allowed: false,
      recoveryPath: "DISENGAGED_TO_ENGAGED",
      reason: `Buyer is not in DISENGAGED state (current: ${currentState})`,
    }
  }

  // Rule 1: Buyer-initiated interaction
  if (source === "buyer" && trigger === "buyer_initiated") {
    return {
      allowed: true,
      recoveryPath: "DISENGAGED_TO_ENGAGED",
    }
  }

  // Rule 2: Agent-authorized reactivation
  if (source === "agent" && trigger === "agent_reactivation") {
    const allowedRoles = ["agent", "team_lead", "broker", "admin"]
    if (!allowedRoles.includes(userRole.toLowerCase())) {
      return {
        allowed: false,
        recoveryPath: "DISENGAGED_TO_ENGAGED",
        reason: `Role "${userRole}" is not authorized to reactivate disengaged buyers`,
      }
    }

    return {
      allowed: true,
      recoveryPath: "DISENGAGED_TO_ENGAGED",
    }
  }

  return {
    allowed: false,
    recoveryPath: "DISENGAGED_TO_ENGAGED",
    reason: "Invalid trigger or source for DISENGAGED re-engagement",
  }
}

/**
 * Emit recovery event
 */
export async function emitRecoveryEvent(params: {
  contactId: string
  fromState: "BUYER_ON_HOLD" | "BUYER_DISENGAGED"
  toState: string
  recoveryPath: RecoveryPath
  trigger: RecoveryTrigger
  userId: string
  reason?: string
  metadata?: Record<string, unknown>
}): Promise<{ success: boolean; error?: string; activityId?: string }> {
  const { contactId, fromState, toState, recoveryPath, trigger, userId, reason, metadata } = params

  const supabase = createServiceClient()

  const { data, error } = await supabase
    .from("activities")
    .insert({
      activity_type: "buyer.lifecycle.recovery",
      entity_type: "contact",
      entity_id: contactId,
      agent_user_id: userId,
      metadata: {
        from_state: fromState,
        to_state: toState,
        recovery_path: recoveryPath,
        trigger,
        reason,
        ...metadata,
      },
    })
    .select("id")
    .single()

  if (error) {
    console.error("[5.1D] Error emitting recovery event:", error)
    return { success: false, error: error.message }
  }

  return { success: true, activityId: data?.id }
}

/**
 * Emit re-engagement event
 */
export async function emitReengagementEvent(params: {
  contactId: string
  trigger: RecoveryTrigger
  source: "buyer" | "agent"
  userId: string
  reason?: string
}): Promise<{ success: boolean; error?: string; activityId?: string }> {
  const { contactId, trigger, source, userId, reason } = params

  const supabase = createServiceClient()

  const { data, error } = await supabase
    .from("activities")
    .insert({
      activity_type: "buyer.lifecycle.reengaged",
      entity_type: "contact",
      entity_id: contactId,
      agent_user_id: userId,
      metadata: {
        trigger,
        source,
        reason,
        from_state: "BUYER_DISENGAGED",
        to_state: "BUYER_FINANCIALLY_VERIFIED", // Default reengagement target
      },
    })
    .select("id")
    .single()

  if (error) {
    console.error("[5.1D] Error emitting reengagement event:", error)
    return { success: false, error: error.message }
  }

  return { success: true, activityId: data?.id }
}

/**
 * Query recovery history
 */
export interface RecoveryHistoryEntry {
  id: string
  fromState: string
  toState: string
  recoveryPath: RecoveryPath
  trigger: RecoveryTrigger
  occurredAt: Date
  userId: string
}

export async function getRecoveryHistory(
  contactId: string,
  options?: { limit?: number }
): Promise<RecoveryHistoryEntry[]> {
  const { limit = 20 } = options || {}
  const supabase = createServiceClient()

  const { data: events, error } = await supabase
    .from("activities")
    .select("id, created_at, agent_user_id, metadata")
    .eq("activity_type", "buyer.lifecycle.recovery")
    .eq("entity_type", "contact")
    .eq("entity_id", contactId)
    .order("created_at", { ascending: false })
    .limit(limit)

  if (error) {
    console.error("[5.1D] Error fetching recovery history:", error)
    return []
  }

  if (!events) {
    return []
  }

  return events.map((event) => {
    const metadata = (event.metadata as Record<string, unknown>) || {}
    return {
      id: event.id,
      fromState: metadata.from_state as string,
      toState: metadata.to_state as string,
      recoveryPath: metadata.recovery_path as RecoveryPath,
      trigger: metadata.trigger as RecoveryTrigger,
      occurredAt: new Date(event.created_at),
      userId: event.agent_user_id || "system",
    }
  })
}

/**
 * Get buyers eligible for recovery (in ON_HOLD for X days)
 */
export async function getBuyersEligibleForRecovery(params: {
  brokerageId: string
  daysInOnHold: number
  limit?: number
}): Promise<Array<{ contactId: string; daysInState: number }>> {
  const { brokerageId, daysInOnHold, limit = 100 } = params
  const supabase = createServiceClient()

  // ONE query, and it reads the table the writer actually writes.
  //
  // This was an N+1 (a state lookup per contact) sitting on top of a read that could never
  // return anything: the "days in state" clock came from `activities` where activity_type =
  // 'buyer.lifecycle.transition', and nothing has ever written that row — transitions go to
  // lifecycle_events via transitionLifecycle(). transitionEvent was therefore always null,
  // the `if (transitionEvent)` never opened, and this function returned an EMPTY LIST every
  // time. No buyer on hold was ever nominated for recovery.
  //
  // m367's buyer_lifecycle_current_states returns entered_at — the timestamp of the latest
  // transition — which IS the clock this needed. Same source as the state, so the state and
  // its age can no longer disagree.
  const { data: stateRows, error } = await supabase.rpc("buyer_lifecycle_current_states", {
    p_brokerage_id: brokerageId,
    p_start: null,
    p_end:   null,
  })

  if (error) {
    console.error("[5.1D] recovery-eligibility read failed:", error.message)
    return []
  }

  const now = Date.now()
  const eligibleBuyers: Array<{ contactId: string; daysInState: number }> = []

  for (const row of (stateRows ?? []) as Array<{ contact_id: string; current_state: string | null; entered_at: string | null }>) {
    if (row.current_state !== "BUYER_ON_HOLD" || !row.entered_at) continue
    const daysInState = Math.floor((now - new Date(row.entered_at).getTime()) / (1000 * 60 * 60 * 24))
    if (daysInState >= daysInOnHold) {
      eligibleBuyers.push({ contactId: row.contact_id, daysInState })
    }
  }

  // The limit bounds the RESULT. It previously capped how many contacts were SCANNED, so a
  // brokerage could hold more eligible buyers than it ever surfaced.
  return eligibleBuyers.slice(0, limit)
}
