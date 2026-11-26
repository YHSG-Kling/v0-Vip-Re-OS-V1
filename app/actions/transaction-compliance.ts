"use server"

import { sentinelWrite } from "@/lib/kernel/write-sentinel"
import { createServiceClient } from "@/lib/supabase/service"
import { createClient } from "@/lib/supabase/server"
import { revalidatePath } from "next/cache"
import { isValidUUID } from "@/lib/validations"
import { getAgentContext } from "@/lib/identity/get-agent-context"
// WAVE 152 (lane 152E): THE OVERRIDE RULE for a compliance row (pure — lib/transactions/closing-compliance-core.ts) and the tenant
// roster the override authority is DERIVED from (never retyped — CLAUDE.md §4).
import { decideComplianceCheckChange } from "@/lib/transactions/closing-compliance-core"
import { TENANT_ADMIN_USER_TYPES } from "@/lib/auth/resolve-user-role"

/**
 * WHO MAY OVERRIDE a blocking / computed compliance check — the authority requireOverrideActor (lib/kernel/portal-auth.ts) holds for
 * every gate override: the tenant admin roster MINUS team_lead (a team lead runs a team's board, not the brokerage's legal and
 * financial approval). Derived by named subtraction from the ONE roster. Module-private ("use server": every export is an endpoint).
 */
const COMPLIANCE_OVERRIDE_USER_TYPES: ReadonlySet<string> = new Set([...TENANT_ADMIN_USER_TYPES].filter((t) => t !== "team_lead"))

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
 *
 * wave 68C (CLAUDE.md §4 IDOR audit): `brokerageId` used to come straight from
 * the caller into a SERVICE-role query/insert with only a UUID-shape check —
 * any authenticated caller could seed (and later read/update) compliance rows
 * under an arbitrary tenant. Tenant now comes from the SESSION; the parameter
 * is accepted for call-site compatibility and otherwise ignored.
 */
export async function seedTransactionComplianceChecks(
  transactionId: string,
  _brokerageId: string
): Promise<{ success: boolean; inserted: number; error?: string }> {
  if (!isValidUUID(transactionId)) return { success: false, inserted: 0, error: "Invalid transaction ID" }

  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) return { success: false, inserted: 0, error: "Not authenticated" }
  const brokerageId = ctx.brokerageId

  const supabase = createServiceClient()

  // Get current user for audit
  const user = { id: ctx.userId }

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
  await sentinelWrite(supabase, supabase.from("transaction_timeline").insert({
    transaction_id: transactionId,
    brokerage_id: brokerageId,
    activity_type: "compliance_checks_seeded",
    description: `${checksToInsert.length} compliance checks created for review`,
    performed_by: user?.id,
    metadata: { check_count: checksToInsert.length },
    created_at: new Date().toISOString(),
  }), { table: "transaction_timeline", flow: "transaction_timeline_write", reason: "timeline echo of compliance checks already inserted (checked above)" })

  return { success: true, inserted: checksToInsert.length }
}

// ─── COMPLIANCE STATUS TYPE ──────────────────────────────────────────────────────
// Status values are normalized to: pending, pass, fail, waived, needs_review
// These match the actual values stored in the Supabase transaction_compliance_log table

export type ComplianceCheckStatus = "pending" | "pass" | "fail" | "waived" | "needs_review"

// Status constants for writes (normalized)
const STATUS_PASS = "pass"
const STATUS_FAIL = "fail"
const STATUS_PENDING = "pending"
const STATUS_WAIVED = "waived"
const STATUS_NEEDS_REVIEW = "needs_review"

