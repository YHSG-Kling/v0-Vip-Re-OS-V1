/**
 * System 5.1D: Buyer Lifecycle Governance Hardening
 * Extension 1: Financial Verification Event Schema
 * 
 * Standardizes canonical financial verification events stored in activities.
 * No schema changes - purely event structure definitions.
 */

import { createServiceClient } from "@/lib/supabase/service"

export type FinancialVerificationStatus = "verified" | "rejected" | "expired"
export type FinancialVerificationType = "preapproval" | "proof_of_funds" | "lender_intro" | "agent_confirmation"
export type FinancialVerificationSource = "portal_upload" | "lender_intro" | "manual" | "system"
export type VerifiedBy = "agent" | "lender" | "system" | "admin"

/**
 * Canonical financial verification event metadata
 * Stored in activities.metadata when type = "buyer.financial.verification"
 */
export interface FinancialVerificationEventMetadata {
  status: FinancialVerificationStatus
  verification_type: FinancialVerificationType
  max_budget?: number
  verified_by: VerifiedBy
  source: FinancialVerificationSource
  expires_at?: string // ISO timestamp
  document_id?: string // Reference to uploaded document
  lender_name?: string
  pre_approval_amount?: number
  verification_notes?: string
}

/**
 * Complete financial verification event structure
 */
export interface FinancialVerificationEvent {
  type: "buyer.financial.verification"
  entity_type: "contact"
  entity_id: string
  user_id: string
  metadata: FinancialVerificationEventMetadata
  occurred_at?: string // ISO timestamp (created_at in activities)
}

/**
 * Emit a standardized financial verification event
 */
export async function emitFinancialVerificationEvent(
  params: {
    contactId: string
    status: FinancialVerificationStatus
    verificationType: FinancialVerificationType
    verifiedBy: VerifiedBy
    source: FinancialVerificationSource
    userId: string
    maxBudget?: number
    expiresAt?: Date
    documentId?: string
    lenderName?: string
    preApprovalAmount?: number
    verificationNotes?: string
  }
): Promise<{ success: boolean; error?: string; activityId?: string }> {
  const {
    contactId,
    status,
    verificationType,
    verifiedBy,
    source,
    userId,
    maxBudget,
    expiresAt,
    documentId,
    lenderName,
    preApprovalAmount,
    verificationNotes,
  } = params

  const supabase = createServiceClient()

  const metadata: FinancialVerificationEventMetadata = {
    status,
    verification_type: verificationType,
    verified_by: verifiedBy,
    source,
    max_budget: maxBudget,
    expires_at: expiresAt?.toISOString(),
    document_id: documentId,
    lender_name: lenderName,
    pre_approval_amount: preApprovalAmount,
    verification_notes: verificationNotes,
  }

  const { data, error } = await supabase
    .from("activities")
    .insert({
      type: "buyer.financial.verification",
      entity_type: "contact",
      entity_id: contactId,
      user_id: userId,
      metadata,
    })
    .select("id")
    .single()

  if (error) {
    console.error("[5.1D] Error emitting financial verification event:", error)
    return { success: false, error: error.message }
  }

  return { success: true, activityId: data?.id }
}

/**
 * Query financial verification events for a contact
 */
export async function queryFinancialVerificationEvents(
  contactId: string,
  options?: {
    limit?: number
    asOfDate?: Date
    statusFilter?: FinancialVerificationStatus[]
  }
): Promise<Array<FinancialVerificationEvent & { id: string; created_at: string }>> {
  const { limit = 10, asOfDate, statusFilter } = options || {}
  const supabase = createServiceClient()

  let query = supabase
    .from("activities")
    .select("id, created_at, user_id, metadata")
    .eq("type", "buyer.financial.verification")
    .eq("entity_type", "contact")
    .eq("entity_id", contactId)
    .order("created_at", { ascending: false })
    .limit(limit)

  if (asOfDate) {
    query = query.lte("created_at", asOfDate.toISOString())
  }

  const { data: events, error } = await query

  if (error) {
    console.error("[5.1D] Error querying financial verification events:", error)
    return []
  }

  if (!events) {
    return []
  }

  let results = events.map((event) => ({
    id: event.id,
    type: "buyer.financial.verification" as const,
    entity_type: "contact" as const,
    entity_id: contactId,
    user_id: event.user_id || "system",
    metadata: event.metadata as FinancialVerificationEventMetadata,
    created_at: event.created_at,
    occurred_at: event.created_at,
  }))

  // Apply status filter if provided
  if (statusFilter && statusFilter.length > 0) {
    results = results.filter((event) =>
      statusFilter.includes(event.metadata.status)
    )
  }

  return results
}

