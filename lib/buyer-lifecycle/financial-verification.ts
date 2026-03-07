/**
 * System 5.1C: Buyer Lifecycle Governance Core - Financial Verification
 * 
 * Validates financial verification based on events in activities table.
 * Does NOT store verification state - purely event-driven evaluation.
 * 
 * This is GOVERNANCE ONLY - no lender integrations, no document handling
 */

import { createServiceClient } from "@/lib/supabase/service"

export interface FinancialVerificationContext {
  contactId: string
  
  // Optional: Check verification status as of a specific date
  asOfDate?: Date
}

export interface FinancialVerificationResult {
  isVerified: boolean
  verificationType?: "pre_approval" | "proof_of_funds" | "lender_intro" | "agent_confirmation"
  verifiedAt?: Date
  verifiedBy?: string
  expiresAt?: Date
  signals: FinancialVerificationSignal[]
}

export interface FinancialVerificationSignal {
  type: string
  occurredAt: Date
  source: string
  metadata?: Record<string, unknown>
}

/**
 * Check if buyer is financially verified based on events
 * 
 * Accepted verification signals:
 * - buyer.financial.verification
 * - buyer.pre_approval.uploaded
 * - buyer.proof_of_funds.uploaded
 * - buyer.lender.introduced
 * - agent.confirms.buyer.financial
 */
export async function checkFinancialVerification(
  context: FinancialVerificationContext
): Promise<FinancialVerificationResult> {
  const { contactId, asOfDate } = context
  const supabase = createServiceClient()
  
  // Query activities for financial verification events
  let query = supabase
    .from("activities")
    .select("type, created_at, user_id, metadata")
    .eq("entity_type", "contact")
    .eq("entity_id", contactId)
    .in("type", [
      "buyer.financial.verification",
      "buyer.pre_approval.uploaded",
      "buyer.proof_of_funds.uploaded",
      "buyer.lender.introduced",
      "agent.confirms.buyer.financial",
    ])
    .order("created_at", { ascending: false })
  
  if (asOfDate) {
    query = query.lte("created_at", asOfDate.toISOString())
  }
  
  const { data: events, error } = await query
  
  if (error) {
    console.error("[buyer-lifecycle] Error checking financial verification:", error)
    return {
      isVerified: false,
      signals: [],
    }
  }
  
  if (!events || events.length === 0) {
    return {
      isVerified: false,
      signals: [],
    }
  }
  
  // Map events to signals
  const signals: FinancialVerificationSignal[] = events.map((event) => ({
    type: event.type,
    occurredAt: new Date(event.created_at),
    source: event.user_id || "system",
    metadata: event.metadata as Record<string, unknown> | undefined,
  }))
  
  // Get most recent verification event
  const mostRecent = events[0]
  
  // Determine verification type
  let verificationType: FinancialVerificationResult["verificationType"]
  if (mostRecent.type === "buyer.pre_approval.uploaded") {
    verificationType = "pre_approval"
  } else if (mostRecent.type === "buyer.proof_of_funds.uploaded") {
    verificationType = "proof_of_funds"
  } else if (mostRecent.type === "buyer.lender.introduced") {
    verificationType = "lender_intro"
  } else if (mostRecent.type === "agent.confirms.buyer.financial") {
    verificationType = "agent_confirmation"
  } else {
    verificationType = "agent_confirmation" // default
  }
  
  // Check expiration (if metadata includes expiration date)
  let expiresAt: Date | undefined
  if (mostRecent.metadata && typeof mostRecent.metadata === "object") {
    const metadata = mostRecent.metadata as Record<string, unknown>
    if (metadata.expires_at && typeof metadata.expires_at === "string") {
      expiresAt = new Date(metadata.expires_at)
    }
  }
  
  return {
    isVerified: true,
    verificationType,
    verifiedAt: new Date(mostRecent.created_at),
    verifiedBy: mostRecent.user_id || undefined,
    expiresAt,
    signals,
  }
}

/**
 * Emit financial verification event
 * (Helper for other systems to log verification)
 */
export async function emitFinancialVerificationEvent(params: {
  contactId: string
  verificationType: "pre_approval" | "proof_of_funds" | "lender_intro" | "agent_confirmation"
  userId: string
  expiresAt?: Date
  metadata?: Record<string, unknown>
}): Promise<{ success: boolean; error?: string }> {
  const { contactId, verificationType, userId, expiresAt, metadata } = params
  const supabase = createServiceClient()
  
  // Agent task (correct location, no changes) — type: buyer.pre_approval.uploaded, buyer.proof_of_funds.uploaded, buyer.lender.introduced, agent.confirms.buyer.financial
  // Map verification type to event type
  const eventTypeMap = {
    pre_approval: "buyer.pre_approval.uploaded",
    proof_of_funds: "buyer.proof_of_funds.uploaded",
    lender_intro: "buyer.lender.introduced",
    agent_confirmation: "agent.confirms.buyer.financial",
  }
  
  const eventType = eventTypeMap[verificationType]
  
  const { error } = await supabase.from("activities").insert({
    type: eventType,
    entity_type: "contact",
    entity_id: contactId,
    user_id: userId,
    metadata: {
      ...metadata,
      expires_at: expiresAt?.toISOString(),
      verification_type: verificationType,
    },
  })
  
  if (error) {
    console.error("[buyer-lifecycle] Error emitting financial verification event:", error)
    return { success: false, error: error.message }
  }
  
  return { success: true }
}

/**
 * Check if financial verification is expired
 */
export function isVerificationExpired(verification: FinancialVerificationResult): boolean {
  if (!verification.isVerified) {
    return false // Not verified, so not expired
  }
  
  if (!verification.expiresAt) {
    return false // No expiration date
  }
  
  return new Date() > verification.expiresAt
}

/**
 * Get financial verification status summary (for UI)
 */
export interface FinancialVerificationStatus {
  status: "verified" | "expired" | "not_verified"
  verificationType?: string
  verifiedAt?: Date
  expiresAt?: Date
  daysUntilExpiration?: number
}

export async function getFinancialVerificationStatus(
  contactId: string
): Promise<FinancialVerificationStatus> {
  const verification = await checkFinancialVerification({ contactId })
  
  if (!verification.isVerified) {
    return { status: "not_verified" }
  }
  
  if (isVerificationExpired(verification)) {
    return {
      status: "expired",
      verificationType: verification.verificationType,
      verifiedAt: verification.verifiedAt,
      expiresAt: verification.expiresAt,
    }
  }
  
  // Calculate days until expiration
  let daysUntilExpiration: number | undefined
  if (verification.expiresAt) {
    const now = new Date()
    const diff = verification.expiresAt.getTime() - now.getTime()
    daysUntilExpiration = Math.ceil(diff / (1000 * 60 * 60 * 24))
  }
  
  return {
    status: "verified",
    verificationType: verification.verificationType,
    verifiedAt: verification.verifiedAt,
    expiresAt: verification.expiresAt,
    daysUntilExpiration,
  }
}

/**
 * Batch check financial verification for multiple buyers
 */
export async function batchCheckFinancialVerification(
  contactIds: string[]
): Promise<Map<string, FinancialVerificationResult>> {
  const results = new Map<string, FinancialVerificationResult>()
  
  // Process in parallel
  const promises = contactIds.map(async (contactId) => {
    const result = await checkFinancialVerification({ contactId })
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
