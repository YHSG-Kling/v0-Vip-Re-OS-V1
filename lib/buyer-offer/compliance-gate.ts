"use server"

/**
 * System 7.1B - Compliance Gate (ABSOLUTE)
 * 
 * NO PATH may emit buyer.offer.accepted or buyer.under_contract
 * without buyer.offer.compliance.passed in activities history.
 * 
 * This is the constitutional gate that prevents non-compliant offers
 * from advancing to acceptance.
 */

import { createServiceClient } from "@/lib/supabase/service"
import { isValidUUID } from "@/lib/validations"

export interface ComplianceCheckResult {
  passed: boolean
  complianceEventId?: string
  complianceTimestamp?: string
  error?: string
}

/**
 * Check if offer has compliance.passed event
 * 
 * This is the ONLY source of truth for compliance status.
 * Never check any column. Only check activities.
 */
export async function checkCompliancePassed(
  offerId: string
): Promise<ComplianceCheckResult> {
  if (!isValidUUID(offerId)) {
    return { passed: false, error: "Invalid offer ID" }
  }

  const supabase = createServiceClient()

  const { data: complianceEvent, error } = await supabase
    .from("activities")
    .select("id, created_at")
    .eq("entity_type", "offer")
    .eq("entity_id", offerId)
    .eq("activity_type", "buyer.offer.compliance.passed")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) {
    console.error("[System 7.1B] Error checking compliance:", error)
    return { passed: false, error: error.message }
  }

  if (!complianceEvent) {
    return { passed: false, error: "Compliance event not found" }
  }

  return {
    passed: true,
    complianceEventId: complianceEvent.id,
    complianceTimestamp: complianceEvent.created_at,
  }
}

/**
 * Emit compliance.passed event
 * 
 * Called after internal compliance scan OR external compliance approval.
 */
export async function emitCompliancePassed(params: {
  offerId: string
  userId: string
  scanResults?: Record<string, any>
  externalApprovalId?: string
}): Promise<{ success: boolean; error?: string }> {
  const { offerId, userId, scanResults, externalApprovalId } = params

  if (!isValidUUID(offerId) || !isValidUUID(userId)) {
    return { success: false, error: "Invalid IDs" }
  }

  const supabase = createServiceClient()

  // Agent task (correct location, no changes) — activity_type: buyer.offer.compliance.passed (offer status signal, not a compliance gate log)
  const { error } = await supabase.from("activities").insert({
    entity_type: "offer",
    entity_id: offerId,
    activity_type: "buyer.offer.compliance.passed",
    user_id: userId,
    metadata: {
      scan_results: scanResults,
      external_approval_id: externalApprovalId,
      timestamp: new Date().toISOString(),
    },
  })

  if (error) {
    console.error("[System 7.1B] Error emitting compliance.passed:", error)
    return { success: false, error: error.message }
  }

  return { success: true }
}

/**
 * Validate acceptance eligibility
 * 
 * Throws error if offer cannot be accepted.
 * Use this before emitting acceptance events.
 */
export async function validateAcceptanceEligibility(
  offerId: string
): Promise<void> {
  const complianceCheck = await checkCompliancePassed(offerId)

  if (!complianceCheck.passed) {
    throw new Error(
      `Cannot accept offer ${offerId}: ${complianceCheck.error || "compliance.passed event not found"}`
    )
  }
}
