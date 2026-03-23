import { createClient } from "@/lib/supabase/server"
import { KernelEvent } from "@/lib/kernel/events"

// ─── LENDER MILESTONES (visible to lender portal) ────────────────────────────
export const LENDER_VISIBLE_MILESTONES = [
  "appraisal_ordered",
  "appraisal_completed",
  "loan_approved",
  "clear_to_close",
  "clear_to_close_received",
] as const

// ─── GET LENDER TRANSACTION DETAIL ───────────────────────────────────────────
export async function getLenderTransactionDetail(transactionId: string, lenderId: string) {
  const supabase = await createClient()

  // Verify lender has access to this transaction
  const { data: lender } = await supabase
    .from("lender_portal_users")
    .select("id, email, company_name, assigned_transactions")
    .eq("id", lenderId)
    .single()

  if (!lender) {
    throw new Error("Lender not found")
  }

  // Check assignment - either via assigned_transactions array or transaction_lenders
  const { data: lenderAssignment } = await supabase
    .from("transaction_lenders")
    .select("*")
    .eq("transaction_id", transactionId)
    .eq("lender_email", lender.email)
    .single()

  const isAssignedViaArray = lender.assigned_transactions?.includes(transactionId)

  if (!lenderAssignment && !isAssignedViaArray) {
    throw new Error("Unauthorized: Lender not assigned to this transaction")
  }

  // Fetch transaction with related data
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

  if (txnError || !transaction) {
    throw new Error("Transaction not found")
  }

  // Fetch milestones (filtered to lender-visible ones)
  const { data: milestones } = await supabase
    .from("transaction_milestones")
    .select("id, milestone_name, milestone_type, milestone_date, completed_date, status")
    .eq("transaction_id", transactionId)
    .in("milestone_name", [...LENDER_VISIBLE_MILESTONES])
    .order("milestone_date", { ascending: true, nullsFirst: false })

  // Fetch documents uploaded by lender
  const { data: documents } = await supabase
    .from("transaction_documents")
    .select("id, document_type, file_name, file_url, created_at, uploaded_by")
    .eq("transaction_id", transactionId)
    .in("document_type", ["loan_commitment", "appraisal", "closing_disclosure", "loan_conditions"])
    .order("created_at", { ascending: false })

  // Calculate days until close
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

  // Verify lender access
  const { data: lender } = await supabase
    .from("lender_portal_users")
    .select("id, email")
    .eq("id", data.lenderId)
    .single()

  if (!lender) throw new Error("Lender not found")

  // Insert document — storage_url and doc_label match the transaction_documents schema
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

  // Verify lender access
  const { data: lender } = await supabase
    .from("lender_portal_users")
    .select("id, email, company_name")
    .eq("id", data.lenderId)
    .single()

  if (!lender) throw new Error("Lender not found")

  // Get transaction details for notification
  const { data: transaction } = await supabase
    .from("transactions")
    .select("id, property_address, buyer_contact_id, agent_id")
    .eq("id", data.transactionId)
    .single()

  if (!transaction) throw new Error("Transaction not found")

  // Update the clear_to_close milestone to completed
  const { error: milestoneError } = await supabase
    .from("transaction_milestones")
    .update({
      status: "completed",
      completed_date: new Date().toISOString(),
    })
    .eq("transaction_id", data.transactionId)
    .in("milestone_name", ["clear_to_close", "clear_to_close_received"])

  if (milestoneError) {
    // If milestone doesn't exist, create it
    await supabase.from("transaction_milestones").insert({
      transaction_id: data.transactionId,
      milestone_name: "clear_to_close_received",
      milestone_type: "lender",
      status: "completed",
      completed_date: new Date().toISOString(),
    })
  }

  // Update transaction_lenders loan_status
  await supabase
    .from("transaction_lenders")
    .update({ loan_status: "clear_to_close" })
    .eq("transaction_id", data.transactionId)
    .eq("lender_email", lender.email)

  // Send notification to buyer contact
  if (transaction.buyer_contact_id) {
    await supabase.from("client_portal_messages").insert({
      contact_id: transaction.buyer_contact_id,
      direction: "outbound",
      channel: "portal",
      body: `Great news! ${lender.company_name || "Your lender"} has issued Clear to Close for ${transaction.property_address || "your property"}. You are one step closer to closing!`,
      created_at: new Date().toISOString(),
    })
  }

  // Log kernel event - get brokerage from transaction
  const { data: txn } = await supabase.from("transactions").select("brokerage_id").eq("id", data.transactionId).single()
  await supabase.from("lifecycle_events").insert({
    brokerage_id: txn?.brokerage_id,
    event_type: KernelEvent.MILESTONE_COMPLETED,
    entity_type: "transaction",
    entity_id: data.transactionId,
    metadata: {
      milestone_name: "clear_to_close_received",
      issued_by: lender.email,
      issued_by_type: "lender",
    },
    created_at: new Date().toISOString(),
  })

  // Revalidate inside function to avoid module-level server dependency
  const { revalidatePath } = await import("next/cache")
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

  // Verify lender access
  const { data: lender } = await supabase
    .from("lender_portal_users")
    .select("id, email, company_name")
    .eq("id", data.lenderId)
    .single()

  if (!lender) throw new Error("Lender not found")

  // Get transaction details
  const { data: transaction } = await supabase
    .from("transactions")
    .select("id, property_address, agent_id")
    .eq("id", data.transactionId)
    .single()

  if (!transaction) throw new Error("Transaction not found")

  // Get agent contact info
  const { data: agent } = await supabase
    .from("agents")
    .select("id, first_name, last_name, email")
    .eq("id", transaction.agent_id)
    .single()

  // Insert message to agent via client_portal_messages (agent will see it in their dashboard)
  const { error: messageError } = await supabase.from("client_portal_messages").insert({
    contact_id: transaction.agent_id, // Using agent_id as contact reference for internal messaging
    direction: "outbound",
    channel: "portal",
    body: `[LENDER ISSUE] ${lender.company_name || "Lender"} has flagged an issue for ${transaction.property_address || "transaction"}:\n\n${data.issueDescription}`,
    metadata: {
      type: "lender_issue",
      lender_id: data.lenderId,
      lender_email: lender.email,
      transaction_id: data.transactionId,
    },
    created_at: new Date().toISOString(),
  })

  if (messageError) throw messageError

  // Log kernel event - get brokerage from transaction
  const { data: txnForEvent } = await supabase.from("transactions").select("brokerage_id").eq("id", data.transactionId).single()
  await supabase.from("lifecycle_events").insert({
    brokerage_id: txnForEvent?.brokerage_id,
    event_type: KernelEvent.PORTAL_MODULE_VIEWED,
    entity_type: "transaction",
    entity_id: data.transactionId,
    metadata: {
      module: "lender_issue",
      issued_by: lender.email,
      issue_description: data.issueDescription,
    },
    created_at: new Date().toISOString(),
  })

  // Revalidate inside function to avoid module-level server dependency
  const { revalidatePath } = await import("next/cache")
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

  // Verify lender access
  const { data: lender } = await supabase
    .from("lender_portal_users")
    .select("id, email")
    .eq("id", data.lenderId)
    .single()

  if (!lender) throw new Error("Lender not found")

  // Update loan status
  const { error } = await supabase
    .from("transaction_lenders")
    .update({
      loan_status: data.newStatus,
      updated_at: new Date().toISOString(),
    })
    .eq("transaction_id", data.transactionId)
    .eq("lender_email", lender.email)

  if (error) throw error

  // Revalidate inside function to avoid module-level server dependency
  const { revalidatePath } = await import("next/cache")
  revalidatePath(`/portal/lender/${data.transactionId}`)
  return { success: true }
}
