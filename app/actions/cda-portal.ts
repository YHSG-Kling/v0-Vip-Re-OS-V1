"use server"

/**
 * app/actions/cda-portal.ts
 *
 * The CDA workflow as the user described it:
 *
 *   ┌───────────────────────────────────────────────────────────────────────┐
 *   │ 1. TC or Title/Closing Attorney uploads PRELIMINARY CD to portal      │
 *   │    → notifyAgentOfPreliminaryCdAction                                 │
 *   │    → CDA row created with status = 'pending' (drafting)               │
 *   │    → closing_notifications + activity to agent                        │
 *   │                                                                       │
 *   │ 2. Agent fills out the CDA in the portal                              │
 *   │    → draftOrUpdateCdaAction (writes commission_breakdown + notes)     │
 *   │                                                                       │
 *   │ 3. Agent signs off + submits to compliance                            │
 *   │    → submitCdaForApprovalAction                                       │
 *   │    → status: pending|drafting → submitted                             │
 *   │    → revision row stamped action='submitted'                          │
 *   │                                                                       │
 *   │ 4. Compliance Manager:                                                │
 *   │    a. Approves                                                        │
 *   │       → approveCdaAction                                              │
 *   │       → status: submitted → approved                                  │
 *   │       → triggers downstream commission_distributions flow             │
 *   │    OR                                                                 │
 *   │    b. Sends back with changes                                         │
 *   │       → requestCdaChangesAction(reason)                               │
 *   │       → status: submitted → changes_requested                         │
 *   │       → revision_number incremented                                   │
 *   │       → notification + activity to agent                              │
 *   │                                                                       │
 *   │ 5. Agent makes the changes and re-submits → loops back to step 3      │
 *   └───────────────────────────────────────────────────────────────────────┘
 *
 * Hard rules:
 *   • Only the assigned agent can draft, edit, or submit the CDA.
 *   • Only compliance_officer / admin / broker / broker_admin / superadmin
 *     can approve or send back.
 *   • Approval is blocked unless the agent has signed off.
 *   • Every state change writes an audit row to
 *     closing_disclosure_agreement_revisions.
 *
 * Tables used (all already in DB — no new tables introduced here):
 *   closing_disclosure_agreement, closing_disclosure_agreement_revisions,
 *   closing_notifications, transaction_documents, activities, transactions
 */

import { createClient } from "@/lib/supabase/server"
import { requireAuth } from "@/lib/kernel/api-auth"
import { revalidatePath } from "next/cache"

const COMPLIANCE_ROLES = new Set([
  "compliance_officer",
  "admin",
  "broker",
  "broker_admin",
  "superadmin",
])

type CdaAction =
  | "drafted"
  | "submitted"
  | "signed_off"
  | "changes_requested"
  | "approved"
  | "rejected"
  | "cancelled"

async function recordRevision(opts: {
  cdaId: string
  revisionNumber: number
  status: string
  action: CdaAction
  commissionBreakdown?: Record<string, unknown> | null
  notes?: string | null
  changesRequestedNotes?: string | null
  actedBy: string
}) {
  const supabase = await createClient()
  await supabase.from("closing_disclosure_agreement_revisions").insert({
    cda_id: opts.cdaId,
    revision_number: opts.revisionNumber,
    status_at_snapshot: opts.status,
    action: opts.action,
    commission_breakdown: opts.commissionBreakdown ?? null,
    notes: opts.notes ?? null,
    changes_requested_notes: opts.changesRequestedNotes ?? null,
    acted_by: opts.actedBy,
  })
}

// ─── 1. Preliminary CD upload trigger ────────────────────────────────────────

/**
 * Called immediately after a TC or title/closing-attorney user inserts a
 * row into transaction_documents with doc_type IN ('preliminary_closing_disclosure',
 * 'closing_disclosure'). Idempotent — if a CDA already exists for the
 * transaction, the prelim CD pointer is just attached to it.
 */