// wave 68C (CLAUDE.md §4 IDOR audit): `params.brokerageId` used to flow straight
// into the SERVICE-role `.eq("brokerage_id", …)` below with only a UUID-shape
// check — any authenticated caller could target another tenant's compliance
// check by id + transaction id. Tenant now comes from the SESSION; the
// parameter is accepted for call-site compatibility and otherwise ignored.
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

  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) {
    return { success: false, error: "Not authenticated" }
  }
  const brokerageId = ctx.brokerageId
  const user = { id: ctx.userId }

  const supabase = createServiceClient()

  // Get current check for context (a refused read is said, never read as "not found")
  const { data: check, error: checkErr } = await supabase
    .from("transaction_compliance_log")
    .select("check_type, check_label, status, is_blocking")
    .eq("id", params.checkId)
    .eq("transaction_id", params.transactionId)
    .eq("brokerage_id", brokerageId)
    .maybeSingle()

  if (checkErr) return { success: false, error: "The compliance check could not be read right now — nothing was changed. Try again in a moment." }
  if (!check) {
    return { success: false, error: "Compliance check not found" }
  }

  // WAVE 152 (lane 152E — "only an authorized, reasoned, audited human override; no approve all; never falsely certify"): a check the
  // closing comparison COMPUTES is cleared only by the comparison; a WAIVER of it — or of any blocking check — is an override that
  // needs the override authority and a written reason, and leaves evidence. The rule is pure (decideComplianceCheckChange).
  const decision = decideComplianceCheckChange({
    checkType: String(check.check_type ?? ""), isBlocking: check.is_blocking === true, toStatus: params.status,
    actorMayOverride: COMPLIANCE_OVERRIDE_USER_TYPES.has(String(ctx.userType ?? "").toLowerCase()), reason: params.resolutionNotes ?? null,
  })
  if (!decision.ok) return { success: false, error: `Nothing was changed: ${decision.reason}.` }

  const previousStatus = check.status

  // Update the check
  const updateData: Record<string, unknown> = {
    status: params.status,
    checked_by: user.id,
    checked_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }

  // Normalize writes: pass/fail
  if (params.status === STATUS_PASS || params.status === STATUS_WAIVED) {
    updateData.resolved_by = user.id
    updateData.resolved_at = new Date().toISOString()
    updateData.resolution_notes = decision.override ? `OVERRIDE by ${ctx.userType}: ${String(params.resolutionNotes ?? "").trim()}` : (params.resolutionNotes ?? null)
  }

  if (params.status === STATUS_FAIL) {
    updateData.failure_reason = params.failureReason ?? null
  }

  const write = async (): Promise<{ updated: number; error: string | null }> => {
    const { data: upd, error: updateError } = await supabase
      .from("transaction_compliance_log")
      .update(updateData)
      .eq("id", params.checkId)
      .eq("transaction_id", params.transactionId)
      .eq("brokerage_id", brokerageId)
      .select("id")
    return { updated: (upd ?? []).length, error: updateError?.message ?? null }
  }

  let wrote: { updated: number; error: string | null }
  if (decision.override) {
    // LAW 5: the override is the consequential act — who, why (the written reason), what check, from → to.
    const { withActionLedger } = await import("@/lib/kernel/action-ledger")
    wrote = await withActionLedger<{ updated: number; error: string | null }>(
      {
        brokerageId,
        action: "compliance.check.override",
        actor: { type: "user", userId: user.id },
        subject: { type: "transaction", id: params.transactionId, ref: String(check.check_type ?? params.checkId) },
        reasonCode: "HUMAN_REQUESTED",
        reasonDetail: String(params.resolutionNotes ?? "").trim().slice(0, 500),
        riskClass: "LEGAL",
        systemSource: "compliance_override",
        idempotencyKey: `compliance-override:${brokerageId}:${params.checkId}:${String(check.status)}->${params.status}:${new Date().toISOString().slice(0, 16)}`,
        detail: { check_id: params.checkId, check_type: check.check_type, check_label: check.check_label, from: previousStatus, to: params.status, user_type: ctx.userType, blocking: check.is_blocking },
      },
      write,
      {
        settle: (r) => r.error ? { status: "failed", outcome: "refused", error: r.error } : r.updated === 1 ? { status: "executed", outcome: "overridden" } : { status: "failed", outcome: "no_row", error: "the override matched no row" },
        replay: (claim) => ({ updated: 0, error: claim.kind === "refused" ? `the override could not be recorded on the action ledger (${claim.error}) — nothing was changed` : "this override was just recorded — refresh to see it" }),
      },
    )
  } else {
    wrote = await write()
  }

  if (wrote.error) {
    return { success: false, error: wrote.error }
  }
  // An UPDATE that matches nothing also resolves (CLAUDE.md §3) — the row is gone or the tenant predicate refused.
  if (wrote.updated === 0) return { success: false, error: "The compliance check was not updated — it no longer exists on this transaction." }

  // A waived computed check settles its own corrective request (and only that one).
  if (decision.override) {
    try {
      const { completeCorrectionRequests } = await import("@/lib/transactions/closing-compliance")
      await completeCorrectionRequests(supabase, { brokerageId, transactionId: params.transactionId, checkLabels: [String(check.check_label ?? "")], completedBy: user.id })
    } catch (err) {
      console.error("[transaction-compliance] the overridden check's corrective request was not settled:", (err as Error)?.message ?? err)
    }
  }

  // Create timeline entry for compliance change (normalized status)
  await sentinelWrite(supabase, supabase.from("transaction_timeline").insert({
    transaction_id: params.transactionId,
    brokerage_id: brokerageId,
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
  }), { table: "transaction_timeline", flow: "transaction_timeline_write", reason: "timeline echo of a compliance update already written (checked above)" })

  revalidatePath(`/dashboard/transactions/${params.transactionId}`)
  revalidatePath("/dashboard/compliance")

  return { success: true }
}

