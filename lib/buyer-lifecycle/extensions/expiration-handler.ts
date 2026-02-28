/**
 * System 5.1D: Buyer Lifecycle Governance Hardening
 * Extension 2: Financial Verification Expiration Handling
 * 
 * Handles time-bound verification expiration and auto-gating.
 * On expiration: Buyer → BUYER_ON_HOLD + emit escalation signal
 */

import { createServiceClient } from "@/lib/supabase/service"
import { getEnhancedVerificationStatus } from "./financial-verification-schema"
import { getCurrentBuyerState } from "../lifecycle-logger"

export interface ExpirationCheckResult {
  isExpired: boolean
  requiresTransition: boolean
  targetState?: "BUYER_ON_HOLD"
  reason?: string
  expirationDate?: Date
}

/**
 * Check if buyer's financial verification has expired
 * and determine if state transition is required
 */
export async function checkVerificationExpiration(
  contactId: string
): Promise<ExpirationCheckResult> {
  const verificationStatus = await getEnhancedVerificationStatus(contactId)

  // Not verified or no expiration date
  if (!verificationStatus.isVerified && !verificationStatus.isExpired) {
    return {
      isExpired: false,
      requiresTransition: false,
    }
  }

  // Expired
  if (verificationStatus.isExpired) {
    const currentState = await getCurrentBuyerState(contactId)

    // If already in ON_HOLD or DISENGAGED, no transition needed
    if (currentState === "BUYER_ON_HOLD" || currentState === "BUYER_DISENGAGED") {
      return {
        isExpired: true,
        requiresTransition: false,
        reason: "Already in ON_HOLD or DISENGAGED state",
        expirationDate: verificationStatus.expiresAt,
      }
    }

    // If in frozen state (UNDER_CONTRACT), cannot transition
    if (currentState === "BUYER_UNDER_CONTRACT") {
      return {
        isExpired: true,
        requiresTransition: false,
        reason: "Buyer is under contract - frozen state",
        expirationDate: verificationStatus.expiresAt,
      }
    }

    // Requires transition to ON_HOLD
    return {
      isExpired: true,
      requiresTransition: true,
      targetState: "BUYER_ON_HOLD",
      reason: "Financial verification expired",
      expirationDate: verificationStatus.expiresAt,
    }
  }

  return {
    isExpired: false,
    requiresTransition: false,
  }
}

/**
 * Emit expiration transition event (for orchestration systems)
 * Does NOT execute the transition - only signals the need
 */
export async function emitExpirationTransitionSignal(params: {
  contactId: string
  fromState: string
  expirationDate: Date
  userId?: string
}): Promise<{ success: boolean; error?: string; activityId?: string }> {
  const { contactId, fromState, expirationDate, userId = "system" } = params
  const supabase = createServiceClient()

  const { data, error } = await supabase
    .from("activities")
    .insert({
      type: "buyer.lifecycle.expiration_transition_signal",
      entity_type: "contact",
      entity_id: contactId,
      user_id: userId,
      metadata: {
        from_state: fromState,
        target_state: "BUYER_ON_HOLD",
        reason: "financial_verification_expired",
        expiration_date: expirationDate.toISOString(),
        signal_type: "auto_transition",
      },
    })
    .select("id")
    .single()

  if (error) {
    console.error("[5.1D] Error emitting expiration transition signal:", error)
    return { success: false, error: error.message }
  }

  return { success: true, activityId: data?.id }
}

/**
 * Emit SLA escalation signal on expiration
 */
export async function emitSLAEscalation(params: {
  contactId: string
  escalationType: "verification_expired" | "renewal_required"
  severity: "low" | "medium" | "high"
  daysOverdue?: number
  metadata?: Record<string, unknown>
}): Promise<{ success: boolean; error?: string; activityId?: string }> {
  const { contactId, escalationType, severity, daysOverdue, metadata } = params
  const supabase = createServiceClient()

  const { data, error } = await supabase
    .from("activities")
    .insert({
      type: "buyer.lifecycle.sla_escalation",
      entity_type: "contact",
      entity_id: contactId,
      user_id: "system",
      metadata: {
        escalation_type: escalationType,
        severity,
        days_overdue: daysOverdue,
        ...metadata,
      },
    })
    .select("id")
    .single()

  if (error) {
    console.error("[5.1D] Error emitting SLA escalation:", error)
    return { success: false, error: error.message }
  }

  return { success: true, activityId: data?.id }
}

/**
 * System gate evaluation with expiration checking
 * Extends base gate checking to include expiration validation
 */
