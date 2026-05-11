import { createClient } from "@/lib/supabase/server"
import { KernelEvent } from "@/lib/kernel/events"

// ─── TITLE MILESTONES (visible to title portal) ──────────────────────────────
export const TITLE_VISIBLE_MILESTONES = [
  "title_search_ordered",
  "title_commitment_issued",
  "closing_scheduled",
  "closed",
  "funding_confirmed",
] as const

// ─── TITLE ESCROW STATUS OPTIONS ─────────────────────────────────────────────
export const TITLE_STATUS_OPTIONS = [
  { value: "title_search", label: "Title Search in Progress" },
  { value: "commitment_issued", label: "Commitment Issued" },
  { value: "closing_ready", label: "Closing Ready" },
  { value: "closed", label: "Closed" },
] as const

export type TitleStatus = typeof TITLE_STATUS_OPTIONS[number]["value"]

// ─── GET TITLE USER DASHBOARD ────────────────────────────────────────────────
export async function getTitleDashboard(titleUserId: string) {
  const supabase = await createClient()

  // Get title user profile
  const { data: titleUser } = await supabase
    .from("title_company_users")
    .select("id, user_id, company_name, email, phone")
    .eq("id", titleUserId)
    .single()

  if (!titleUser) {
    throw new Error("Title user not found")
  }

  // Get all transactions assigned to this title company
  const { data: titleEscrowRecords } = await supabase
    .from("transaction_title_escrow")
    .select(`
      id,
      transaction_id,
      title_company,
      escrow_number,
      title_status,
      earnest_money_status,
      earnest_money_amount,
      title_issues,
      created_at,
      updated_at,
      transactions(
        id,
        property_address,
        status,
        close_date,
        closing_date,
        contract_date,
        purchase_price,
        buyer_contact_id,
        agent_id,
        agents(id, first_name, last_name, email, phone)
      )
    `)
    .eq("title_company_email", titleUser.email)
    .order("created_at", { ascending: false })

  // Calculate dashboard stats
  const records = titleEscrowRecords || []
  const activeCount = records.filter((r) => {
    const tx = Array.isArray(r.transactions) ? r.transactions[0] : r.transactions
    return !["closed", "cancelled"].includes(tx?.status || "")
  }).length
  const pendingEarnestMoney = records.filter((r) => r.earnest_money_status === "pending").length
  const titleIssuesCount = records.filter((r) => (r.title_issues?.length || 0) > 0).length
  const readyToClose = records.filter(
    (r) => r.title_status === "closing_ready" || r.title_status === "clear"
  ).length

  // Get closing this week
  const today = new Date()
  const weekFromNow = new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000)
  const closingThisWeek = records.filter((r) => {
    const tx = Array.isArray(r.transactions) ? r.transactions[0] : r.transactions
    const closeDate = tx?.close_date || tx?.closing_date
    if (!closeDate) return false
    const date = new Date(closeDate)
    return date >= today && date <= weekFromNow
  }).length

  return {
    titleUser,
    transactions: records,
    stats: {
      activeCount,
      pendingEarnestMoney,
      titleIssuesCount,
      readyToClose,
      closingThisWeek,
    },
  }
}

// ─── GET TITLE TRANSACTION DETAIL ────────────────────────────────────────────
export async function getTitleTransactionDetail(transactionId: string, titleUserId: string) {
  const supabase = await createClient()

  // Verify title user
  const { data: titleUser } = await supabase
    .from("title_company_users")
    .select("id, email, company_name")
    .eq("id", titleUserId)
    .single()

  if (!titleUser) {
    throw new Error("Title user not found")
  }

  // Check assignment via transaction_title_escrow
  const { data: titleEscrow } = await supabase
    .from("transaction_title_escrow")
    .select("*")
    .eq("transaction_id", transactionId)
    .eq("title_company_email", titleUser.email)
    .single()

  if (!titleEscrow) {
    throw new Error("Unauthorized: Title company not assigned to this transaction")
  }

  // Fetch transaction with related data
  const { data: transaction, error: txnError } = await supabase
    .from("transactions")
    .select(`
      id,
      property_address,
      status,
      close_date,
      closing_date,
      contract_date,
      purchase_price,
      buyer_contact_id,
      seller_contact_id,
      agent_id,
      contacts:buyer_contact_id(id, first_name, last_name, email, phone),
      agents:agent_id(id, first_name, last_name, email, phone)
    `)
    .eq("id", transactionId)
    .single()

  if (txnError || !transaction) {
    throw new Error("Transaction not found")
  }

  // Fetch milestones (filtered to title-visible ones)
  const { data: milestones } = await supabase
    .from("transaction_milestones")
    .select("id, milestone_name, milestone_type, target_date, completed_date, status")
    .eq("transaction_id", transactionId)
    .in("milestone_name", [...TITLE_VISIBLE_MILESTONES])
    .order("target_date", { ascending: true, nullsFirst: false })

  // Fetch documents uploaded by title
  const { data: documents } = await supabase
    .from("transaction_documents")
    .select("id, document_type, file_name, file_url, created_at, uploaded_by")
    .eq("transaction_id", transactionId)
    .in("document_type", [
      "title_commitment",
      "settlement_statement",
      "final_closing_disclosure",
      "wire_instructions",
    ])
    .order("created_at", { ascending: false })

  // Fetch closing prep checklist
  const { data: closingPrep } = await supabase
    .from("transaction_closing_prep")
    .select("*")
    .eq("transaction_id", transactionId)
    .single()

  // Calculate days until close
  let daysUntilClose: number | null = null
  const closeDate = transaction.close_date || transaction.closing_date
  if (closeDate) {
    const date = new Date(closeDate)
    const today = new Date()
    daysUntilClose = Math.ceil((date.getTime() - today.getTime()) / (1000 * 60 * 60 * 24))
  }

  return {
    transaction,
    titleEscrow,
    milestones: milestones || [],
    documents: documents || [],
    closingPrep,
    daysUntilClose,
  }
}