export async function notifyAgentOfPreliminaryCdAction(input: {
  transactionId: string
  documentId: string
}) {
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return { success: false as const, error: "unauthenticated" }

  const { data: txn } = await supabase
    .from("transactions")
    .select("id, brokerage_id, agent_id, property_address")
    .eq("id", input.transactionId)
    .maybeSingle()
  if (!txn || txn.brokerage_id !== auth.brokerageId) {
    return { success: false as const, error: "transaction_not_found" }
  }

  const { data: agent } = await supabase
    .from("agents")
    .select("id, user_id")
    .eq("id", txn.agent_id ?? "")
    .maybeSingle()

  if (!agent?.user_id) return { success: false as const, error: "agent_user_not_found" }

  // Find or create the CDA row.
  const { data: existing } = await supabase
    .from("closing_disclosure_agreement")
    .select("id, revision_number")
    .eq("transaction_id", input.transactionId)
    .maybeSingle()

  let cdaId: string
  if (existing) {
    await supabase
      .from("closing_disclosure_agreement")
      .update({
        preliminary_cd_uploaded_at: new Date().toISOString(),
        preliminary_cd_document_id: input.documentId,
        preliminary_cd_uploaded_by: auth.userId,
        // Don't downgrade status if the agent already started drafting.
      })
      .eq("id", existing.id)
    cdaId = existing.id
  } else {
    const { data: created, error } = await supabase
      .from("closing_disclosure_agreement")
      .insert({
        transaction_id: input.transactionId,
        brokerage_id: txn.brokerage_id,
        agent_id: txn.agent_id,
        status: "pending",
        preliminary_cd_uploaded_at: new Date().toISOString(),
        preliminary_cd_document_id: input.documentId,
        preliminary_cd_uploaded_by: auth.userId,
        revision_number: 1,
      })
      .select("id")
      .single()
    if (error || !created) return { success: false as const, error: error?.message ?? "create_failed" }
    cdaId = created.id
  }

  // closing_notifications row (existing table — used by the closing UI).
  await supabase.from("closing_notifications").insert({
    transaction_id: input.transactionId,
    notification_type: "preliminary_cd_received",
    sent_to_user_id: agent.user_id,
    message: `Preliminary CD has been uploaded for ${txn.property_address ?? "the transaction"}. Please draft the CDA in the portal.`,
  })

  // In-app notification + activity (existing tables).
  await supabase.from("notifications").insert({
    user_id: agent.user_id,
    brokerage_id: txn.brokerage_id,
    type: "preliminary_cd_received",
    title: "Preliminary CD ready",
    body: `Preliminary CD uploaded${txn.property_address ? ` for ${txn.property_address}` : ""}. Draft your CDA now.`,
    entity_type: "transaction",
    entity_id: input.transactionId,
    priority: "high",
    channel: "in_app",
  })

  await supabase.from("activities").insert({
    transaction_id: input.transactionId,
    brokerage_id: txn.brokerage_id,
    agent_id: txn.agent_id,
    entity_type: "transaction",
    activity_type: "preliminary_cd_received",
    title: "Preliminary CD received",
    description: "TC / title uploaded the preliminary closing disclosure. CDA draft required.",
    priority: "high",
    status: "pending",
    notes: JSON.stringify({ cda_id: cdaId, document_id: input.documentId }),
  })

  // ── Cross-party notifications + task (additive) ───────────────────────
  // Existing code above notified the AGENT. Spec calls for cross-portal
  // fan-out so TC + buyer/seller portals also see the CD landed.

  // Resolve TC for this transaction (if assigned) and notify them too.
  const { data: txnFull } = await supabase
    .from("transactions")
    .select("coordinator_id, buyer_contact_id, seller_contact_id, contact_id")
    .eq("id", input.transactionId)
    .maybeSingle()
  const tcUserId = (txnFull as any)?.coordinator_id ?? null
  if (tcUserId) {
    await supabase.from("notifications").insert({
      user_id:      tcUserId,
      brokerage_id: txn.brokerage_id,
      type:         "preliminary_cd_received",
      title:        "Preliminary CD ready for CDA",
      body:         `Preliminary CD uploaded${txn.property_address ? ` for ${txn.property_address}` : ""}. Coordinate with the agent on the CDA.`,
      entity_type:  "transaction",
      entity_id:    input.transactionId,
      priority:     "high",
      channel:      "in_app",
    })
  }

  // Create a "Draft and submit CDA" task for the agent so it shows up in
  // their tasks queue alongside the notification. Resolve agents.id as
  // assigned_to_agent_id (FK target).
  await supabase.from("tasks").insert({
    brokerage_id:         txn.brokerage_id,
    contact_id:           (txnFull as any)?.buyer_contact_id
                          ?? (txnFull as any)?.contact_id
                          ?? null,
    transaction_id:       input.transactionId,
    assigned_to_agent_id: txn.agent_id,
    title:                "Draft and submit CDA",
    description:          `Preliminary CD landed. Open the transaction to draft your commission disbursement, sign off, and submit to compliance for approval.`,
    due_date:             new Date(Date.now() + 2 * 86_400_000).toISOString(),
    assignee_type:        "agent",
    source:               "cda_workflow",
    status:               "pending",
    priority:             "high",
  })

  // Fan out via the canonical kernel event router so any sequences listening
  // for CD_RECEIVED auto-enroll, buyer/seller portals get a transparency
  // update (when a template exists for the event), and downstream listeners
  // pick it up uniformly.
  try {
    const { fanOutKernelEvent } = await import("@/lib/kernel/event-fanout")
    const { KernelEvent }       = await import("@/lib/kernel/events")
    await fanOutKernelEvent({
      event:           KernelEvent.CD_RECEIVED,
      brokerageId:     txn.brokerage_id,
      entityType:      "transaction",
      entityId:        input.transactionId,
      transactionId:   input.transactionId,
      buyerContactId:  (txnFull as any)?.buyer_contact_id  ?? undefined,
      sellerContactId: (txnFull as any)?.seller_contact_id ?? undefined,
      contactId:       (txnFull as any)?.contact_id        ?? undefined,
      agentUserId:     auth.userId,
      metadata:        { cdaId, documentId: input.documentId },
    })
  } catch { /* fan-out is best-effort; agent + TC already notified above */ }

  revalidatePath(`/dashboard/transactions/${input.transactionId}`)
  return { success: true as const, cdaId }
}

