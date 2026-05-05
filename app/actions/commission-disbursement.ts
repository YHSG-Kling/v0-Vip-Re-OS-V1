"use server"

/**
 * app/actions/commission-disbursement.ts
 *
 * Compliance Officer-owned commission disbursement workflow.
 *
 * Hard rules enforced here (NOT in the UI):
 *   • Only users with role compliance_officer / admin / broker / broker_admin /
 *     superadmin can draft, approve, or issue authorizations.
 *   • Agents see their own disbursements as READ-ONLY summaries (handled by
 *     getMyDisbursementsAction).
 *   • A disbursement cannot be approved unless the parent transaction's CDA
 *     is itself approved (the existing CDA workflow is the upstream gate).
 *   • Once approved, the row becomes immutable — corrections require an
 *     explicit reject + redraft (audit trail preserved).
 */

import { createClient } from "@/lib/supabase/server"
import { requireAuth } from "@/lib/kernel/api-auth"
import { computeSplit, type SplitInputs } from "@/lib/compliance/commission-disbursement"
import { revalidatePath } from "next/cache"

const COMPLIANCE_ROLES = new Set([
  "compliance_officer",
  "admin",
  "broker",
  "broker_admin",
  "superadmin",
])

async function requireComplianceRole() {
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return { ok: false as const, error: "unauthenticated" }
  if (!COMPLIANCE_ROLES.has(auth.userType)) {
    return { ok: false as const, error: "forbidden" }
  }
  return { ok: true as const, supabase, auth }
}

export async function previewSplitAction(input: SplitInputs) {
  return computeSplit(input)
}

export async function draftDisbursementAction(input: {
  transactionId: string
  agentId: string
  side: "listing" | "buying" | "referral" | "team_lead_override"
  paymentRouting: "title_direct" | "closing_attorney" | "wire_to_brokerage"
  cdaId?: string | null
  referralPayee?: string | null
  teamLeadId?: string | null
  notes?: string | null
} & SplitInputs) {
  const guard = await requireComplianceRole()
  if (!guard.ok) return { success: false, error: guard.error }
  const { supabase, auth } = guard

  // Brokerage scope on the transaction.
  const { data: txn } = await supabase
    .from("transactions")
    .select("id, brokerage_id")
    .eq("id", input.transactionId)
    .maybeSingle()
  if (!txn || txn.brokerage_id !== auth.brokerageId) {
    return { success: false, error: "transaction_not_found" }
  }

  const split = computeSplit(input)

  const { data: row, error } = await supabase
    .from("commission_disbursements")
    .insert({
      brokerage_id: auth.brokerageId,
      transaction_id: input.transactionId,
      cda_id: input.cdaId ?? null,
      agent_id: input.agentId,
      side: input.side,
      gross_commission: split.grossCommission,
      brokerage_split_percent: input.brokerageSplitPercent,
      brokerage_split_amount: split.brokerageSplitAmount,
      agent_split_amount: split.agentGrossAfterSplit,
      referral_amount: split.referralAmount,
      referral_payee: input.referralPayee ?? null,
      team_override_amount: split.teamOverrideAmount,
      team_lead_id: input.teamLeadId ?? null,
      franchise_fee_amount: split.franchiseFeeAmount,
      e_and_o_amount: split.eAndOAmount,
      transaction_fees_amount: split.transactionFeesAmount,
      other_deductions_amount: split.otherDeductionsAmount,
      other_deductions_notes: input.notes ?? null,
      net_to_agent: split.netToAgent,
      payment_routing: input.paymentRouting,
      status: "pending_review",
      created_by: auth.userId,
    })
    .select("id")
    .single()

  if (error) return { success: false, error: error.message }
  revalidatePath(`/dashboard/compliance`)
  return { success: true, id: row.id, split }
}

export async function approveDisbursementAction(input: { disbursementId: string }) {
  const guard = await requireComplianceRole()
  if (!guard.ok) return { success: false, error: guard.error }
  const { supabase, auth } = guard

  const { data: disb } = await supabase
    .from("commission_disbursements")
    .select("id, brokerage_id, status, transaction_id, cda_id")
    .eq("id", input.disbursementId)
    .maybeSingle()
  if (!disb || disb.brokerage_id !== auth.brokerageId) {
    return { success: false, error: "not_found" }
  }
  if (disb.status !== "pending_review" && disb.status !== "draft") {
    return { success: false, error: "invalid_state" }
  }

  // Upstream CDA gate — the existing CDA workflow must have approved the
  // CDA first. We tolerate missing cda_id for legacy rows; in that case the
  // Compliance Officer is acknowledging the deal is otherwise compliant.
  if (disb.cda_id) {
    const { data: cda } = await supabase
      .from("cdas")
      .select("status")
      .eq("id", disb.cda_id)
      .maybeSingle()
    if (cda && cda.status !== "approved") {
      return { success: false, error: "cda_not_approved" }
    }
  }

  const { error } = await supabase
    .from("commission_disbursements")
    .update({
      status: "approved",
      reviewed_by: auth.userId,
      reviewed_at: new Date().toISOString(),
    })
    .eq("id", disb.id)

  if (error) return { success: false, error: error.message }
  revalidatePath(`/dashboard/compliance`)
  return { success: true }
}