// ─── UPLOAD TITLE DOCUMENT ───────────────────────────────────────────────────
export async function uploadTitleDocument(data: {
  transactionId: string
  titleUserId: string
  documentType: "title_commitment" | "settlement_statement" | "final_closing_disclosure" | "wire_instructions"
  fileName: string
  fileUrl: string
}) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) throw new Error("Not authenticated")

  // Verify title user access
  const { data: titleUser } = await supabase
    .from("title_company_users")
    .select("id, email")
    .eq("id", data.titleUserId)
    .single()

  if (!titleUser) throw new Error("Title user not found")

  // Insert document with warning metadata for wire instructions
  const metadata = data.documentType === "wire_instructions"
    ? { sensitive: true, warning: "Wire instructions - verify before sharing" }
    : undefined

  const { data: document, error } = await supabase
    .from("transaction_documents")
    .insert({
      transaction_id: data.transactionId,
      document_type: data.documentType,
      file_name: data.fileName,
      file_url: data.fileUrl,
      uploaded_by: user.id,
      uploaded_by_type: "title",
      metadata,
    })
    .select()
    .single()

  if (error) throw error

  // Revalidate inside function to avoid module-level server dependency
  const { revalidatePath } = await import("next/cache")
  revalidatePath(`/portal/title/${data.transactionId}`)
  return document
}

// ─── UPDATE TITLE STATUS ─────────────────────────────────────────────────────
export async function updateTitleStatus(data: {
  transactionId: string
  titleUserId: string
  newStatus: TitleStatus
}) {
  const supabase = await createClient()

  // Verify title user access
  const { data: titleUser } = await supabase
    .from("title_company_users")
    .select("id, user_id, email")
    .eq("id", data.titleUserId)
    .single()

  if (!titleUser) throw new Error("Title user not found")

  // Update title escrow status
  const { error } = await supabase
    .from("transaction_title_escrow")
    .update({
      title_status: data.newStatus,
      updated_at: new Date().toISOString(),
    })
    .eq("transaction_id", data.transactionId)
    .eq("title_company_email", titleUser.email)

  if (error) throw error

  // Get brokerage_id for fan-out
  const { data: txn } = await supabase
    .from("transactions")
    .select("brokerage_id")
    .eq("id", data.transactionId)
    .single()
  const brokerageId = txn?.brokerage_id

  // Fan-out via the transaction kernel — replaces the bare lifecycle_events
  // insert. Reaches buyer + seller + lender portals + sequences. Use the
  // dedicated CLOSING_SCHEDULED event when status flips to closing_ready
  // so closing-prep sequences trigger.
  const eventName =
    data.newStatus === "closing_ready"
      ? KernelEvent.CLOSING_SCHEDULED
      : KernelEvent.JOURNEY_STAGE_UPDATED

  if (brokerageId) {
    try {
      const { emitTransactionEvent } = await import("@/lib/kernel/transactions")
      await emitTransactionEvent({
        event:       eventName,
        brokerageId,
        entityId:    data.transactionId,
        actorUserId: titleUser.user_id,
        metadata: {
          actor_role:      "title",
          updated_by:      titleUser.email,
          updated_by_type: "title",
          new_status:      data.newStatus,
          update_type:     "title_status",
        },
      })
    } catch (err) {
      console.error("[updateTitleStatus] fan-out failed (non-blocking)", err)
    }
  }

  // If status is closing_ready or closed, mark the corresponding milestone
  // complete via the canonical helper so its fan-out + deadline mirror fires.
  if (data.newStatus === "closing_ready" && brokerageId) {
    try {
      const { completeMilestone } = await import("@/lib/transactions/milestone-service")
      const { data: { user } } = await supabase.auth.getUser()
      await completeMilestone({
        transactionId: data.transactionId,
        brokerageId,
        milestoneName: "closing_scheduled",
        completedBy:   user?.id ?? titleUser.id,
      })
    } catch (err) {
      console.error("[updateTitleStatus] closing_scheduled milestone failed", err)
    }
  } else if (data.newStatus === "closed" && brokerageId) {
    try {
      const { completeMilestone } = await import("@/lib/transactions/milestone-service")
      const { data: { user } } = await supabase.auth.getUser()
      await completeMilestone({
        transactionId: data.transactionId,
        brokerageId,
        milestoneName: "closed",
        completedBy:   user?.id ?? titleUser.id,
      })
    } catch (err) {
      console.error("[updateTitleStatus] closed milestone failed", err)
    }
  }

  // Revalidate inside function to avoid module-level server dependency
  const { revalidatePath } = await import("next/cache")
  revalidatePath(`/portal/title/${data.transactionId}`)
  return { success: true }
}

