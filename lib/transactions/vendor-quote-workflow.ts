import { createServiceClient } from "@/lib/supabase/service"
import { transitionLifecycle } from "@/lib/kernel/lifecycle"

/**
 * Vendor Quote Approval Workflow (INSPECTION phase)
 * TC gathers quotes → Client approves → Vendor added to team
 */

export async function requestQuoteApproval(params: {
  transactionId: string
  brokerageId: string
  quoteType: "inspector" | "insurance"
  vendorName: string
  quoteAmount: number
  quoteDocumentId: string
  requestedBy: string
}) {
  const supabase = createServiceClient()
  
  // Create activity for client approval — Agent task (correct location, no changes) — activity_type: client_quote_approval_needed, schedule_vendor, get_alternative_quote
  // `error` is destructured, not just `data`. This row IS the client-approval
  // task; if the insert fails the workflow returns an id-less activity and the
  // approval simply never appears for anyone to action.
  const { data: activity, error: activityError } = await supabase
    .from("activities")
    .insert({
      transaction_id: params.transactionId,
      brokerage_id: params.brokerageId,
      activity_type: "client_quote_approval_needed",
      title: `Approve ${params.quoteType} Quote`,
      description: `${params.vendorName} - $${params.quoteAmount}`,
      priority: "high",
      status: "pending",
      metadata: {
        vendor_name: params.vendorName,
        quote_amount: params.quoteAmount,
        quote_document_id: params.quoteDocumentId,
        quote_type: params.quoteType,
        approval_deadline: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString()
      },
      created_at: new Date().toISOString()
    })
    .select()
    .single()

  if (activityError) {
    console.error("[vendor-quote-workflow] client approval activity NOT created:", activityError.message)
  }

  // Log event via kernel
  await transitionLifecycle({
    brokerageId: params.brokerageId,
    entityType:  "transaction",
    entityId:    params.transactionId,
    fromState:   "pending",
    toState:     "quote_requested",
    actorUserId: params.requestedBy,
    actorRole:   "tc",
    eventType:   "quote.requested",
    metadata:    { quote_type: params.quoteType, vendor_name: params.vendorName, quote_amount: params.quoteAmount },
  })
  
  // Create transparency update
  await supabase.from("transparency_updates").insert({
    transaction_id: params.transactionId,
    brokerage_id: params.brokerageId,
    update_type: "action_required",
    title: "Quote Approval Needed",
    message: `Please review and approve the ${params.quoteType} quote from ${params.vendorName}.`,
    is_visible_to_client: true,
    created_at: new Date().toISOString()
  })
  
  return { success: true, activityId: activity?.id }
}

