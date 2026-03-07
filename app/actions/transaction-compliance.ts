"use server"

import { createServiceClient } from "@/lib/supabase/service"
import { createClient } from "@/lib/supabase/server"
import { revalidatePath } from "next/cache"
import { isValidUUID } from "@/lib/validations"

// ─── COMPLIANCE CHECK DEFINITIONS ────────────────────────────────────────────
// These checks are seeded when a transaction advances to INSPECTION stage

const TRANSACTION_COMPLIANCE_CHECKS = [
  { check_type: "lead_paint_disclosure", check_label: "Lead Paint Disclosure", is_blocking: true },
  { check_type: "property_disclosure", check_label: "Property Disclosure Signed", is_blocking: true },
  { check_type: "agency_disclosure", check_label: "Agency Disclosure", is_blocking: true },
  { check_type: "earnest_money_receipt", check_label: "Earnest Money Receipt Confirmed", is_blocking: true },
  { check_type: "trid_timing", check_label: "TRID Timing Verified", is_blocking: true },
  { check_type: "hoa_documents", check_label: "HOA Documents Delivered", is_blocking: false },
  { check_type: "inspection_period", check_label: "Inspection Period Disclosed", is_blocking: false },
  { check_type: "wire_fraud_disclosure", check_label: "Wire Fraud Warning Acknowledged", is_blocking: true },
]

// ─── SEED COMPLIANCE CHECKS ─────────────────────────────────────────────────────

/**
 * Seeds transaction compliance checks when stage advances to INSPECTION.
 * Inserts rows into transaction_compliance_log table.
 */
export async function seedTransactionComplianceChecks(
  transactionId: string,
  brokerageId: string
): Promise<{ success: boolean; inserted: number; error?: string }> {
  if (!isValidUUID(transactionId)) return { success: false, inserted: 0, error: "Invalid transaction ID" }
  if (!isValidUUID(brokerageId)) return { success: false, inserted: 0, error: "Invalid brokerage ID" }

  const supabase = createServiceClient()

  // Get current user for audit
  const serverClient = await createClient()
  const { data: { user } } = await serverClient.auth.getUser()

  // Check for existing checks to avoid duplicates
  const { data: existing } = await supabase
    .from("transaction_compliance_log")
    .select("check_type")
    .eq("transaction_id", transactionId)
    .eq("brokerage_id", brokerageId)

  const existingTypes = new Set((existing ?? []).map((r: { check_type: string }) => r.check_type))

  const checksToInsert = TRANSACTION_COMPLIANCE_CHECKS
    .filter(c => !existingTypes.has(c.check_type))
    .map(check => ({
      transaction_id: transactionId,
      brokerage_id: brokerageId,
      check_type: check.check_type,
      check_label: check.check_label,
      is_blocking: check.is_blocking,
      status: "pending",
      created_at: new Date().toISOString(),
    }))

  if (checksToInsert.length === 0) {
    return { success: true, inserted: 0 }
  }

  const { error } = await supabase.from("transaction_compliance_log").insert(checksToInsert)

  if (error) {
    console.error("[transaction-compliance] Failed to seed compliance checks:", error)
    return { success: false, inserted: 0, error: error.message }
  }

  // Log timeline entry
  await supabase.from("transaction_timeline").insert({
    transaction_id: transactionId,
    brokerage_id: brokerageId,
    activity_type: "compliance_checks_seeded",
    description: `${checksToInsert.length} compliance checks created for review`,
    performed_by: user?.id,
    metadata: { check_count: checksToInsert.length },
    created_at: new Date().toISOString(),
  })

  return { success: true, inserted: checksToInsert.length }
}

// ─── BUILD25 VALID STATUSES ─────────────────────────────────────────────────────
// Normalized to pass/fail per kernel OS specification

export const BUILD25_COMPLIANCE_STATUSES = {
  PASS: "pass",
  FAIL: "fail",
  PENDING: "pending",
  WAIVED: "waived",
} as const

export type ComplianceCheckStatus = "pending" | "pass" | "fail" | "waived"

