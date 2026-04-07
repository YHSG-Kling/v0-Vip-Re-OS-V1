"use server"

import { createClient } from "@/lib/supabase/server"
import { KernelEvent } from "@/lib/kernel/events"
import { revalidatePath } from "next/cache"

const LENDER_VISIBLE_MILESTONES = [
  "appraisal_ordered",
  "appraisal_completed",
  "loan_approved",
  "clear_to_close",
  "clear_to_close_received",
] as const

// ─── GET LENDER TRANSACTION DETAIL ───────────────────────────────────────────
export async function getLenderTransactionDetail(transactionId: string, lenderId: string) {
  const supabase = await createClient()

  const { data: lender } = await supabase
    .from("lender_portal_users")
    .select("id, user_id, lender_company, brokerage_id")
    .eq("id", data.lenderId)
    .single()

  if (!lender) throw new Error("Lender not found")

  // Auth: lender is authorized if they are directly assigned to this transaction
  // via lender_portal_users.transaction_id OR via transactions.lender_id
  const isDirectlyAssigned = lender.transaction_id === transactionId

  const { data: txnLenderCheck } = await supabase
    .from("transactions")
    .select("lender_id")
    .eq("id", transactionId)
    .maybeSingle()

  const isTransactionLender = txnLenderCheck?.lender_id === lenderId

  if (!isDirectlyAssigned && !isTransactionLender) {
    throw new Error("Unauthorized: Lender not assigned to this transaction")
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
    .select("id, milestone_name, milestone_type, milestone_date, completed_date, status")
    .eq("transaction_id", transactionId)
    .in("milestone_name", [...LENDER_VISIBLE_MILESTONES])
    .order("milestone_date", { ascending: true, nullsFirst: false })

  const { data: documents } = await supabase
    .from("transaction_documents")
    .select("id, document_type, file_name, file_url, created_at, uploaded_by")
    .eq("transaction_id", transactionId)
    .in("document_type", ["loan_commitment", "appraisal", "closing_disclosure", "loan_conditions"])
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
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) throw new Error("Not authenticated")

  const { data: lender } = await supabase
    .from("lender_portal_users")
    .select("id, email")
    .eq("id", data.lenderId)
    .single()

  if (!lender) throw new Error("Lender not found")

  const { data: document, error } = await supabase
    .from("transaction_documents")
    .insert({
      transaction_id: data.transactionId,
      doc_type: data.documentType,
      doc_label: data.fileName,
      storage_url: data.fileUrl,
      uploaded_by: user.id,
      status: "pending_review",
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
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) throw new Error("Not authenticated")

  const { data: lender } = await supabase
    .from("lender_portal_users")
    .select("id, email, company_name")
    .eq("id", data.lenderId)
    .single()

  if (!lender) throw new Error("Lender not found")

  const { data: transaction } = await supabase
    .from("transactions")
    .select("id, property_address, buyer_contact_id, agent_id, brokerage_id")
    .eq("id", data.transactionId)
    .single()

  if (!transaction) throw new Error("Transaction not found")

  const { error: milestoneError } = await supabase
    .from("transaction_milestones")
    .update({
      status: "completed",
      completed_at: new Date().toISOString(),
    })
    .eq("transaction_id", data.transactionId)
    .in("milestone_name", ["clear_to_close", "clear_to_close_received"])

  if (milestoneError) {
    await supabase.from("transaction_milestones").insert({
      transaction_id: data.transactionId,
      milestone_name: "clear_to_close_received",
      milestone_type: "lender",
      status: "completed",
      completed_at: new Date().toISOString(),
    })
  }

  // Update transaction_lenders by transaction_id (no lender_email column)
  await supabase
    .from("transaction_lenders")
    .update({ underwriting_status: "approved", clear_to_close_date: new Date().toISOString().split("T")[0] })
    .eq("transaction_id", data.transactionId)

  if (transaction.buyer_contact_id) {
    await supabase.from("client_portal_messages").insert({
      contact_id: transaction.buyer_contact_id,
      direction: "outbound",
      channel: "portal",
      body: `Great news! ${lender.lender_company || "Your lender"} has issued Clear to Close for ${transaction.property_address || "your property"}. You are one step closer to closing!`,
      created_at: new Date().toISOString(),
    })
  }

  await supabase.from("lifecycle_events").insert({
    brokerage_id: transaction.brokerage_id,
    event_type: KernelEvent.MILESTONE_COMPLETED,
    entity_type: "transaction",
    entity_id: data.transactionId,
    metadata: {
      milestone_name: "clear_to_close_received",
      issued_by_lender_id: lender.id,
      issued_by_type: "lender",
    },
    created_at: new Date().toISOString(),
  })

  revalidatePath(`/portal/lender/${data.transactionId}`)
  return { success: true }
}

// ─── FLAG LENDER ISSUE ───────────────────────────────────────────────────────
export async function flagLenderIssue(data: {
  transactionId: string
  lenderId: string
  issueDescription: string
}) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) throw new Error("Not authenticated")

  const { data: lender } = await supabase
    .from("lender_portal_users")
    .select("id, user_id, lender_company, brokerage_id")
    .eq("id", data.lenderId)
    .single()

  if (!lender) throw new Error("Lender not found")

  const { data: transaction } = await supabase
    .from("transactions")
    .select("id, property_address, agent_id, brokerage_id")
    .eq("id", data.transactionId)
    .single()

  if (!transaction) throw new Error("Transaction not found")

  const { error: messageError } = await supabase.from("client_portal_messages").insert({
    contact_id: transaction.agent_id,
    direction: "outbound",
    channel: "portal",
    body: `[LENDER ISSUE] ${lender.lender_company || "Lender"} has flagged an issue for ${transaction.property_address || "transaction"}:\n\n${data.issueDescription}`,
    metadata: {
      type: "lender_issue",
      lender_id: data.lenderId,
      transaction_id: data.transactionId,
    },
    created_at: new Date().toISOString(),
  })

  if (messageError) throw messageError

  await supabase.from("lifecycle_events").insert({
    brokerage_id: transaction.brokerage_id,
    event_type: KernelEvent.PORTAL_MODULE_VIEWED,
    entity_type: "transaction",
    entity_id: data.transactionId,
    metadata: {
      module: "lender_issue",
      issued_by_lender_id: lender.id,
      issue_description: data.issueDescription,
    },
    created_at: new Date().toISOString(),
  })

  revalidatePath(`/portal/lender/${data.transactionId}`)
  return { success: true }
}

// ─── UPDATE LOAN STATUS ──────────────────────────────────────────────────────
export async function updateLenderLoanStatus(data: {
  transactionId: string
  lenderId: string
  newStatus: string
}) {
  const supabase = await createClient()

  const { data: lender } = await supabase
    .from("lender_portal_users")
    .select("id, user_id, lender_company")
    .eq("id", data.lenderId)
    .single()

  if (!lender) throw new Error("Lender not found")

  // transaction_lenders has no lender_email — update by transaction_id only
  const { error } = await supabase
    .from("transaction_lenders")
    .update({
      underwriting_status: data.newStatus,
      updated_at: new Date().toISOString(),
    })
    .eq("transaction_id", data.transactionId)

  if (error) throw error

  revalidatePath(`/portal/lender/${data.transactionId}`)
  return { success: true }
}