export interface ExpirationGateResult {
  allowed: boolean
  reason?: string
  requiresRenewal?: boolean
  daysUntilExpiration?: number
  expiresAt?: Date
}

export async function evaluateSystemGateWithExpiration(
  contactId: string,
  gateName: "search" | "tour" | "offer"
): Promise<ExpirationGateResult> {
  const verificationStatus = await getEnhancedVerificationStatus(contactId)

  // Not verified
  if (!verificationStatus.isVerified) {
    return {
      allowed: false,
      reason: "Financial verification required",
      requiresRenewal: true,
    }
  }

  // Expired
  if (verificationStatus.isExpired) {
    return {
      allowed: false,
      reason: "Financial verification expired",
      requiresRenewal: true,
      expiresAt: verificationStatus.expiresAt,
    }
  }

  // Expiring soon (within 14 days)
  if (verificationStatus.daysUntilExpiration !== undefined && verificationStatus.daysUntilExpiration <= 14) {
    return {
      allowed: true,
      reason: `Verification expires in ${verificationStatus.daysUntilExpiration} days - renewal recommended`,
      requiresRenewal: false,
      daysUntilExpiration: verificationStatus.daysUntilExpiration,
      expiresAt: verificationStatus.expiresAt,
    }
  }

  // Valid
  return {
    allowed: true,
    daysUntilExpiration: verificationStatus.daysUntilExpiration,
    expiresAt: verificationStatus.expiresAt,
  }
}

/**
 * Batch check expiration for multiple buyers
 */
export async function batchCheckExpirations(
  contactIds: string[]
): Promise<Map<string, ExpirationCheckResult>> {
  const results = new Map<string, ExpirationCheckResult>()

  const promises = contactIds.map(async (contactId) => {
    const result = await checkVerificationExpiration(contactId)
    return { contactId, result }
  })

  const settled = await Promise.allSettled(promises)

  for (const outcome of settled) {
    if (outcome.status === "fulfilled") {
      results.set(outcome.value.contactId, outcome.value.result)
    }
  }

  return results
}

/**
 * Get buyers with expiring verifications (for proactive renewal)
 */
export async function getBuyersWithExpiringVerifications(params: {
  brokerageId: string
  daysThreshold: number // e.g., 14 days
  limit?: number
}): Promise<Array<{ contactId: string; daysUntilExpiration: number; expiresAt: Date }>> {
  const { brokerageId, daysThreshold, limit = 100 } = params
  const supabase = createServiceClient()

  // Get all contacts for brokerage
  const { data: contacts, error } = await supabase
    .from("contacts")
    .select("id")
    .eq("brokerage_id", brokerageId)
    .limit(limit)

  if (error || !contacts) {
    console.error("[5.1D] Error fetching contacts:", error)
    return []
  }

  const expiringBuyers: Array<{ contactId: string; daysUntilExpiration: number; expiresAt: Date }> = []

  for (const contact of contacts) {
    const verificationStatus = await getEnhancedVerificationStatus(contact.id)

    if (
      verificationStatus.isVerified &&
      !verificationStatus.isExpired &&
      verificationStatus.daysUntilExpiration !== undefined &&
      verificationStatus.daysUntilExpiration <= daysThreshold &&
      verificationStatus.expiresAt
    ) {
      expiringBuyers.push({
        contactId: contact.id,
        daysUntilExpiration: verificationStatus.daysUntilExpiration,
        expiresAt: verificationStatus.expiresAt,
      })
    }
  }

  return expiringBuyers
}

/**
 * Emit verification renewal reminder signal
 */
export async function emitRenewalReminderSignal(params: {
  contactId: string
  daysUntilExpiration: number
  expiresAt: Date
}): Promise<{ success: boolean; error?: string }> {
  const { contactId, daysUntilExpiration, expiresAt } = params
  const supabase = createServiceClient()

  // Agent task (correct location, no changes) — type: buyer.lifecycle.renewal_reminder
  const { error } = await supabase.from("activities").insert({
    type: "buyer.lifecycle.renewal_reminder",
    entity_type: "contact",
    entity_id: contactId,
    user_id: "system",
    metadata: {
      days_until_expiration: daysUntilExpiration,
      expires_at: expiresAt.toISOString(),
      reminder_type: "financial_verification_renewal",
    },
  })

  if (error) {
    console.error("[5.1D] Error emitting renewal reminder:", error)
    return { success: false, error: error.message }
  }

  return { success: true }
}