export async function updateComplianceCheck(params: {
  checkId: string
  transactionId: string
  brokerageId: string
  status: ComplianceCheckStatus
  resolutionNotes?: string
  failureReason?: string
}): Promise<{ success: boolean; error?: string }> {
  if (!isValidUUID(params.checkId)) return { success: false, error: "Invalid check ID" }
  if (!isValidUUID(params.transactionId)) return { success: false, error: "Invalid transaction ID" }
  if (!isValidUUID(params.brokerageId)) return { success: false, error: "Invalid brokerage ID" }

  const supabase = createServiceClient()
  const serverClient = await createClient()
  const { data: { user } } = await serverClient.auth.getUser()

  if (!user) {
    return { success: false, error: "Not authenticated" }
  }

  // Get current check for context
  const { data: check } = await supabase
    .from("transaction_compliance_log")
    .select("check_type, check_label, status, is_blocking")
    .eq("id", params.checkId)
    .eq("transaction_id", params.transactionId)
    .eq("brokerage_id", params.brokerageId)
    .single()

  if (!check) {
    return { success: false, error: "Compliance check not found" }
  }

  const previousStatus = check.status

  // Update the check
  const updateData: Record<string, unknown> = {
    status: params.status,
    checked_by: user.id,
    checked_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }

  // Normalize writes: pass/fail per build25 spec
  if (params.status === BUILD25_COMPLIANCE_STATUSES.PASS || params.status === "waived") {
    updateData.resolved_by = user.id
    updateData.resolved_at = new Date().toISOString()
    updateData.resolution_notes = params.resolutionNotes ?? null
  }

  if (params.status === BUILD25_COMPLIANCE_STATUSES.FAIL) {
    updateData.failure_reason = params.failureReason ?? null
  }

  const { error: updateError } = await supabase
    .from("transaction_compliance_log")
    .update(updateData)
    .eq("id", params.checkId)
    .eq("transaction_id", params.transactionId)
    .eq("brokerage_id", params.brokerageId)

  if (updateError) {
    return { success: false, error: updateError.message }
  }

  // Create timeline entry for compliance change (normalized status)
  await supabase.from("transaction_timeline").insert({
    transaction_id: params.transactionId,
    brokerage_id: params.brokerageId,
    activity_type: "compliance_check_updated",
    description: `Compliance check "${check.check_label}" updated: ${previousStatus} -> ${params.status}`,
    performed_by: user.id,
    metadata: {
      check_id: params.checkId,
      check_type: check.check_type,
      previous_status: previousStatus,
      new_status: params.status, // normalized: pass/fail
      is_blocking: check.is_blocking,
      resolution_notes: params.resolutionNotes,
      failure_reason: params.failureReason,
    },
    created_at: new Date().toISOString(),
  })

  revalidatePath(`/dashboard/transactions/${params.transactionId}`)
  revalidatePath("/dashboard/compliance")

  return { success: true }
}

// ─── CAN PROCEED TO CLOSING PREP ────────────────────────────────────────────────

/**
 * Checks if a transaction can proceed to CLOSING_PREP stage.
 * Filters by build25-valid statuses only: pass/fail/pending/waived
 * 
 * ALLOWED to proceed: status = "pass" or "waived"
 * BLOCKED from proceeding: status = "fail" or "pending" (for blocking checks)
 */
export async function canProceedToClosingPrep(
  transactionId: string,
  brokerageId: string
): Promise<{ allowed: boolean; blockers: string[] }> {
  if (!isValidUUID(transactionId)) return { allowed: false, blockers: ["Invalid transaction ID"] }
  if (!isValidUUID(brokerageId)) return { allowed: false, blockers: ["Invalid brokerage ID"] }

  const supabase = createServiceClient()

  // Get all blocking compliance checks - filter by build25-valid statuses
  const { data: blockingChecks, error } = await supabase
    .from("transaction_compliance_log")
    .select("id, check_type, check_label, status, is_blocking, failure_reason")
    .eq("transaction_id", transactionId)
    .eq("brokerage_id", brokerageId)
    .eq("is_blocking", true)
    // Only consider build25-valid statuses
    .in("status", [
      BUILD25_COMPLIANCE_STATUSES.PASS,
      BUILD25_COMPLIANCE_STATUSES.FAIL,
      BUILD25_COMPLIANCE_STATUSES.PENDING,
      BUILD25_COMPLIANCE_STATUSES.WAIVED,
    ])

  if (error) {
    console.error("[transaction-compliance] Failed to fetch compliance checks:", error)
    return { allowed: false, blockers: ["Failed to verify compliance status"] }
  }

  const blockers: string[] = []

  for (const check of blockingChecks ?? []) {
    // build25: "fail" status blocking checks prevent CLOSING_PREP
    if (check.status === BUILD25_COMPLIANCE_STATUSES.FAIL) {
      blockers.push(
        `Compliance failed: ${check.check_label}${check.failure_reason ? ` - ${check.failure_reason}` : ""}`
      )
    }
    // build25: "pending" status blocking checks also prevent CLOSING_PREP
    if (check.status === BUILD25_COMPLIANCE_STATUSES.PENDING) {
      blockers.push(`Compliance pending: ${check.check_label}`)
    }
    // build25: "pass" and "waived" statuses are allowed - no action needed
  }

  return {
    allowed: blockers.length === 0,
    blockers,
  }
}

// ─── GET TRANSACTION COMPLIANCE CHECKS ──────────────────────────────────────────