export async function approveQuote(params: {
  activityId: string
  transactionId: string
  brokerageId: string
  vendorName: string
  quoteType: "inspector" | "insurance"
  approvedBy: string
  notes?: string
}) {
  const supabase = createServiceClient()

  // ── THE VENDOR'S CONTACT DETAILS, BEFORE THE ACTIVITY IS CLOSED ────────────
  //
  // deal_team_members carries email / phone / company, and FIVE surfaces render
  // them as the client-facing contact card for this vendor:
  //   app/crm/page.tsx:674 (call + email buttons, each gated on truthiness)
  //   app/portal/[contactId]/team/page.tsx:83
  //   app/portal/[contactId]/buyer-home.tsx:117
  //   app/portal/[contactId]/seller-home.tsx:154
  //   app/portal/[contactId]/lifetime-home.tsx:118
  //
  // This insert wrote only transaction_id / brokerage_id / member_type / name,
  // so all three columns were writerless and every one of those cards rendered
  // a bare name with no way to reach the person — while the details themselves
  // sat one row away, captured by the SAME workflow that requested the quote:
  //   inspector  → transaction_inspections.inspector_{company,email,phone}
  //                (app/actions/transaction-inspections.ts:64 writes them)
  //   insurance  → transaction_vendor_services.vendor_{email,phone}
  //                (app/actions/transaction-inspections.ts:322 writes them)
  //
  // requestQuoteApproval stamped that source row's id into the activity as
  // metadata.quote_document_id, so the approval can find it. This read happens
  // BEFORE the completion update, because the update does not return the row.
  const { data: approvalActivity, error: activityReadError } = await supabase
    .from("activities")
    .select("metadata")
    .eq("id", params.activityId)
    .maybeSingle()

  if (activityReadError) {
    console.error(
      `[vendor-quote-workflow] approval activity ${params.activityId} metadata NOT read (deal-team contact details will be absent):`,
      activityReadError.message,
    )
  }

  const sourceRowId =
    ((approvalActivity?.metadata as Record<string, unknown> | null)?.quote_document_id as string | undefined) ?? null

  let vendorEmail: string | null = null
  let vendorPhone: string | null = null
  let vendorCompany: string | null = null

  if (sourceRowId) {
    if (params.quoteType === "inspector") {
      const { data: inspection, error: inspectionError } = await supabase
        .from("transaction_inspections")
        .select("inspector_email, inspector_phone, inspector_company")
        .eq("id", sourceRowId)
        .maybeSingle()
      if (inspectionError) {
        console.error(
          `[vendor-quote-workflow] inspection ${sourceRowId} contact lookup refused:`,
          inspectionError.message,
        )
      }
      vendorEmail = (inspection?.inspector_email as string | null) ?? null
      vendorPhone = (inspection?.inspector_phone as string | null) ?? null
      vendorCompany = (inspection?.inspector_company as string | null) ?? null
    } else {
      // transaction_vendor_services has no company column — the vendor NAME is
      // the company on the insurance rail, so company stays null rather than
      // being duplicated out of `name`.
      const { data: service, error: serviceError } = await supabase
        .from("transaction_vendor_services")
        .select("vendor_email, vendor_phone")
        .eq("id", sourceRowId)
        .maybeSingle()
      if (serviceError) {
        console.error(
          `[vendor-quote-workflow] vendor service ${sourceRowId} contact lookup refused:`,
          serviceError.message,
        )
      }
      vendorEmail = (service?.vendor_email as string | null) ?? null
      vendorPhone = (service?.vendor_phone as string | null) ?? null
    }
  }

  // Mark activity complete. A dropped update leaves the approval task sitting
  // open forever on the TC's list for work that IS done.
  const { error: completeError } = await supabase
    .from("activities")
    .update({
      status: "completed",
      completed_at: new Date().toISOString()
    })
    .eq("id", params.activityId)

  if (completeError) {
    console.error(`[vendor-quote-workflow] approval activity ${params.activityId} NOT closed:`, completeError.message)
  }

  // Add vendor to deal team. `error` is destructured: supabase-js RESOLVES a
  // refusal, and a silently dropped row here means the approved vendor never
  // appears on the client's deal-team card at all.
  //
  // portal_access is written EXPLICITLY false rather than left to the column's
  // `DEFAULT true`. A vendor approved off a quote has no account — member_id is
  // null on this row — so "true" would have asserted a portal seat that does not
  // exist. Portal access for an external party is granted, never defaulted.
  const { error: teamMemberError } = await supabase.from("deal_team_members").insert({
    transaction_id: params.transactionId,
    brokerage_id: params.brokerageId,
    member_type: params.quoteType === "inspector" ? "inspector" : "insurance_provider",
    name: params.vendorName,
    email: vendorEmail,
    phone: vendorPhone,
    company: vendorCompany,
    portal_access: false,
  })

  if (teamMemberError) {
    console.error(
      `[vendor-quote-workflow] deal_team_members row for "${params.vendorName}" on transaction ${params.transactionId} NOT created:`,
      teamMemberError.message,
    )
  }

  // Complete milestone
  const milestoneName = params.quoteType === "inspector" 
    ? "inspector_approved" 
    : "insurance_quote_approved"
  
  await supabase
    .from("transaction_milestones")
    .update({
      status: "completed",
      completed_at: new Date().toISOString()
    })
    .eq("transaction_id", params.transactionId)
    .eq("milestone_name", milestoneName)
  
  // Log event via kernel
  await transitionLifecycle({
    brokerageId: params.brokerageId,
    entityType:  "transaction",
    entityId:    params.transactionId,
    fromState:   "quote_requested",
    toState:     "quote_approved",
    actorUserId: params.approvedBy,
    actorRole:   "agent",
    eventType:   "quote.approved",
    metadata:    { quote_type: params.quoteType, vendor_name: params.vendorName, notes: params.notes ?? null },
  })
  
  // Create TC activity for next step — the handoff after approval. If this is
  // lost, the quote is approved and nothing tells anyone to act on it.
  const { error: nextStepError } = await supabase.from("activities").insert({
    transaction_id: params.transactionId,
    brokerage_id: params.brokerageId,
    agent_id: params.approvedBy,
    activity_type: "schedule_vendor",
    title: `Schedule ${params.quoteType}`,
    description: `Client approved ${params.vendorName}. Schedule the ${params.quoteType}.`,
    priority: "high",
    status: "pending",
    created_at: new Date().toISOString()
  })

  if (nextStepError) {
    console.error(
      `[vendor-quote-workflow] follow-up "schedule ${params.quoteType}" NOT created for transaction ${params.transactionId}:`,
      nextStepError.message,
    )
  }

  // Update transparency
  await supabase.from("transparency_updates").insert({
    transaction_id: params.transactionId,
    brokerage_id: params.brokerageId,
    update_type: "milestone_completed",
    title: "Quote Approved",
    message: `${params.vendorName} has been approved. Scheduling will be coordinated next.`,
    is_visible_to_client: true,
    created_at: new Date().toISOString()
  })
  
  return { success: true }
}