// ─── 2. Agent draft / update ─────────────────────────────────────────────────

export async function draftOrUpdateCdaAction(input: {
  transactionId: string
  commissionBreakdown: Record<string, unknown>
  notes?: string
  grossCommission?: number
  agentNet?: number
  brokerageNet?: number
}) {
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return { success: false as const, error: "unauthenticated" }

  const { data: txn } = await supabase
    .from("transactions")
    .select("id, brokerage_id, agent_id")
    .eq("id", input.transactionId)
    .maybeSingle()
  if (!txn || txn.brokerage_id !== auth.brokerageId) {
    return { success: false as const, error: "transaction_not_found" }
  }
  // Only the assigned agent can draft.
  if (auth.agentId !== txn.agent_id) {
    return { success: false as const, error: "only_assigned_agent_can_draft" }
  }

  const { data: existing } = await supabase
    .from("closing_disclosure_agreement")
    .select("id, status, revision_number")
    .eq("transaction_id", input.transactionId)
    .maybeSingle()

  // Lock once approved.
  if (existing && existing.status === "approved") {
    return { success: false as const, error: "cda_already_approved" }
  }

  // Status transitions: pending|changes_requested → drafting; submitted stays.
  const nextStatus =
    !existing || existing.status === "pending" || existing.status === "awaiting_preliminary_cd"
      ? "drafting"
      : existing.status === "changes_requested"
        ? "drafting"
        : existing.status

  const payload = {
    commission_breakdown: input.commissionBreakdown,
    notes: input.notes ?? null,
    gross_commission: input.grossCommission ?? null,
    agent_net: input.agentNet ?? null,
    brokerage_net: input.brokerageNet ?? null,
    status: nextStatus,
    agent_drafted_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }

  let cdaId: string
  let revision = 1
  if (existing) {
    cdaId = existing.id
    revision = existing.revision_number
    await supabase.from("closing_disclosure_agreement").update(payload).eq("id", cdaId)
  } else {
    const { data: created, error } = await supabase
      .from("closing_disclosure_agreement")
      .insert({
        ...payload,
        transaction_id: input.transactionId,
        brokerage_id: txn.brokerage_id,
        agent_id: txn.agent_id,
        revision_number: 1,
      })
      .select("id")
      .single()
    if (error || !created) return { success: false as const, error: error?.message ?? "create_failed" }
    cdaId = created.id
  }

  await recordRevision({
    cdaId,
    revisionNumber: revision,
    status: nextStatus,
    action: "drafted",
    commissionBreakdown: input.commissionBreakdown,
    notes: input.notes ?? null,
    actedBy: auth.userId,
  })

  revalidatePath(`/dashboard/transactions/${input.transactionId}`)
  return { success: true as const, cdaId, status: nextStatus }
}