export async function getTransactionComplianceChecks(
  transactionId: string,
  brokerageId: string
): Promise<{
  success: boolean
  checks: Array<{
    id: string
    check_type: string
    check_label: string
    status: string
    is_blocking: boolean
    checked_at: string | null
    checked_by: string | null
    resolved_at: string | null
    resolved_by: string | null
    resolution_notes: string | null
    failure_reason: string | null
    created_at: string
  }>
  error?: string
}> {
  if (!isValidUUID(transactionId)) return { success: false, checks: [], error: "Invalid transaction ID" }
  if (!isValidUUID(brokerageId)) return { success: false, checks: [], error: "Invalid brokerage ID" }

  const supabase = createServiceClient()

  const { data, error } = await supabase
    .from("transaction_compliance_log")
    .select("*")
    .eq("transaction_id", transactionId)
    .eq("brokerage_id", brokerageId)
    .order("is_blocking", { ascending: false })
    .order("created_at", { ascending: true })

  if (error) {
    return { success: false, checks: [], error: error.message }
  }

  return { success: true, checks: data ?? [] }
}

// ─── GET ALL TRANSACTION COMPLIANCE LOGS (FOR DASHBOARD) ────────────────────────

export async function getAllTransactionComplianceLogs(filters?: {
  status?: string
  isBlocking?: boolean
  limit?: number
}): Promise<{
  success: boolean
  logs: Array<{
    id: string
    transaction_id: string
    brokerage_id: string
    check_type: string
    check_label: string
    status: string
    is_blocking: boolean
    checked_at: string | null
    checked_by: string | null
    resolved_at: string | null
    failure_reason: string | null
    created_at: string
    transaction?: {
      property_address: string
      stage: string
      agent_id: string
    }
  }>
  error?: string
}> {
  const serverClient = await createClient()
  const { data: { user } } = await serverClient.auth.getUser()

  if (!user) {
    return { success: false, logs: [], error: "Not authenticated" }
  }

  // Get user's brokerage
  const { data: profile } = await serverClient
    .from("profiles")
    .select("brokerage_id, role")
    .eq("id", user.id)
    .maybeSingle()

  if (!profile?.brokerage_id) {
    return { success: false, logs: [], error: "No brokerage found" }
  }

  const supabase = createServiceClient()

  let query = supabase
    .from("transaction_compliance_log")
    .select(`
      *,
      transaction:transactions(property_address, stage, agent_id)
    `)
    .eq("brokerage_id", profile.brokerage_id)
    .order("created_at", { ascending: false })

  if (filters?.status) {
    query = query.eq("status", filters.status)
  }

  if (filters?.isBlocking !== undefined) {
    query = query.eq("is_blocking", filters.isBlocking)
  }

  if (filters?.limit) {
    query = query.limit(filters.limit)
  } else {
    query = query.limit(100)
  }

  const { data, error } = await query

  if (error) {
    return { success: false, logs: [], error: error.message }
  }

  return { success: true, logs: data ?? [] }
}

// ─── BATCH UPDATE COMPLIANCE CHECK ──────────────────────────────────────────────

export async function batchPassComplianceChecks(params: {
  checkIds: string[]
  transactionId: string
  brokerageId: string
  resolutionNotes?: string
}): Promise<{ success: boolean; updated: number; error?: string }> {
  if (!isValidUUID(params.transactionId)) return { success: false, updated: 0, error: "Invalid transaction ID" }
  if (!isValidUUID(params.brokerageId)) return { success: false, updated: 0, error: "Invalid brokerage ID" }
  if (!params.checkIds.length) return { success: true, updated: 0 }

  const serverClient = await createClient()
  const { data: { user } } = await serverClient.auth.getUser()

  if (!user) {
    return { success: false, updated: 0, error: "Not authenticated" }
  }

  const supabase = createServiceClient()

  // Normalize writes: use "pass" per build25 spec
  const { error, count } = await supabase
    .from("transaction_compliance_log")
    .update({
      status: BUILD25_COMPLIANCE_STATUSES.PASS, // normalized: pass
      checked_by: user.id,
      checked_at: new Date().toISOString(),
      resolved_by: user.id,
      resolved_at: new Date().toISOString(),
      resolution_notes: params.resolutionNotes ?? null,
      updated_at: new Date().toISOString(),
    })
    .in("id", params.checkIds)
    .eq("transaction_id", params.transactionId)
    .eq("brokerage_id", params.brokerageId)

  if (error) {
    return { success: false, updated: 0, error: error.message }
  }

  // Log timeline entry (normalized status: pass)
  await supabase.from("transaction_timeline").insert({
    transaction_id: params.transactionId,
    brokerage_id: params.brokerageId,
    activity_type: "compliance_batch_pass",
    description: `${params.checkIds.length} compliance checks marked as pass`,
    performed_by: user.id,
    metadata: { check_ids: params.checkIds, status: BUILD25_COMPLIANCE_STATUSES.PASS },
    created_at: new Date().toISOString(),
  })

  revalidatePath(`/dashboard/transactions/${params.transactionId}`)
  revalidatePath("/dashboard/compliance")

  return { success: true, updated: count ?? params.checkIds.length }
}