// ─── CAN PROCEED TO CLOSING PREP ────────────────────────────────────────────────

/**
 * Checks if a transaction can proceed to CLOSING_PREP stage.
 * Filters by valid statuses from Supabase: pending, pass, fail, waived, needs_review
 * 
 * ALLOWED to proceed: status = "pass" or "waived"
 * BLOCKED from proceeding: status = "fail", "pending", or "needs_review" (for blocking checks)
 */
// wave 68C (CLAUDE.md §4 IDOR audit): see seedTransactionComplianceChecks above
// — tenant now comes from the SESSION, not the caller-supplied parameter.
export async function canProceedToClosingPrep(
  transactionId: string,
  _brokerageId: string
): Promise<{ allowed: boolean; blockers: string[] }> {
  if (!isValidUUID(transactionId)) return { allowed: false, blockers: ["Invalid transaction ID"] }

  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) return { allowed: false, blockers: ["Not authenticated"] }
  const brokerageId = ctx.brokerageId

  const supabase = createServiceClient()

  // Get all blocking compliance checks - filter by valid statuses from database
  const { data: blockingChecks, error } = await supabase
    .from("transaction_compliance_log")
    .select("id, check_type, check_label, status, is_blocking, failure_reason")
    .eq("transaction_id", transactionId)
    .eq("brokerage_id", brokerageId)
    .eq("is_blocking", true)
    // Only consider valid statuses stored in Supabase
    .in("status", [STATUS_PASS, STATUS_FAIL, STATUS_PENDING, STATUS_WAIVED, STATUS_NEEDS_REVIEW])

  if (error) {
    console.error("[transaction-compliance] Failed to fetch compliance checks:", error)
    return { allowed: false, blockers: ["Failed to verify compliance status"] }
  }

  const blockers: string[] = []

  for (const check of blockingChecks ?? []) {
    // "fail" status blocking checks prevent CLOSING_PREP
    if (check.status === STATUS_FAIL) {
      blockers.push(
        `Compliance failed: ${check.check_label}${check.failure_reason ? ` - ${check.failure_reason}` : ""}`
      )
    }
    // "pending" status blocking checks also prevent CLOSING_PREP
    if (check.status === STATUS_PENDING) {
      blockers.push(`Compliance pending: ${check.check_label}`)
    }
    // "needs_review" status blocking checks also prevent CLOSING_PREP
    if (check.status === STATUS_NEEDS_REVIEW) {
      blockers.push(`Compliance needs review: ${check.check_label}`)
    }
    // "pass" and "waived" statuses are allowed - no action needed
  }

  return {
    allowed: blockers.length === 0,
    blockers,
  }
}

// ─── GET TRANSACTION COMPLIANCE CHECKS ──────────────────────────────────────────

// wave 68C (CLAUDE.md §4 IDOR audit): see seedTransactionComplianceChecks above
// — tenant now comes from the SESSION, not the caller-supplied parameter.
export async function getTransactionComplianceChecks(
  transactionId: string,
  _brokerageId: string
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

  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) return { success: false, checks: [], error: "Not authenticated" }
  const brokerageId = ctx.brokerageId

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
    .from("users")
    .select("brokerage_id, user_type, role")
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