// ─── 3. Agent sign-off + submit ──────────────────────────────────────────────

export async function submitCdaForApprovalAction(input: { cdaId: string }) {
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return { success: false as const, error: "unauthenticated" }

  const { data: cda } = await supabase
    .from("closing_disclosure_agreement")
    .select("id, transaction_id, brokerage_id, agent_id, status, revision_number")
    .eq("id", input.cdaId)
    .maybeSingle()
  if (!cda || cda.brokerage_id !== auth.brokerageId) {
    return { success: false as const, error: "not_found" }
  }
  if (auth.agentId !== cda.agent_id) {
    return { success: false as const, error: "only_assigned_agent_can_submit" }
  }
  if (!["pending", "drafting", "changes_requested"].includes(cda.status)) {
    return { success: false as const, error: `cannot_submit_from_status:${cda.status}` }
  }

  const now = new Date().toISOString()
  await supabase
    .from("closing_disclosure_agreement")
    .update({
      status: "submitted",
      agent_signed_off_at: now,
      agent_signed_off_by: auth.userId,
      agent_submitted_at: now,
      agent_submitted_by: auth.userId,
      updated_at: now,
    })
    .eq("id", cda.id)

  await recordRevision({
    cdaId: cda.id,
    revisionNumber: cda.revision_number,
    status: "submitted",
    action: "submitted",
    actedBy: auth.userId,
  })

  // Run signature/initials pre-scan so compliance sees gate status the
  // moment the CDA hits their queue. Best-effort — never blocks submission.
  // Approval-time gate is enforced separately in approveCdaAction.
  try {
    await runSignatureCheckForCdaAction({ cdaId: cda.id })
  } catch { /* informational pre-scan; approval gate still enforces */ }

  // Notify compliance for the brokerage.
  const { data: complianceUsers } = await supabase
    .from("users")
    .select("id")
    .eq("brokerage_id", cda.brokerage_id)
    .in("user_type", ["compliance_officer", "admin", "broker", "broker_admin"])

  for (const u of complianceUsers ?? []) {
    await supabase.from("notifications").insert({
      user_id: u.id,
      brokerage_id: cda.brokerage_id,
      type: "cda_submitted",
      title: "CDA submitted for approval",
      body: "Agent has signed off and submitted a CDA for review.",
      entity_type: "transaction",
      entity_id: cda.transaction_id,
      priority: "normal",
      channel: "in_app",
    })
  }

  await supabase.from("closing_notifications").insert({
    transaction_id: cda.transaction_id,
    notification_type: "cda_submitted",
    message: "Agent submitted CDA for compliance approval.",
  })

  revalidatePath(`/dashboard/transactions/${cda.transaction_id}`)
  revalidatePath(`/dashboard/compliance`)
  return { success: true as const }
}

// ─── 4a. Compliance approves ─────────────────────────────────────────────────

