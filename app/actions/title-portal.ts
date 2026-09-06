"use server"

import { createClient } from "@/lib/supabase/server"
import { KernelEvent } from "@/lib/kernel/events"
import { requireTitleActor, PortalAuthError } from "@/lib/kernel/portal-auth"
import { TITLE_VISIBLE_MILESTONES, type TitleStatus } from "@/lib/title-portal/constants"

// ─── GET TITLE USER DASHBOARD ────────────────────────────────────────────────
export async function getTitleDashboard(titleUserId: string) {
  // Auth gate — requireTitleActor verifies the session user is mapped to
  // the claimed title_company_user row. Without this, any caller could
  // enumerate any title company's full deal pipeline (purchase prices,
  // close dates, buyer + agent contact info, earnest money status).
  let actor
  try {
    actor = await requireTitleActor(titleUserId)
  } catch (err) {
    if (err instanceof PortalAuthError) throw err
    throw err
  }

  const supabase = await createClient()

  const { data: titleUser } = await supabase
    .from("title_company_users")
    .select("id, user_id, company_name, email, phone")
    .eq("id", actor.titleUserId)
    .single()

  if (!titleUser) {
    throw new Error("Title user not found")
  }

  // Get all transactions assigned to this title company
  //
  // TWO defects in the old embed, either one fatal to the WHOLE query:
  //  1. `agents` has NO first_name / last_name / email / phone — those live on
  //     `users` via agents_user_id_fkey (the only agents→users FK, so an OBJECT).
  //  2. `agents(...)` was UNHINTED, and `transactions` has THREE FKs to agents
  //     (agent_id, buyer_agent_id, seller_agent_id), so PostgREST could not pick
  //     one. It is now pinned to agent_id, the listing/deal agent.
  // The result was that the title company's entire deal pipeline rendered empty.
  const { data: titleEscrowRecords, error: recordsError } = await supabase
    .from("transaction_title_escrow")
    .select(`
      id,
      transaction_id,
      title_company:title_company_name,
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
        closing_date:close_date,
        contract_date,
        purchase_price,
        buyer_contact_id,
        agent_id,
        agents:agent_id(
          id, phone_mobile, phone_office,
          users:user_id(first_name, last_name, email, phone)
        )
      )
    `)
    .eq("title_company_email", titleUser.email)
    .order("created_at", { ascending: false })

  // supabase-js RESOLVES a failed query, so `const { data }` alone reported a
  // rejected select as "this title company has no deals".
  if (recordsError) {
    throw new Error(`Could not load the title pipeline: ${recordsError.message}`)
  }

  // Flattened to the same agent shape the title detail page renders, so a row
  // carries agent identity in one predictable form across both surfaces.
  const records = (titleEscrowRecords ?? []).map((r: any) => {
    const tx = Array.isArray(r.transactions) ? r.transactions[0] : r.transactions
    if (!tx) return r
    const a = tx.agents as Record<string, any> | null
    const u = (a?.users ?? null) as Record<string, any> | null
    return {
      ...r,
      transactions: {
        ...tx,
        agents: a
          ? {
              id: a.id,
              first_name: u?.first_name ?? null,
              last_name: u?.last_name ?? null,
              email: u?.email ?? null,
              phone: a.phone_mobile ?? a.phone_office ?? u?.phone ?? null,
            }
          : null,
      },
    }
  })

  // Calculate dashboard stats
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
  // Auth gate — requireTitleActor verifies the session user is mapped
  // to this title_company_user row.
  let actor
  try {
    actor = await requireTitleActor(titleUserId)
  } catch (err) {
    if (err instanceof PortalAuthError) throw err
    throw err
  }

  const supabase = await createClient()

  const { data: titleUser } = await supabase
    .from("title_company_users")
    .select("id, email, company_name")
    .eq("id", actor.titleUserId)
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
      closing_date:close_date,
      contract_date,
      purchase_price,
      buyer_contact_id,
      seller_contact_id,
      agent_id,
      contacts:buyer_contact_id(id, first_name, last_name, email, phone),
      agents:agent_id(
        id, phone_mobile, phone_office,
        users:user_id(first_name, last_name, email, phone)
      )
    `)
    .eq("id", transactionId)
    .single()

  if (txnError || !transaction) {
    throw new Error("Transaction not found")
  }

  // Fetch milestones (filtered to title-visible ones)
  const { data: milestones } = await supabase
    .from("transaction_milestones")
    .select("id, milestone_name, milestone_type, target_date, completed_date:completed_at, status")
    .eq("transaction_id", transactionId)
    .in("milestone_name", [...TITLE_VISIBLE_MILESTONES])
    .order("target_date", { ascending: true, nullsFirst: false })

  // Fetch documents uploaded by title
  const { data: documents } = await supabase
    .from("transaction_documents")
    .select("id, document_type:doc_type, file_name:doc_label, file_url:storage_url, created_at, uploaded_by")
    .eq("transaction_id", transactionId)
    .in("doc_type", [
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
  const closeDate = transaction.close_date
  if (closeDate) {
    const date = new Date(closeDate)
    const today = new Date()
    daysUntilClose = Math.ceil((date.getTime() - today.getTime()) / (1000 * 60 * 60 * 24))
  }

  // Flattened to the shape the page already renders
  // (app/portal/title/[transactionId]/page.tsx:360-374 reads
  // transaction.agents.first_name / last_name / email / phone), so no consumer
  // changes — but the values are now real.
  const a = (transaction as any).agents as Record<string, any> | null
  const u = (a?.users ?? null) as Record<string, any> | null
  const transactionWithAgent = {
    ...(transaction as any),
    agents: a
      ? {
          id: a.id,
          first_name: u?.first_name ?? null,
          last_name: u?.last_name ?? null,
          email: u?.email ?? null,
          phone: a.phone_mobile ?? a.phone_office ?? u?.phone ?? null,
        }
      : null,
  }

  return {
    transaction: transactionWithAgent,
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
  // Auth gate — wire_instructions especially are CRITICAL (wire fraud
  // vector). Previously any caller could upload a wire-instructions
  // document to any transaction in any tenant.
  let actor
  try {
    actor = await requireTitleActor(data.titleUserId)
  } catch (err) {
    if (err instanceof PortalAuthError) throw err
    throw err
  }

  const supabase = await createClient()

  // Verify this transaction is assigned to the actor's title company
  const { data: titleEscrow } = await supabase
    .from("transaction_title_escrow")
    .select("transaction_id, brokerage_id, transactions(brokerage_id)")
    .eq("transaction_id", data.transactionId)
    .eq("title_company_email", actor.email)
    .maybeSingle()
  if (!titleEscrow) throw new Error("Title company not assigned to this transaction")
  const txBrokerageId = (titleEscrow.transactions as any)?.brokerage_id ?? actor.brokerageId
  if (txBrokerageId !== actor.brokerageId) {
    throw new Error("Forbidden: transaction not in your brokerage scope")
  }

  // Insert document with warning metadata for wire instructions
  const metadata = data.documentType === "wire_instructions"
    ? { sensitive: true, warning: "Wire instructions - verify before sharing" }
    : undefined

  const { data: document, error } = await supabase
    .from("transaction_documents")
    .insert({
      transaction_id: data.transactionId,
      brokerage_id: actor.brokerageId,
      doc_type: data.documentType,
      doc_label: data.fileName,
      storage_url: data.fileUrl,
      uploaded_by: actor.userId,
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
}): Promise<{ success: boolean; error?: string }> {
  let actor
  try {
    actor = await requireTitleActor(data.titleUserId)
  } catch (err) {
    if (err instanceof PortalAuthError) return { success: false, error: err.message }
    throw err
  }
  const titleUserEmail = actor.email

  const supabase = await createClient()
  if (!titleUserEmail) return { success: false, error: "Title user has no email on file" }

  // Update title escrow status
  const { error } = await supabase
    .from("transaction_title_escrow")
    .update({
      title_status: data.newStatus,
      updated_at: new Date().toISOString(),
    })
    .eq("transaction_id", data.transactionId)
    .eq("title_company_email", titleUserEmail)

  if (error) return { success: false, error: error.message }

  const brokerageId = actor.brokerageId
  const eventName =
    data.newStatus === "closing_ready"
      ? KernelEvent.CLOSING_SCHEDULED
      : KernelEvent.JOURNEY_STAGE_UPDATED

  try {
    const { emitTransactionEvent } = await import("@/lib/kernel/transactions")
    await emitTransactionEvent({
      event:       eventName,
      brokerageId,
      entityId:    data.transactionId,
      actorUserId: actor.userId,
      metadata: {
        actor_role:      "title",
        updated_by:      titleUserEmail,
        updated_by_type: "title",
        new_status:      data.newStatus,
        update_type:     "title_status",
      },
    })
  } catch (err) {
    console.error("[updateTitleStatus] fan-out failed (non-blocking)", err)
  }

  // If status is closing_ready or closed, mark the corresponding milestone
  // complete via the canonical helper so its fan-out + deadline mirror fires.
  if (data.newStatus === "closing_ready") {
    try {
      const { completeMilestone } = await import("@/lib/transactions/milestone-service")
      await completeMilestone({
        transactionId: data.transactionId,
        brokerageId,
        milestoneName: "closing_scheduled",
        completedBy:   actor.userId,
      })
    } catch (err) {
      console.error("[updateTitleStatus] closing_scheduled milestone failed", err)
    }
  } else if (data.newStatus === "closed") {
    try {
      const { completeMilestone } = await import("@/lib/transactions/milestone-service")
      await completeMilestone({
        transactionId: data.transactionId,
        brokerageId,
        milestoneName: "closed",
        completedBy:   actor.userId,
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
}): Promise<{ success: boolean; error?: string }> {
  let actor
  try {
    actor = await requireTitleActor(data.titleUserId)
  } catch (err) {
    if (err instanceof PortalAuthError) return { success: false, error: err.message }
    throw err
  }

  const supabase = await createClient()

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
    updated_by: actor.email,
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

  if (error) return { success: false, error: error.message }

  // Fan-out when an item moves to completed so the agent + buyer + seller +
  // lender portals see the closing-prep progress in real time.
  if (data.status === "completed") {
    try {
      const { emitTransactionEvent } = await import("@/lib/kernel/transactions")
      await emitTransactionEvent({
        event:       KernelEvent.MILESTONE_COMPLETED,
        brokerageId: actor.brokerageId,
        entityId:    data.transactionId,
        actorUserId: actor.userId,
        metadata: {
          actor_role:      "title",
          milestone_name:  `closing_prep_${data.itemKey}`,
          item_key:        data.itemKey,
          updated_by:      actor.email,
          notes:           data.notes ?? null,
          update_type:     "closing_prep_item",
        },
      })
    } catch (err) {
      console.error("[updateClosingPrepItem] fan-out failed (non-blocking)", err)
    }
  }

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
  // Auth gate
  let actor
  try {
    actor = await requireTitleActor(data.titleUserId)
  } catch (err) {
    if (err instanceof PortalAuthError) throw err
    throw err
  }

  const supabase = await createClient()

  // Verify title company is assigned to this transaction AND the
  // transaction is in the actor's brokerage scope.
  const { data: titleEscrow } = await supabase
    .from("transaction_title_escrow")
    .select("transaction_id, transactions(brokerage_id, property_address, agent_id)")
    .eq("transaction_id", data.transactionId)
    .eq("title_company_email", actor.email)
    .maybeSingle()
  if (!titleEscrow) throw new Error("Title company not assigned to this transaction")
  const tx = titleEscrow.transactions as any
  if (!tx || tx.brokerage_id !== actor.brokerageId) {
    throw new Error("Forbidden: transaction not in your brokerage scope")
  }

  const { data: titleUser } = await supabase
    .from("title_company_users")
    .select("company_name")
    .eq("id", actor.titleUserId)
    .single()

  const { error } = await supabase.from("client_portal_messages").insert({
    brokerage_id: actor.brokerageId,
    contact_id: tx.agent_id,
    direction: "agent_to_client",
    channel: "portal",
    body: `[TITLE/ESCROW] ${titleUser?.company_name || "Title Company"} re: ${tx.property_address || "Transaction"}:\n\n${data.message}`,
    metadata: {
      type: "title_message",
      title_user_id: actor.titleUserId,
      title_email: actor.email,
      transaction_id: data.transactionId,
    },
    created_at: new Date().toISOString(),
  })

  if (error) throw error

  const { revalidatePath } = await import("next/cache")
  revalidatePath(`/portal/title/${data.transactionId}`)
  return { success: true }
}