export async function declineQuote(params: {
  activityId: string
  transactionId: string
  brokerageId: string
  declinedBy: string
  reason?: string
}) {
  const supabase = createServiceClient()
  
  // Mark activity declined.
  //
  // 🐛 READING THE ERROR IS NOT ENOUGH HERE. A .update() that matches NOTHING
  // also resolves with `error: null` and an empty result — byte-identical to one
  // that worked — so a stale or wrong-tenant activityId left the quote task
  // sitting OPEN while this returned { success: true }, and then went on to log a
  // "quote.declined" lifecycle event and open a get_alternative_quote task for a
  // decline that never happened. The predicate IS the thing being asserted, so
  // the affected-row count is the only honest signal.
  // SURVIVOR PATTERN: lib/kernel/crm.ts::archiveContactRecord (~line 981).
  // ZERO ROWS IS A FAILURE AT THIS SITE (the caller's call, per §3): the whole
  // point of the command is to close that one task, and leaving it open while
  // reporting success is the defect. Contrast the subscription-cancel path in
  // app/actions/superadmin/brokerage-management.ts, where an already-cancelled
  // row IS the desired outcome.
  const { data: declinedRows, error: declineUpdateError } = await supabase
    .from("activities")
    .update({
      status: "cancelled",
      completed_at: new Date().toISOString()
    })
    .eq("id", params.activityId)
    .eq("brokerage_id", params.brokerageId)
    .select("id")
  if (declineUpdateError) {
    console.error(`[vendor-quote-workflow] declining activity ${params.activityId} REJECTED — the quote task stays open:`, declineUpdateError.message)
    return { success: false, error: `The quote task could not be closed: ${declineUpdateError.message}` }
  }
  if (!(declinedRows ?? []).length) {
    // Deliberately does not distinguish "does not exist" from "not yours" — that
    // difference is an id-enumeration oracle across tenants (same ruling as
    // archiveContactRecord). Nothing downstream runs: no lifecycle event and no
    // follow-up task for a decline that did not take.
    return { success: false, error: "Quote task not found, already closed, or not yours to decline" }
  }

  // Log event via kernel
  await transitionLifecycle({
    brokerageId: params.brokerageId,
    entityType:  "transaction",
    entityId:    params.transactionId,
    fromState:   "quote_requested",
    toState:     "quote_declined",
    actorUserId: params.declinedBy,
    actorRole:   "agent",
    eventType:   "quote.declined",
    metadata:    { reason: params.reason ?? null },
  })
  
  // Create TC activity to get alternative. THIS ROW IS THE TASK — without it
  // a declined quote produces no follow-up work for anyone.
  const { error: alternativeQuoteActivityError } = await supabase.from("activities").insert({
    transaction_id: params.transactionId,
    brokerage_id: params.brokerageId,
    activity_type: "get_alternative_quote",
    title: "Get Alternative Quote",
    description: `Client declined quote. Reason: ${params.reason || 'Not provided'}`,
    priority: "high",
    status: "pending",
    created_at: new Date().toISOString()
  })
  if (alternativeQuoteActivityError) {
    console.error("[vendor-quote-workflow] get_alternative_quote activity REJECTED — the decline produced no follow-up task:", alternativeQuoteActivityError.message)
  }

  return { success: true }
}