export async function approveCdaAction(input: { cdaId: string }) {
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return { success: false as const, error: "unauthenticated" }
  if (!COMPLIANCE_ROLES.has(auth.userType)) {
    return { success: false as const, error: "forbidden" }
  }

  const { data: cda } = await supabase
    .from("closing_disclosure_agreement")
    .select(
      "id, transaction_id, brokerage_id, agent_id, status, agent_signed_off_at, revision_number, signature_check_passed, manual_override_by",
    )
    .eq("id", input.cdaId)
    .maybeSingle()
  if (!cda || cda.brokerage_id !== auth.brokerageId) {
    return { success: false as const, error: "not_found" }
  }
  if (cda.status !== "submitted") {
    return { success: false as const, error: `cannot_approve_from_status:${cda.status}` }
  }
  if (!cda.agent_signed_off_at) {
    return { success: false as const, error: "agent_signoff_required" }
  }
  // Approval gate — required signatures/initials must be present on every
  // transaction document, OR a compliance manager must have invoked manual
  // override (with a logged reason). signature_check_passed === null is
  // grandfathered for legacy CDAs created before the gate existed.
  if (cda.signature_check_passed === false && !cda.manual_override_by) {
    return {
      success: false as const,
      error: "signature_check_failed_use_manual_override",
    }
  }

  const now = new Date().toISOString()
  await supabase
    .from("closing_disclosure_agreement")
    .update({
      status: "approved",
      compliance_approved_at: now,
      compliance_approved_by: auth.userId,
      broker_approved_at: now,
      broker_id: auth.userId,
      updated_at: now,
    })
    .eq("id", cda.id)

  await recordRevision({
    cdaId: cda.id,
    revisionNumber: cda.revision_number,
    status: "approved",
    action: "approved",
    actedBy: auth.userId,
  })

  // Mark the cda_delivered milestone complete (existing pattern).
  await supabase
    .from("transaction_milestones")
    .update({ status: "completed", completed_at: now })
    .eq("transaction_id", cda.transaction_id)
    .eq("milestone_name", "cda_delivered")

  // Notify agent.
  const { data: agentRow } = await supabase
    .from("agents")
    .select("user_id")
    .eq("id", cda.agent_id)
    .maybeSingle()
  if (agentRow?.user_id) {
    await supabase.from("notifications").insert({
      user_id: agentRow.user_id,
      brokerage_id: cda.brokerage_id,
      type: "cda_approved",
      title: "CDA approved",
      body: "Compliance approved your CDA. You're cleared for closing.",
      entity_type: "transaction",
      entity_id: cda.transaction_id,
      priority: "normal",
      channel: "in_app",
    })
  }

  revalidatePath(`/dashboard/transactions/${cda.transaction_id}`)
  revalidatePath(`/dashboard/compliance`)
  return { success: true as const }
}

// ─── 4b. Compliance sends back with changes ──────────────────────────────────

export async function requestCdaChangesAction(input: { cdaId: string; reason: string }) {
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return { success: false as const, error: "unauthenticated" }
  if (!COMPLIANCE_ROLES.has(auth.userType)) {
    return { success: false as const, error: "forbidden" }
  }
  if (!input.reason?.trim()) return { success: false as const, error: "reason_required" }

  const { data: cda } = await supabase
    .from("closing_disclosure_agreement")
    .select("id, transaction_id, brokerage_id, agent_id, status, revision_number")
    .eq("id", input.cdaId)
    .maybeSingle()
  if (!cda || cda.brokerage_id !== auth.brokerageId) {
    return { success: false as const, error: "not_found" }
  }
  if (cda.status !== "submitted") {
    return { success: false as const, error: `cannot_send_back_from_status:${cda.status}` }
  }

  const now = new Date().toISOString()
  const nextRevision = cda.revision_number + 1
  await supabase
    .from("closing_disclosure_agreement")
    .update({
      status: "changes_requested",
      changes_requested_at: now,
      changes_requested_by: auth.userId,
      changes_requested_notes: input.reason.trim(),
      // Clear sign-off — agent has to re-sign on re-submit.
      agent_signed_off_at: null,
      agent_signed_off_by: null,
      revision_number: nextRevision,
      updated_at: now,
    })
    .eq("id", cda.id)

  await recordRevision({
    cdaId: cda.id,
    revisionNumber: cda.revision_number,
    status: "changes_requested",
    action: "changes_requested",
    changesRequestedNotes: input.reason.trim(),
    actedBy: auth.userId,
  })

  // Notify agent.
  const { data: agentRow } = await supabase
    .from("agents")
    .select("user_id")
    .eq("id", cda.agent_id)
    .maybeSingle()
  if (agentRow?.user_id) {
    await supabase.from("notifications").insert({
      user_id: agentRow.user_id,
      brokerage_id: cda.brokerage_id,
      type: "cda_changes_requested",
      title: "CDA needs changes",
      body: `Compliance returned the CDA with notes: ${input.reason.trim().slice(0, 200)}`,
      entity_type: "transaction",
      entity_id: cda.transaction_id,
      priority: "high",
      channel: "in_app",
    })
  }

  await supabase.from("closing_notifications").insert({
    transaction_id: cda.transaction_id,
    notification_type: "cda_changes_requested",
    message: `Compliance returned CDA with changes: ${input.reason.trim().slice(0, 280)}`,
  })

  revalidatePath(`/dashboard/transactions/${cda.transaction_id}`)
  revalidatePath(`/dashboard/compliance`)
  return { success: true as const }
}