/**
 * Get most recent financial verification event
 */
export async function getMostRecentVerification(
  contactId: string
): Promise<(FinancialVerificationEvent & { id: string; created_at: string }) | null> {
  const events = await queryFinancialVerificationEvents(contactId, { limit: 1 })
  return events.length > 0 ? events[0] : null
}

/**
 * Check if verification is expired
 */
export function isVerificationExpired(
  event: FinancialVerificationEvent & { created_at: string }
): boolean {
  if (!event.metadata.expires_at) {
    return false // No expiration date set
  }

  const expiresAt = new Date(event.metadata.expires_at)
  return new Date() > expiresAt
}

/**
 * Get days until expiration
 */
export function getDaysUntilExpiration(
  event: FinancialVerificationEvent & { created_at: string }
): number | null {
  if (!event.metadata.expires_at) {
    return null
  }

  const expiresAt = new Date(event.metadata.expires_at)
  const now = new Date()
  const diff = expiresAt.getTime() - now.getTime()
  return Math.ceil(diff / (1000 * 60 * 60 * 24))
}

/**
 * Enhanced verification status (includes expiration checking)
 */
export interface EnhancedVerificationStatus {
  isVerified: boolean
  status: FinancialVerificationStatus | "not_verified"
  verificationType?: FinancialVerificationType
  maxBudget?: number
  verifiedAt?: Date
  expiresAt?: Date
  daysUntilExpiration?: number
  isExpired: boolean
  latestEvent?: FinancialVerificationEvent & { id: string; created_at: string }
}

export async function getEnhancedVerificationStatus(
  contactId: string
): Promise<EnhancedVerificationStatus> {
  const latestEvent = await getMostRecentVerification(contactId)

  if (!latestEvent) {
    return {
      isVerified: false,
      status: "not_verified",
      isExpired: false,
    }
  }

  // If status is rejected or expired, not verified
  if (latestEvent.metadata.status === "rejected" || latestEvent.metadata.status === "expired") {
    return {
      isVerified: false,
      status: latestEvent.metadata.status,
      verificationType: latestEvent.metadata.verification_type,
      verifiedAt: new Date(latestEvent.created_at),
      isExpired: true,
      latestEvent,
    }
  }

  // Check if expired by date
  const isExpired = isVerificationExpired(latestEvent)
  const daysUntil = getDaysUntilExpiration(latestEvent)

  return {
    isVerified: !isExpired,
    status: isExpired ? "expired" : latestEvent.metadata.status,
    verificationType: latestEvent.metadata.verification_type,
    maxBudget: latestEvent.metadata.max_budget,
    verifiedAt: new Date(latestEvent.created_at),
    expiresAt: latestEvent.metadata.expires_at ? new Date(latestEvent.metadata.expires_at) : undefined,
    daysUntilExpiration: daysUntil !== null ? daysUntil : undefined,
    isExpired,
    latestEvent,
  }
}

/**
 * Batch check verification status for multiple buyers
 */
export async function batchGetVerificationStatus(
  contactIds: string[]
): Promise<Map<string, EnhancedVerificationStatus>> {
  const results = new Map<string, EnhancedVerificationStatus>()

  const promises = contactIds.map(async (contactId) => {
    const status = await getEnhancedVerificationStatus(contactId)
    return { contactId, status }
  })

  const settled = await Promise.allSettled(promises)

  for (const outcome of settled) {
    if (outcome.status === "fulfilled") {
      results.set(outcome.value.contactId, outcome.value.status)
    }
  }

  return results
}
