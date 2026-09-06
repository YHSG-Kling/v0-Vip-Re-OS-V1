"use server"

import { createClient } from "@/lib/supabase/server"
import { KernelEvent } from "@/lib/kernel/events"
import { revalidatePath } from "next/cache"
import { requireLenderVendorActor, PortalAuthError } from "@/lib/kernel/portal-auth"
// TOMBSTONE: the module-private copy of this list is gone. SURVIVOR:
// lib/lenders/visible-milestones.ts:25 — the same five names, now shared with the
// lender portal's display so the entitlement and the query cannot drift (§6).
import { LENDER_VISIBLE_MILESTONES } from "@/lib/lenders/visible-milestones"

// ─── GET LENDER TRANSACTION DETAIL ───────────────────────────────────────────
export async function getLenderTransactionDetail(transactionId: string, _lenderId?: string) {
  // Auth gate — requireLenderVendorActor verifies the session user is a lender
  // vendor ASSIGNED to this transaction (vendor rail). Folds the assignment check
  // in, so any caller could not enumerate transaction detail for a deal they're
  // not the lender on (loan amount, buyer/agent contact, milestones, documents).
  let actor
  try {
    actor = await requireLenderVendorActor(transactionId)
  } catch (err) {
    if (err instanceof PortalAuthError) throw err
    throw err
  }

  const supabase = await createClient()

  // Get lender details from transaction_lenders for loan specifics
  const { data: lenderAssignment } = await supabase
    .from("transaction_lenders")
    .select("*")
    .eq("transaction_id", transactionId)
    .maybeSingle()

  // `agents` has NO first_name / last_name / email / phone (verified against
  // information_schema) — those live on `users`, reached through
  // agents_user_id_fkey, the ONLY FK from agents to users, so the embed is an
  // OBJECT. Naming them here made PostgREST reject the ENTIRE select, so
  // getLenderTransactionDetail always threw "Transaction not found" and the
  // whole lender portal page was dead, not just the agent card.
  // `contacts` genuinely HAS first_name/last_name/email/phone — left as is.
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
      agents:agent_id(
        id, phone_mobile, phone_office,
        users:user_id(first_name, last_name, email, phone)
      )
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

  // Flattened to the shape the page already renders
  // (app/portal/lender/[transactionId]/page.tsx:345-359 reads
  // transaction.agents.first_name / last_name / email / phone), so no consumer
  // changes — but the values are now real. Phone prefers the agent's own
  // client-facing numbers; users.phone is the fallback.
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
    lenderAssignment,
    milestones: milestones || [],
    documents: documents || [],
    daysUntilClose,
  }
}

