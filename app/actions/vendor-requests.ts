"use server"

/**
 * app/actions/vendor-requests.ts — the VENDOR REQUEST RAIL's server half
 * (owner rule: vendors edit/update their owned area of the transaction).
 * The lender's "request documents" loop, generalized to every vendor ON the
 * deal: inspector needs utilities on, stager needs an access window,
 * photographer needs the listing cleared. Auth mirrors the lender gate —
 * requireVendorActor proves the caller IS the vendor, then the vendor must be
 * linked to THIS transaction (vendor_assignments grant, or a live
 * vendor_bookings row — both are real linkage). Effects: lifecycle_events
 * ledger row + the agent's due-dated task (NOT-NULL assignee honored) + an
 * optional GATED client portal draft through the agent's governed rail —
 * a vendor can never message a client directly.
 */

import { requireVendorActor, PortalAuthError } from "@/lib/kernel/portal-auth"
import {
  validateVendorRequest,
  composeVendorRequestTask,
  clientPartyForRequest,
  composeClientRequestBody,
} from "@/lib/kernel/vendor-request"

export async function submitVendorTransactionRequest(input: {
  vendorId: string
  transactionId: string
  requestType: string
  details: string
  neededBy?: string | null
  askClient?: boolean
}): Promise<{ success: boolean; error?: string; taskCreated?: boolean; clientDraftProposed?: boolean }> {
  const valid = validateVendorRequest(input)
  if (!valid.ok) return { success: false, error: valid.error }

  let actor
  try {
    actor = await requireVendorActor(input.vendorId)
  } catch (e) {
    if (e instanceof PortalAuthError) return { success: false, error: e.message }
    throw e
  }

  const { createServiceClient } = await import("@/lib/supabase/service")
  const svc = createServiceClient()

  // The vendor must be linked to THIS deal — assignment grant or a live booking.
  const [{ data: assignment }, { data: bookingRows }] = await Promise.all([
    svc.from("vendor_assignments").select("id")
      .eq("vendor_id", actor.vendorId).eq("transaction_id", input.transactionId).limit(1).maybeSingle(),
    svc.from("vendor_bookings").select("id, status")
      .eq("vendor_id", actor.vendorId).eq("transaction_id", input.transactionId).limit(10),
  ])
  const booking = ((bookingRows ?? []) as Array<{ id: string; status: string | null }>)
    .find((b) => b.status !== "cancelled" && b.status !== "no_show")
  if (!assignment && !booking) {
    return { success: false, error: "You are not assigned to this transaction — ask the agent to add you to the deal first." }
  }

  const [{ data: tx }, { data: vendor }] = await Promise.all([
    svc.from("transactions")
      .select("id, agent_id, contact_id, buyer_contact_id, property_address, brokerage_id")
      .eq("id", input.transactionId).maybeSingle(),
    svc.from("vendors").select("id, name, category").eq("id", actor.vendorId).maybeSingle(),
  ])
  if (!tx) return { success: false, error: "Transaction not found" }

  const vendorName = (vendor as any)?.name ?? "Vendor"
  const vendorCategory = (vendor as any)?.category ?? null
  const neededBy = input.neededBy?.trim() || null
  const details = input.details.trim()

  // 1) The ledger — who asked, for what, on which deal.
  await svc.from("lifecycle_events").insert({
    brokerage_id: (tx as any).brokerage_id ?? actor.brokerageId,
    entity_type: "transaction",
    entity_id: input.transactionId,
    event_type: "vendor_request",
    actor_user_id: actor.userId,
    metadata: { vendor: vendorName, vendor_id: actor.vendorId, category: vendorCategory, request_type: valid.requestType, details, needed_by: neededBy },
  }).then(() => {}, () => {})

  // 2) The agent's task (assignee NOT-NULL contract honored — honest refusal if unresolvable).
  const assignee = (tx as any).agent_id ?? null
  let taskCreated = false
  if (assignee) {
    const task = composeVendorRequestTask({
      vendorName, vendorCategory,
      requestType: valid.requestType,
      details,
      propertyAddress: (tx as any).property_address ?? null,
      neededBy,
    })
    const { error } = await svc.from("tasks").insert({
      brokerage_id: (tx as any).brokerage_id ?? actor.brokerageId,
      transaction_id: input.transactionId,
      contact_id: clientPartyForRequest(valid.requestType, tx as any),
      assigned_to_agent_id: assignee,
      title: task.title,
      description: task.description,
      due_date: (neededBy && /^\d{4}-\d{2}-\d{2}/.test(neededBy) ? neededBy.slice(0, 10) : new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10)),
      assignee_type: "agent",
      source: "vendor_request",
      status: "pending",
    })
    taskCreated = !error
  }

  // 3) The GATED client draft — only when the vendor says the ask is for the
  //    client, and only through the agent's governed rail (approve-to-send).
  let clientDraftProposed = false
  if (input.askClient) {
    const clientContactId = clientPartyForRequest(valid.requestType, tx as any)
    if (clientContactId) {
      const draft = composeClientRequestBody({ vendorName, vendorCategory, requestType: valid.requestType, details, neededBy })
      const { proposeClientMessage } = await import("@/lib/agents/agent-client-messages")
      await proposeClientMessage({
        brokerageId: (tx as any).brokerage_id ?? actor.brokerageId,
        agentKind: "deal_coordinator",
        entityType: "transaction",
        entityId: input.transactionId,
        recipientContactId: clientContactId,
        audience: clientContactId === (tx as any).buyer_contact_id ? "buyer" : "seller",
        subject: draft.subject,
        body: draft.body,
        rationale: `vendor_request — ${vendorName}${vendorCategory ? ` (${vendorCategory})` : ""} filed a ${valid.requestType} request that needs the client; routed through the agent's gate, never vendor→client raw.`,
        channel: "portal",
        outreachReason: "decision_required",
      }).then(() => { clientDraftProposed = true }, () => {})
    }
  }

  return { success: true, taskCreated, clientDraftProposed }
}