// ─── Reads ───────────────────────────────────────────────────────────────────

export async function getCdaForTransactionAction(transactionId: string) {
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return { success: false as const, error: "unauthenticated" }

  const { data: cda } = await supabase
    .from("closing_disclosure_agreement")
    .select(
      `id, transaction_id, brokerage_id, agent_id, status, revision_number,
       commission_breakdown, notes, gross_commission, agent_net, brokerage_net,
       preliminary_cd_uploaded_at, preliminary_cd_document_id,
       agent_drafted_at, agent_signed_off_at, agent_submitted_at,
       compliance_approved_at, compliance_approved_by,
       changes_requested_at, changes_requested_notes,
       created_at, updated_at`,
    )
    .eq("transaction_id", transactionId)
    .maybeSingle()
  if (!cda || cda.brokerage_id !== auth.brokerageId) {
    return { success: true as const, cda: null }
  }

  const { data: revisions } = await supabase
    .from("closing_disclosure_agreement_revisions")
    .select("id, revision_number, action, status_at_snapshot, notes, changes_requested_notes, acted_at, acted_by")
    .eq("cda_id", cda.id)
    .order("acted_at", { ascending: false })

  return { success: true as const, cda, revisions: revisions ?? [] }
}

// ─── 0. Preliminary CD upload entry point (TC / title / closing attorney) ────

/**
 * Single entry point any uploader (TC, title company user, closing attorney)
 * calls to upload the preliminary CD. Writes the document row using the
 * actual production column names (doc_type / doc_label / storage_url) and
 * then fires the agent notification.
 */
export async function uploadPreliminaryCdAction(input: {
  transactionId: string
  fileName: string
  fileUrl: string
  uploadedByRole: "tc" | "title_agent" | "closing_attorney"
}) {
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return { success: false as const, error: "unauthenticated" }

  const { data: txn } = await supabase
    .from("transactions")
    .select("id, brokerage_id, agent_id, property_address")
    .eq("id", input.transactionId)
    .maybeSingle()
  if (!txn || txn.brokerage_id !== auth.brokerageId) {
    return { success: false as const, error: "transaction_not_found" }
  }

  const { data: doc, error: docErr } = await supabase
    .from("transaction_documents")
    .insert({
      transaction_id: input.transactionId,
      brokerage_id: txn.brokerage_id,
      doc_type: "preliminary_closing_disclosure",
      doc_label: input.fileName,
      storage_url: input.fileUrl,
      status: "received",
      uploaded_by: auth.userId,
      uploaded_at: new Date().toISOString(),
    })
    .select("id")
    .single()
  if (docErr || !doc) return { success: false as const, error: docErr?.message ?? "insert_failed" }

  return notifyAgentOfPreliminaryCdAction({
    transactionId: input.transactionId,
    documentId: doc.id,
  })
}

// ────────────────────────────────────────────────────────────────────────────
// EXTENSIONS — signature gate, manual override, send-to-title, non-CDA path,
// post-close artifacts. Pure additions to the existing CDA workflow above.
// ────────────────────────────────────────────────────────────────────────────

interface MissingDoc { document_type: string; reason: string }

/**
 * Pre-scan transaction documents for required signatures/initials so the
 * compliance manager sees a clean go/no-go indicator on the CDA review page.
 *
 * Approval gate (enforced in approveCdaAction below):
 *   signature_check_passed === true  → may approve
 *   signature_check_passed === false → must manual_override with reason
 *   signature_check_passed === null  → grandfathered (older CDAs)
 *
 * Idempotent — overwrites the latest scan result.
 */