// ─── UPDATE CLOSING PREP ITEM ────────────────────────────────────────────────
export async function updateClosingPrepItem(data: {
  transactionId: string
  titleUserId: string
  itemKey: string
  status: "pending" | "in_progress" | "completed"
  notes?: string
}) {
  const supabase = await createClient()

  // Verify title user access
  const { data: titleUser } = await supabase
    .from("title_company_users")
    .select("id, user_id, email")
    .eq("id", data.titleUserId)
    .single()

  if (!titleUser) throw new Error("Title user not found")

  // Get current closing prep
  const { data: currentPrep } = await supabase
    .from("transaction_closing_prep")
    .select("*")
    .eq("transaction_id", data.transactionId)
    .single()

  // Build updated checklist
  const checklist = currentPrep?.checklist || {}
  checklist[data.itemKey] = {
    status: data.status,
    updated_at: new Date().toISOString(),
    updated_by: titleUser.email,
    notes: data.notes,
  }

  // Upsert closing prep record
  const { error } = await supabase
    .from("transaction_closing_prep")
    .upsert({
      transaction_id: data.transactionId,
      checklist,
      status: data.status === "completed" ? "ready" : "in_progress",
      updated_at: new Date().toISOString(),
    }, { onConflict: "transaction_id" })

  if (error) throw error

  // Fan-out when an item moves to completed so the agent + buyer + seller +
  // lender portals see the closing-prep progress in real time.
  if (data.status === "completed") {
    try {
      const { data: txn } = await supabase
        .from("transactions")
        .select("brokerage_id")
        .eq("id", data.transactionId)
        .single()
      if (txn?.brokerage_id) {
        const { emitTransactionEvent } = await import("@/lib/kernel/transactions")
        await emitTransactionEvent({
          event:       KernelEvent.MILESTONE_COMPLETED,
          brokerageId: txn.brokerage_id,
          entityId:    data.transactionId,
          actorUserId: titleUser.user_id,
          metadata: {
            actor_role:      "title",
            milestone_name:  `closing_prep_${data.itemKey}`,
            item_key:        data.itemKey,
            updated_by:      titleUser.email,
            notes:           data.notes ?? null,
            update_type:     "closing_prep_item",
          },
        })
      }
    } catch (err) {
      console.error("[updateClosingPrepItem] fan-out failed (non-blocking)", err)
    }
  }

  // Revalidate inside function to avoid module-level server dependency
  const { revalidatePath } = await import("next/cache")
  revalidatePath(`/portal/title/${data.transactionId}`)
  return { success: true }
}

// ─── SEND MESSAGE TO AGENT ───────────────────────────────────────────────────
export async function sendTitleMessageToAgent(data: {
  transactionId: string
  titleUserId: string
  message: string
}) {
  const supabase = await createClient()

  // Verify title user access
  const { data: titleUser } = await supabase
    .from("title_company_users")
    .select("id, email, company_name")
    .eq("id", data.titleUserId)
    .single()

  if (!titleUser) throw new Error("Title user not found")

  // Get transaction agent
  const { data: transaction } = await supabase
    .from("transactions")
    .select("id, property_address, agent_id")
    .eq("id", data.transactionId)
    .single()

  if (!transaction) throw new Error("Transaction not found")

  // Insert message
  const { error } = await supabase.from("client_portal_messages").insert({
    contact_id: transaction.agent_id,
    direction: "outbound",
    channel: "portal",
    body: `[TITLE/ESCROW] ${titleUser.company_name || "Title Company"} re: ${transaction.property_address || "Transaction"}:\n\n${data.message}`,
    metadata: {
      type: "title_message",
      title_user_id: data.titleUserId,
      title_email: titleUser.email,
      transaction_id: data.transactionId,
    },
    created_at: new Date().toISOString(),
  })

  if (error) throw error

  // Revalidate inside function to avoid module-level server dependency
  const { revalidatePath } = await import("next/cache")
  revalidatePath(`/portal/title/${data.transactionId}`)
  return { success: true }
}