// wave 68C (CLAUDE.md §4 IDOR audit): see seedTransactionComplianceChecks above
// — tenant now comes from the SESSION, not the caller-supplied parameter.
export async function batchPassComplianceChecks(params: {
  checkIds: string[]
  transactionId: string
  brokerageId: string
  resolutionNotes?: string
}): Promise<{ success: boolean; updated: number; refused?: Array<{ id: string; label: string; reason: string }>; error?: string }> {
  if (!isValidUUID(params.transactionId)) return { success: false, updated: 0, error: "Invalid transaction ID" }
  if (!params.checkIds.length) return { success: true, updated: 0 }

  const serverClient = await createClient()
  const { data: { user } } = await serverClient.auth.getUser()

  if (!user) {
    return { success: false, updated: 0, error: "Not authenticated" }
  }

  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) {
    return { success: false, updated: 0, error: "Not authenticated" }
  }
  const brokerageId = ctx.brokerageId

  const supabase = createServiceClient()

  // WAVE 152 (lane 152E — "no indiscriminate 'approve all'"): read what was selected FIRST. A check the closing comparison computes
  // and any BLOCKING check never ride in a batch (decideComplianceCheckChange) — each is named back as refused, so the reviewer
  // opens it on its own; only non-blocking manual review items are passed together.
  const { data: rows, error: readErr } = await supabase
    .from("transaction_compliance_log")
    .select("id, check_type, check_label, is_blocking, status")
    .in("id", params.checkIds)
    .eq("transaction_id", params.transactionId)
    .eq("brokerage_id", brokerageId)
  if (readErr) return { success: false, updated: 0, error: "The selected checks could not be read right now — nothing was changed. Try again in a moment." }
  const refused: Array<{ id: string; label: string; reason: string }> = []
  const passable: string[] = []
  for (const r of (rows ?? []) as Array<{ id: string; check_type: string | null; check_label: string | null; is_blocking: boolean | null }>) {
    const d = decideComplianceCheckChange({ checkType: String(r.check_type ?? ""), isBlocking: r.is_blocking === true, toStatus: STATUS_PASS, actorMayOverride: false, batch: true })
    if (d.ok) passable.push(r.id)
    else refused.push({ id: r.id, label: String(r.check_label ?? r.check_type ?? r.id), reason: d.reason })
  }
  if (passable.length === 0) return { success: true, updated: 0, refused }

  // Normalize writes: use "pass" — counted (CLAUDE.md §3: an UPDATE that matches nothing also resolves)
  const { data: passed, error } = await supabase
    .from("transaction_compliance_log")
    .update({
      status: STATUS_PASS,
      checked_by: user.id,
      checked_at: new Date().toISOString(),
      resolved_by: user.id,
      resolved_at: new Date().toISOString(),
      resolution_notes: params.resolutionNotes ?? null,
      updated_at: new Date().toISOString(),
    })
    .in("id", passable)
    .eq("transaction_id", params.transactionId)
    .eq("brokerage_id", brokerageId)
    .select("id")

  if (error) {
    return { success: false, updated: 0, refused, error: error.message }
  }
  const updated = (passed ?? []).length

  // Log timeline entry
  await sentinelWrite(supabase, supabase.from("transaction_timeline").insert({
    transaction_id: params.transactionId,
    brokerage_id: brokerageId,
    activity_type: "compliance_batch_pass",
    description: `${updated} compliance check${updated === 1 ? "" : "s"} marked as pass${refused.length ? ` (${refused.length} refused — computed or blocking checks are reviewed one at a time)` : ""}`,
    performed_by: user.id,
    metadata: { check_ids: passable, refused_ids: refused.map((r) => r.id), status: STATUS_PASS },
    created_at: new Date().toISOString(),
  }), { table: "transaction_timeline", flow: "transaction_timeline_write", reason: "timeline echo of a batch pass already written (checked above)" })

  revalidatePath(`/dashboard/transactions/${params.transactionId}`)
  revalidatePath("/dashboard/compliance")

  return { success: true, updated, refused }
}