export async function runSignatureCheckForCdaAction(input: { cdaId: string }) {
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return { success: false as const, error: "unauthenticated" }

  const { data: cda } = await supabase
    .from("closing_disclosure_agreement")
    .select("id, transaction_id, brokerage_id")
    .eq("id", input.cdaId)
    .maybeSingle()
  if (!cda || cda.brokerage_id !== auth.brokerageId) {
    return { success: false as const, error: "not_found" }
  }

  // Walk every document on the transaction and check for completion + sigs.
  // Production sources: documents (Workflow OS) + transaction_documents (legacy).
  const missing: MissingDoc[] = []

  const { data: docs1 } = await supabase
    .from("documents")
    .select("document_type, status, metadata")
    .eq("transaction_id", cda.transaction_id)
  for (const d of docs1 ?? []) {
    if (d.status !== "complete") {
      missing.push({ document_type: d.document_type, reason: `Status="${d.status}" — not finalized + signed` })
      continue
    }
    const sig = (d.metadata as { signature_check?: { all_signed?: boolean; missing?: string[] } } | null)?.signature_check
    if (sig && sig.all_signed === false) {
      missing.push({
        document_type: d.document_type,
        reason: `Missing: ${(sig.missing ?? []).join(", ") || "signatures/initials"}`,
      })
    }
  }

  const { data: docs2 } = await supabase
    .from("transaction_documents")
    .select("doc_type, status")
    .eq("transaction_id", cda.transaction_id)
  for (const d of docs2 ?? []) {
    // Legacy doc rows — flag anything not in a "received"/"signed"/"complete" state
    if (!["received", "signed", "complete", "approved"].includes((d.status ?? "").toLowerCase())) {
      missing.push({ document_type: d.doc_type, reason: `Legacy doc status="${d.status}"` })
    }
  }

  const passed = missing.length === 0
  await supabase
    .from("closing_disclosure_agreement")
    .update({
      signature_check_passed: passed,
      missing_docs:           missing.length > 0 ? missing : null,
      updated_at:             new Date().toISOString(),
    })
    .eq("id", cda.id)

  return { success: true as const, passed, missing }
}

// ─── Manual override (compliance manager bypasses sig gate with reason) ────

export async function manualOverrideCdaAction(input: { cdaId: string; reason: string }) {
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return { success: false as const, error: "unauthenticated" }
  if (!COMPLIANCE_ROLES.has(auth.userType)) {
    return { success: false as const, error: "forbidden" }
  }
  const reason = (input.reason ?? "").trim()
  if (reason.length < 10) {
    return { success: false as const, error: "reason_required_min_10_chars" }
  }

  const { data: cda } = await supabase
    .from("closing_disclosure_agreement")
    .select("id, brokerage_id, revision_number, status")
    .eq("id", input.cdaId)
    .maybeSingle()
  if (!cda || cda.brokerage_id !== auth.brokerageId) {
    return { success: false as const, error: "not_found" }
  }

  const now = new Date().toISOString()
  await supabase
    .from("closing_disclosure_agreement")
    .update({
      manual_override_by:     auth.userId,
      manual_override_at:     now,
      manual_override_reason: reason,
      updated_at:             now,
    })
    .eq("id", cda.id)

  await recordRevision({
    cdaId:                cda.id,
    revisionNumber:       cda.revision_number,
    status:               cda.status,
    action:               "approved",
    notes:                `MANUAL OVERRIDE: ${reason}`,
    actedBy:              auth.userId,
  })

  return { success: true as const }
}

// ─── Send approved CDA to title / closing attorney ────────────────────────

export async function sendCdaToTitleAction(input: {
  cdaId:           string
  recipientEmail:  string
  recipientName?:  string
  method?:         "email" | "docusign" | "dotloop" | "manual"
  subject?:        string
  message?:        string
}) {
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return { success: false as const, error: "unauthenticated" }

  const { data: cda } = await supabase
    .from("closing_disclosure_agreement")
    .select("id, transaction_id, brokerage_id, status")
    .eq("id", input.cdaId)
    .maybeSingle()
  if (!cda || cda.brokerage_id !== auth.brokerageId) {
    return { success: false as const, error: "not_found" }
  }
  if (cda.status !== "approved") {
    return { success: false as const, error: `cannot_send_from_status:${cda.status}` }
  }

  const method = input.method ?? "email"
  if (method === "email") {
    try {
      const { dispatchEmail } = await import("@/lib/providers/dispatch")
      await dispatchEmail({
        brokerageId:   cda.brokerage_id,
        systemSource:  "cda",
        from:          "closings@platform.com",
        to:            input.recipientEmail,
        subject:       input.subject ?? "Approved Commission Disbursement Authorization",
        html:          (input.message ?? "")
                       + `<p>The approved CDA for this transaction is ready for the closing.</p>`,
      })
    } catch { /* best-effort — record the send anyway so the agent can fall back */ }
  }

  await supabase
    .from("closing_disclosure_agreement")
    .update({
      sent_to_title_at:        new Date().toISOString(),
      sent_to_title_recipient: input.recipientName
        ? `${input.recipientName} <${input.recipientEmail}>`
        : input.recipientEmail,
      sent_to_title_method:    method,
      updated_at:              new Date().toISOString(),
    })
    .eq("id", cda.id)

  return { success: true as const }
}