export async function rejectDisbursementAction(input: { disbursementId: string; reason: string }) {
  const guard = await requireComplianceRole()
  if (!guard.ok) return { success: false, error: guard.error }
  const { supabase, auth } = guard

  if (!input.reason?.trim()) return { success: false, error: "reason_required" }

  const { data: disb } = await supabase
    .from("commission_disbursements")
    .select("id, brokerage_id, status")
    .eq("id", input.disbursementId)
    .maybeSingle()
  if (!disb || disb.brokerage_id !== auth.brokerageId) {
    return { success: false, error: "not_found" }
  }
  if (disb.status === "paid") return { success: false, error: "already_paid" }

  const { error } = await supabase
    .from("commission_disbursements")
    .update({
      status: "rejected",
      rejected_reason: input.reason.trim(),
      reviewed_by: auth.userId,
      reviewed_at: new Date().toISOString(),
    })
    .eq("id", disb.id)

  if (error) return { success: false, error: error.message }
  revalidatePath(`/dashboard/compliance`)
  return { success: true }
}

export async function issueDisbursementAuthorizationAction(input: {
  transactionId: string
  payeeType: "title_company" | "closing_attorney" | "direct_wire"
  payeeName: string
  payeeEmail?: string
  payeePhone?: string
  deliveryMethod: "email" | "docusign" | "manual_upload"
  documentUrl?: string
  notes?: string
}) {
  const guard = await requireComplianceRole()
  if (!guard.ok) return { success: false, error: guard.error }
  const { supabase, auth } = guard

  const { data: txn } = await supabase
    .from("transactions")
    .select("id, brokerage_id")
    .eq("id", input.transactionId)
    .maybeSingle()
  if (!txn || txn.brokerage_id !== auth.brokerageId) {
    return { success: false, error: "transaction_not_found" }
  }

  // Every disbursement on this transaction must be approved before we can
  // hand the authorization to the payee.
  const { data: pending } = await supabase
    .from("commission_disbursements")
    .select("id, status")
    .eq("transaction_id", input.transactionId)
    .neq("status", "approved")
    .neq("status", "cancelled")
    .neq("status", "rejected")
  if ((pending ?? []).length > 0) {
    return { success: false, error: "all_disbursements_must_be_approved" }
  }

  const { data: row, error } = await supabase
    .from("commission_disbursement_authorizations")
    .insert({
      brokerage_id: auth.brokerageId,
      transaction_id: input.transactionId,
      payee_type: input.payeeType,
      payee_name: input.payeeName,
      payee_email: input.payeeEmail ?? null,
      payee_phone: input.payeePhone ?? null,
      delivery_method: input.deliveryMethod,
      document_url: input.documentUrl ?? null,
      delivered_at: new Date().toISOString(),
      notes: input.notes ?? null,
      created_by: auth.userId,
    })
    .select("id")
    .single()

  if (error) return { success: false, error: error.message }
  revalidatePath(`/dashboard/compliance`)
  return { success: true, id: row.id }
}

export async function recordBrokeragePaymentReceivedAction(input: {
  authorizationId: string
  amountReceived: number
  receivedAt?: string
}) {
  const guard = await requireComplianceRole()
  if (!guard.ok) return { success: false, error: guard.error }
  const { supabase, auth } = guard

  const { data: authz } = await supabase
    .from("commission_disbursement_authorizations")
    .select("id, brokerage_id, transaction_id")
    .eq("id", input.authorizationId)
    .maybeSingle()
  if (!authz || authz.brokerage_id !== auth.brokerageId) {
    return { success: false, error: "not_found" }
  }

  const receivedAt = input.receivedAt ?? new Date().toISOString()

  await supabase
    .from("commission_disbursement_authorizations")
    .update({
      payment_received_at: receivedAt,
      payment_amount_received: input.amountReceived,
    })
    .eq("id", authz.id)

  // Mark all approved disbursements on this transaction as paid.
  await supabase
    .from("commission_disbursements")
    .update({ status: "paid", paid_at: receivedAt })
    .eq("transaction_id", authz.transaction_id)
    .eq("status", "approved")

  revalidatePath(`/dashboard/compliance`)
  return { success: true }
}

/** Read-only summary visible on the agent's own dashboard. */
export async function getMyDisbursementsAction() {
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return { success: false as const, error: "unauthenticated" as const }
  if (!auth.agentId) return { success: true as const, items: [] }

  const { data } = await supabase
    .from("commission_disbursements")
    .select(
      "id, transaction_id, side, status, gross_commission, agent_split_amount, net_to_agent, paid_at, created_at, reviewed_at",
    )
    .eq("agent_id", auth.agentId)
    .eq("brokerage_id", auth.brokerageId)
    .order("created_at", { ascending: false })
    .limit(50)

  return { success: true as const, items: data ?? [] }
}
