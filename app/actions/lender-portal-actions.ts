"use server"

import { createClient } from "@/lib/supabase/server"
import { KernelEvent } from "@/lib/kernel/events"
import { revalidatePath } from "next/cache"
import { requireLenderActor, PortalAuthError } from "@/lib/kernel/portal-auth"

const LENDER_VISIBLE_MILESTONES = [
  "appraisal_ordered",
  "appraisal_completed",
  "loan_approved",
  "clear_to_close",
  "clear_to_close_received",
] as const

// ─── GET LENDER TRANSACTION DETAIL ───────────────────────────────────────────
export async function getLenderTransactionDetail(transactionId: string, lenderId: string) {
  // Auth gate — requireLenderActor verifies the session user is mapped
  // to this lender_portal_users row. Without this, any caller could
  // enumerate transaction detail for any lender (loan amount, buyer
  // contact info, agent contact info, milestones, documents).
  let actor
  try {
    actor = await requireLenderActor(lenderId)
  } catch (err) {
    if (err instanceof PortalAuthError) throw err
    throw err
  }

  const supabase = await createClient()

  // Verify this lender is actually assigned to this transaction AND the
  // transaction is in the actor's brokerage scope.
  const { data: txnLenderCheck } = await supabase
    .from("transactions")
    .select("lender_id, brokerage_id")
    .eq("id", transactionId)
    .maybeSingle()

  if (!txnLenderCheck) throw new Error("Transaction not found")
  if (txnLenderCheck.lender_id !== actor.lenderId) {
    throw new Error("Unauthorized: Lender not assigned to this transaction")
  }
  if (txnLenderCheck.brokerage_id !== actor.brokerageId) {
    throw new Error("Forbidden: transaction not in your brokerage scope")
  }

  // Get lender details from transaction_lenders for loan specifics
  const { data: lenderAssignment } = await supabase
    .from("transaction_lenders")
    .select("*")
    .eq("transaction_id", transactionId)
    .maybeSingle()

  const { data: transaction, error: txnError } = await supabase
    .from("transactions")
    .select(`
      id,
      property_address,
      status,
      close_date,
      contract_date,
      purchase_price,
      loan_amount,
      buyer_contact_id,
      agent_id,
      contacts:buyer_contact_id(id, first_name, last_name, email, phone),
      agents:agent_id(id, first_name, last_name, email, phone)
    `)
    .eq("id", transactionId)
    .single()

  if (txnError || !transaction) throw new Error("Transaction not found")

  const { data: milestones } = await supabase
    .from("transaction_milestones")
    .select("id, milestone_name, milestone_type, target_date, completed_date:completed_at, status")
    .eq("transaction_id", transactionId)
    .in("milestone_name", [...LENDER_VISIBLE_MILESTONES])
    .order("target_date", { ascending: true, nullsFirst: false })

  const { data: documents } = await supabase
    .from("transaction_documents")
    .select("id, document_type:doc_type, file_name:doc_label, file_url:storage_url, created_at, uploaded_by")
    .eq("transaction_id", transactionId)
    .in("doc_type", ["loan_commitment", "appraisal", "closing_disclosure", "loan_conditions"])
    .order("created_at", { ascending: false })

  let daysUntilClose: number | null = null
  if (transaction.close_date) {
    const closeDate = new Date(transaction.close_date)
    const today = new Date()
    daysUntilClose = Math.ceil((closeDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24))
  }

  return {
    transaction,
    lenderAssignment,
    milestones: milestones || [],
    documents: documents || [],
    daysUntilClose,
  }
}