// ─── Non-CDA path — agent's payout preference ─────────────────────────────
//
// When the brokerage does not offer CDAs (brokerages.offers_cda = false),
// the agent records how they'd like the brokerage to disburse to them
// after funds clear. Stored on the CDA row itself for unified tracking.

export async function recordNonCdaPayoutPreferenceAction(input: {
  transactionId: string
  method:        "direct_deposit" | "check"
  details?:      Record<string, unknown>
}) {
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return { success: false as const, error: "unauthenticated" }

  // Get-or-create CDA row for this transaction in non-CDA path
  let cdaId: string
  const { data: existing } = await supabase
    .from("closing_disclosure_agreement")
    .select("id, brokerage_id")
    .eq("transaction_id", input.transactionId)
    .maybeSingle()

  if (existing) {
    if (existing.brokerage_id !== auth.brokerageId) return { success: false as const, error: "forbidden" }
    cdaId = existing.id
  } else {
    const { data: txn } = await supabase
      .from("transactions").select("brokerage_id, agent_id").eq("id", input.transactionId).maybeSingle()
    if (!txn || txn.brokerage_id !== auth.brokerageId) {
      return { success: false as const, error: "transaction_not_found" }
    }
    const { data: created, error } = await supabase
      .from("closing_disclosure_agreement")
      .insert({
        transaction_id:        input.transactionId,
        brokerage_id:          txn.brokerage_id,
        agent_id:              txn.agent_id,
        status:                "pending",
        revision_number:       1,
        uses_cda:              false,
      })
      .select("id")
      .single()
    if (error || !created) return { success: false as const, error: error?.message ?? "create_failed" }
    cdaId = created.id
  }

  await supabase
    .from("closing_disclosure_agreement")
    .update({
      uses_cda:                false,
      non_cda_payout_method:   input.method,
      non_cda_payout_details:  input.details ?? null,
      updated_at:              new Date().toISOString(),
    })
    .eq("id", cdaId)

  return { success: true as const, cdaId }
}

// ─── Post-close artifact uploads ──────────────────────────────────────────

export async function uploadFinalCdAction(input: {
  cdaId:           string
  documentId:      string                                // FK to documents OR transaction_documents
}) {
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return { success: false as const, error: "unauthenticated" }

  await supabase
    .from("closing_disclosure_agreement")
    .update({
      final_cd_document_id:  input.documentId,
      final_cd_uploaded_by:  auth.userId,
      final_cd_uploaded_at:  new Date().toISOString(),
      updated_at:            new Date().toISOString(),
    })
    .eq("id", input.cdaId)
    .eq("brokerage_id", auth.brokerageId)

  return { success: true as const }
}

export async function uploadCdaCheckCopyAction(input: {
  cdaId:        string
  documentId:   string
}) {
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return { success: false as const, error: "unauthenticated" }

  await supabase
    .from("closing_disclosure_agreement")
    .update({
      check_copy_document_id:  input.documentId,
      check_copy_uploaded_at:  new Date().toISOString(),
      updated_at:              new Date().toISOString(),
    })
    .eq("id", input.cdaId)
    .eq("brokerage_id", auth.brokerageId)

  return { success: true as const }
}

export async function closeCdaAction(input: { cdaId: string }) {
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return { success: false as const, error: "unauthenticated" }

  await supabase
    .from("closing_disclosure_agreement")
    .update({
      closed_at:  new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", input.cdaId)
    .eq("brokerage_id", auth.brokerageId)

  return { success: true as const }
}