// ─── UPLOAD LENDER DOCUMENT ──────────────────────────────────────────────────
export async function uploadLenderDocument(data: {
  transactionId: string
  lenderId?: string
  documentType: "loan_commitment" | "appraisal" | "closing_disclosure" | "loan_conditions"
  fileName: string
  fileUrl: string
}) {
  // Auth gate — closing_disclosure docs are CD-3-day-rule sensitive
  // (wire-fraud / TRID compliance vector). requireLenderVendorActor confirms the
  // caller is the lender vendor assigned to THIS transaction.
  let actor
  try {
    actor = await requireLenderVendorActor(data.transactionId)
  } catch (err) {
    if (err instanceof PortalAuthError) throw err
    throw err
  }

  const supabase = await createClient()

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
  lenderId?: string
}) {
  // CRITICAL auth gate — Clear to Close is a legally binding lending milestone
  // that triggers closing scheduling, buyer notifications, and downstream funding.
  // requireLenderVendorActor confirms the caller is the lender vendor assigned to
  // this transaction.
  let actor
  try {
    actor = await requireLenderVendorActor(data.transactionId)
  } catch (err) {
    if (err instanceof PortalAuthError) throw err
    throw err
  }

  const supabase = await createClient()

  const { data: transaction, error: transactionError } = await supabase
    .from("transactions")
    .select("id, property_address, buyer_contact_id, agent_id, brokerage_id")
    .eq("id", data.transactionId)
    .eq("brokerage_id", actor.brokerageId)
    .single()

  if (transactionError || !transaction) throw new Error("Transaction not found")

  const { error: milestoneError } = await supabase
    .from("transaction_milestones")
    .update({
      status: "completed",
      completed_at: new Date().toISOString(),
    })
    .eq("transaction_id", data.transactionId)
    .eq("brokerage_id", actor.brokerageId)
    // Match by canonical identity — the journey now seeds clear_to_close_received with
    // a human milestone_name ("Clear to Close"), so matching milestone_name alone
    // silently completed zero rows. milestone_type covers journey/catalog rows; the
    // legacy snake_case names cover older data.
    .or("milestone_type.eq.clear_to_close_received,milestone_name.eq.clear_to_close_received,milestone_name.eq.clear_to_close")

  if (milestoneError) {
    await supabase.from("transaction_milestones").insert({
      transaction_id: data.transactionId,
      brokerage_id: actor.brokerageId,
      milestone_name: "clear_to_close_received",
      milestone_type: "clear_to_close_received",
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

  // Buyer-facing CTC message. Measured live (client_portal_messages,
  // 2026-08-18): agent_id is NOT NULL (FK agents.id) and transaction_id exists
  // and is nullable — the old insert set neither, so it was refused 23502 on
  // every Clear to Close and the discarded result swallowed the refusal.
  // transaction_id is stamped so the m482 vendor lane can later narrow from
  // has_vendor_seat() to is_assigned_vendor_on_transaction(transaction_id).
  if (transaction.buyer_contact_id && transaction.agent_id) {
    const { error: ctcMessageError } = await supabase.from("client_portal_messages").insert({
      brokerage_id: actor.brokerageId,
      contact_id: transaction.buyer_contact_id,
      agent_id: transaction.agent_id,
      transaction_id: data.transactionId,
      direction: "agent_to_client",
      channel: "portal",
      body: `Great news! ${actor.lenderCompany || "Your lender"} has issued Clear to Close for ${transaction.property_address || "your property"}. You are one step closer to closing!`,
      created_at: new Date().toISOString(),
    })
    if (ctcMessageError) {
      console.error("[lenderPortal:CTC] buyer CTC message refused:", ctcMessageError.message)
    }
  } else {
    console.error(
      `[lenderPortal:CTC] buyer CTC message NOT sent for transaction ${data.transactionId}: ` +
      `${!transaction.buyer_contact_id ? "no buyer_contact_id" : "no agent_id"} on the transaction, and client_portal_messages requires both (NOT NULL)`,
    )
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
        issued_by_vendor_id: actor.vendorId,
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
  lenderId?: string
  issueDescription: string
}): Promise<{ success: boolean; error?: string }> {
  let actor
  try {
    actor = await requireLenderVendorActor(data.transactionId)
  } catch (err) {
    if (err instanceof PortalAuthError) return { success: false, error: err.message }
    throw err
  }

  const supabase = await createClient()
  const { data: transaction } = await supabase
    .from("transactions")
    .select("id, property_address, agent_id, buyer_contact_id, brokerage_id")
    .eq("id", data.transactionId)
    .eq("brokerage_id", actor.brokerageId) // scope to actor brokerage
    .maybeSingle()

  if (!transaction) return { success: false, error: "Transaction not found in your brokerage" }

  // SHAPE FIX, from the live schema (measured 2026-08-18, project
  // hrvaqgvukzxfskkcrwbt): client_portal_messages carries contact_id (NOT NULL,
  // FK contacts.id), agent_id (NOT NULL, FK agents.id), brokerage_id (NOT
  // NULL), nullable transaction_id, and direction CHECK
  // (agent_to_client | client_to_agent). There is NO users-keyed column. The
  // old insert stuffed transactions.agent_id (an agents.id) into contact_id —
  // an FK violation — and set neither agent_id nor brokerage_id (both NOT
  // NULL), so every lender issue flag was refused. The message addresses the
  // AGENT: agent_id = the transaction's agent (already an agents.id, the
  // column's own FK class — no users.id resolution exists for this table),
  // direction = client_to_agent (portal-side → agent, the same lane
  // vendor/portal senders use), threaded on the transaction's buyer contact
  // and stamped with transaction_id.
  if (transaction.agent_id && transaction.buyer_contact_id) {
    const { error: messageError } = await supabase.from("client_portal_messages").insert({
      brokerage_id: actor.brokerageId,
      contact_id: transaction.buyer_contact_id,
      agent_id: transaction.agent_id,
      transaction_id: data.transactionId,
      direction: "client_to_agent",
      channel: "portal",
      body: `[LENDER ISSUE] ${actor.lenderCompany ?? "Lender"} has flagged an issue for ${transaction.property_address ?? "transaction"}:\n\n${data.issueDescription}`,
      metadata: {
        type:      "lender_issue",
        vendor_id: actor.vendorId,
      },
      created_at: new Date().toISOString(),
    })

    if (messageError) return { success: false, error: messageError.message }
  } else {
    // client_portal_messages cannot hold this row (both anchors are NOT NULL).
    // Say so and still emit the kernel event below — the issue itself is not lost.
    console.error(
      `[flagLenderIssue] portal message NOT written for transaction ${data.transactionId}: ` +
      `${!transaction.agent_id ? "no agent_id" : "no buyer_contact_id"} on the transaction; the JOURNEY_STAGE_UPDATED event still carries the issue`,
    )
  }

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
        issued_by_vendor_id:  actor.vendorId,
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
  lenderId?: string
  newStatus: string
}): Promise<{ success: boolean; error?: string }> {
  let actor
  try {
    actor = await requireLenderVendorActor(data.transactionId)
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