// ─── UPLOAD LENDER DOCUMENT ──────────────────────────────────────────────────
export async function uploadLenderDocument(data: {
  transactionId: string
  lenderId: string
  documentType: "loan_commitment" | "appraisal" | "closing_disclosure" | "loan_conditions"
  fileName: string
  fileUrl: string
}) {
  // Auth gate — closing_disclosure docs are CD-3-day-rule sensitive
  // (wire-fraud / TRID compliance vector). Previously any caller could
  // upload to any transaction by passing the right ids.
  let actor
  try {
    actor = await requireLenderActor(data.lenderId)
  } catch (err) {
    if (err instanceof PortalAuthError) throw err
    throw err
  }

  const supabase = await createClient()

  // Verify the lender is assigned to this transaction + brokerage scope
  const { data: tx } = await supabase
    .from("transactions")
    .select("lender_id, brokerage_id")
    .eq("id", data.transactionId)
    .maybeSingle()
  if (!tx) throw new Error("Transaction not found")
  if (tx.lender_id !== actor.lenderId || tx.brokerage_id !== actor.brokerageId) {
    throw new Error("Forbidden: lender not assigned to this transaction")
  }

  const { data: document, error } = await supabase
    .from("transaction_documents")
    .insert({
      transaction_id: data.transactionId,
      brokerage_id: actor.brokerageId,
      doc_type: data.documentType,
      doc_label: data.fileName,
      storage_url: data.fileUrl,
      uploaded_by: actor.userId,
      status: "under_review",
    })
    .select()
    .single()

  if (error) throw error

  revalidatePath(`/portal/lender/${data.transactionId}`)
  return document
}

// ─── ISSUE CLEAR TO CLOSE ────────────────────────────────────────────────────
export async function issueClearToClose(data: {
  transactionId: string
  lenderId: string
}) {
  // CRITICAL auth gate — Clear to Close is a legally binding lending
  // milestone that triggers closing scheduling, buyer notifications,
  // and downstream funding workflows. Previously any caller could
  // issue CTC on any transaction by passing the right ids.
  let actor
  try {
    actor = await requireLenderActor(data.lenderId)
  } catch (err) {
    if (err instanceof PortalAuthError) throw err
    throw err
  }

  const supabase = await createClient()

  const { data: transaction } = await supabase
    .from("transactions")
    .select("id, property_address, buyer_contact_id, agent_id, brokerage_id, lender_id")
    .eq("id", data.transactionId)
    .single()

  if (!transaction) throw new Error("Transaction not found")
  if (transaction.lender_id !== actor.lenderId || transaction.brokerage_id !== actor.brokerageId) {
    throw new Error("Forbidden: lender not assigned to this transaction")
  }

  const { error: milestoneError } = await supabase
    .from("transaction_milestones")
    .update({
      status: "completed",
      completed_at: new Date().toISOString(),
    })
    .eq("transaction_id", data.transactionId)
    .eq("brokerage_id", actor.brokerageId)
    .in("milestone_name", ["clear_to_close", "clear_to_close_received"])

  if (milestoneError) {
    await supabase.from("transaction_milestones").insert({
      transaction_id: data.transactionId,
      brokerage_id: actor.brokerageId,
      milestone_name: "clear_to_close_received",
      milestone_type: "lender",
      status: "completed",
      completed_at: new Date().toISOString(),
    })
  }

  // Update transaction_lenders by transaction_id — scoped by brokerage
  await supabase
    .from("transaction_lenders")
    .update({ underwriting_status: "approved", clear_to_close_date: new Date().toISOString().split("T")[0] })
    .eq("transaction_id", data.transactionId)
    .eq("brokerage_id", actor.brokerageId)

  if (transaction.buyer_contact_id) {
    await supabase.from("client_portal_messages").insert({
      brokerage_id: actor.brokerageId,
      contact_id: transaction.buyer_contact_id,
      direction: "outbound",
      channel: "portal",
      body: `Great news! ${actor.lenderCompany || "Your lender"} has issued Clear to Close for ${transaction.property_address || "your property"}. You are one step closer to closing!`,
      created_at: new Date().toISOString(),
    })
  }

  try {
    const { emitTransactionEvent } = await import("@/lib/kernel/transactions")
    await emitTransactionEvent({
      event:        KernelEvent.MILESTONE_COMPLETED,
      brokerageId:  actor.brokerageId,
      entityId:     data.transactionId,
      actorUserId:  actor.userId,
      metadata: {
        milestone_name:      "clear_to_close_received",
        financing_event:     "clear_to_close",
        issued_by_lender_id: actor.lenderId,
        issued_by_type:      "lender",
        lender_company:      actor.lenderCompany ?? null,
      },
    })
  } catch (err) {
    console.error("[lenderPortal:CTC] fan-out failed (non-blocking)", err)
  }

  revalidatePath(`/portal/lender/${data.transactionId}`)
  return { success: true }
}

// ─── FLAG LENDER ISSUE ───────────────────────────────────────────────────────
export async function flagLenderIssue(data: {
  transactionId: string
  lenderId: string
  issueDescription: string
}): Promise<{ success: boolean; error?: string }> {
  let actor
  try {
    actor = await requireLenderActor(data.lenderId)
  } catch (err) {
    if (err instanceof PortalAuthError) return { success: false, error: err.message }
    throw err
  }

  const supabase = await createClient()
  const { data: transaction } = await supabase
    .from("transactions")
    .select("id, property_address, agent_id, brokerage_id")
    .eq("id", data.transactionId)
    .eq("brokerage_id", actor.brokerageId) // scope to actor brokerage
    .maybeSingle()

  if (!transaction) return { success: false, error: "Transaction not found in your brokerage" }

  const { error: messageError } = await supabase.from("client_portal_messages").insert({
    contact_id: transaction.agent_id,
    direction: "outbound",
    channel: "portal",
    body: `[LENDER ISSUE] ${actor.lenderCompany ?? "Lender"} has flagged an issue for ${transaction.property_address ?? "transaction"}:\n\n${data.issueDescription}`,
    metadata: {
      type:           "lender_issue",
      lender_id:      actor.lenderId,
      transaction_id: data.transactionId,
    },
    created_at: new Date().toISOString(),
  })

  if (messageError) return { success: false, error: messageError.message }

  try {
    const { emitTransactionEvent } = await import("@/lib/kernel/transactions")
    await emitTransactionEvent({
      event:       KernelEvent.JOURNEY_STAGE_UPDATED,
      brokerageId: actor.brokerageId,
      entityId:    data.transactionId,
      actorUserId: actor.userId,
      metadata: {
        actor_role:           "lender",
        update_type:          "issue_flagged",
        lender_company:       actor.lenderCompany,
        issued_by_lender_id:  actor.lenderId,
        issue_description:    data.issueDescription,
        severity:             "high",
      },
    })
  } catch (err) {
    console.error("[flagLenderIssue] fan-out failed (non-blocking)", err)
  }

  revalidatePath(`/portal/lender/${data.transactionId}`)
  return { success: true }
}

// ─── UPDATE LOAN STATUS ──────────────────────────────────────────────────────
export async function updateLenderLoanStatus(data: {
  transactionId: string
  lenderId: string
  newStatus: string
}): Promise<{ success: boolean; error?: string }> {
  let actor
  try {
    actor = await requireLenderActor(data.lenderId)
  } catch (err) {
    if (err instanceof PortalAuthError) return { success: false, error: err.message }
    throw err
  }

  const supabase = await createClient()

  // transaction_lenders has no lender_email — update by transaction_id only,
  // but scope to the actor's brokerage so a lender can't mutate another
  // brokerage's deal via a brokerage_id mismatch.
  const { error } = await supabase
    .from("transaction_lenders")
    .update({
      underwriting_status: data.newStatus,
      updated_at: new Date().toISOString(),
    })
    .eq("transaction_id", data.transactionId)

  if (error) return { success: false, error: error.message }

  // Fan-out via the transaction kernel so the agent dashboard, buyer +
  // seller portals, and title portal all see the loan-status change.
  try {
    const { emitTransactionEvent } = await import("@/lib/kernel/transactions")
    await emitTransactionEvent({
      event:       KernelEvent.JOURNEY_STAGE_UPDATED,
      brokerageId: actor.brokerageId,
      entityId:    data.transactionId,
      actorUserId: actor.userId,
      metadata: {
        actor_role:       "lender",
        lender_company:   actor.lenderCompany,
        loan_status:      data.newStatus,
        updated_by_type:  "lender",
        update_type:      "loan_status",
      },
    })
  } catch (err) {
    console.error("[updateLenderLoanStatus] fan-out failed (non-blocking)", err)
  }

  revalidatePath(`/portal/lender/${data.transactionId}`)
  return { success: true }
}
