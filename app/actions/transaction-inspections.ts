"use server"

import { createClient } from "@/lib/supabase/server"
import { revalidatePath } from "next/cache"
import { scheduleInspection, updateInspection } from "@/lib/application/transactions"
import { requestQuoteApproval, approveQuote, declineQuote } from "@/lib/transactions/vendor-quote-workflow"
import { completeMilestone } from "@/lib/transactions/milestone-service"
import { KernelEvent } from "@/lib/kernel/events"

// ─── SCHEDULE INSPECTION ───────────────────────────────────────────────────────

export async function scheduleInspectionAction(params: {
  transactionId: string
  brokerageId: string
  inspectionType: string
  inspectorName: string
  inspectorCompany?: string
  inspectorEmail?: string
  inspectorPhone?: string
  scheduledDate?: string
  cost?: number
  notes?: string
}) {
  const supabase = await createClient()

  const result = await scheduleInspection({
    transaction_id: params.transactionId,
    inspection_type: params.inspectionType,
    inspector_name: params.inspectorName,
    inspector_company: params.inspectorCompany,
    inspector_email: params.inspectorEmail,
    inspector_phone: params.inspectorPhone,
    scheduled_date: params.scheduledDate,
    cost: params.cost,
    notes: params.notes,
  })

  if (!result.success) {
    return { success: false, error: result.error }
  }

  // Emit kernel event
  await supabase.from("lifecycle_events").insert({
    brokerage_id:  params.brokerageId,
    entity_type:   "transaction",
    entity_id:     params.transactionId,
    event_type:    KernelEvent.INSPECTION_ORDERED,
    metadata:      {
      inspection_type: params.inspectionType,
      inspector_name:  params.inspectorName,
      scheduled_date:  params.scheduledDate ?? null,
      cost:            params.cost ?? null,
    },
  })

  // If cost provided, request quote approval
  if (params.cost && result.data?.id) {
    const { data: userData } = await supabase.auth.getUser()
    await requestQuoteApproval({
      transactionId:   params.transactionId,
      brokerageId:     params.brokerageId,
      quoteType:       "inspector",
      vendorName:      params.inspectorName,
      quoteAmount:     params.cost,
      quoteDocumentId: result.data.id,
      requestedBy:     userData.user?.id ?? "system",
    })

    await supabase.from("lifecycle_events").insert({
      brokerage_id: params.brokerageId,
      entity_type:  "transaction",
      entity_id:    params.transactionId,
      event_type:   KernelEvent.INSPECTION_QUOTE_REQUESTED,
      metadata:     { inspection_id: result.data.id, quote_amount: params.cost },
    })
  }

  revalidatePath(`/dashboard/transactions/${params.transactionId}`)
  return { success: true, data: result.data }
}

// ─── APPROVE INSPECTION QUOTE ──────────────────────────────────────────────────

export async function approveInspectionQuoteAction(params: {
  activityId: string
  transactionId: string
  brokerageId: string
  vendorName: string
  notes?: string
}) {
  const supabase = await createClient()
  const { data: userData } = await supabase.auth.getUser()

  await approveQuote({
    activityId:    params.activityId,
    transactionId: params.transactionId,
    brokerageId:   params.brokerageId,
    vendorName:    params.vendorName,
    quoteType:     "inspector",
    approvedBy:    userData.user?.id ?? "system",
    notes:         params.notes,
  })

  await supabase.from("lifecycle_events").insert({
    brokerage_id: params.brokerageId,
    entity_type:  "transaction",
    entity_id:    params.transactionId,
    event_type:   KernelEvent.INSPECTION_QUOTE_APPROVED,
    metadata:     { vendor_name: params.vendorName },
  })

  revalidatePath(`/dashboard/transactions/${params.transactionId}`)
  return { success: true }
}

// ─── DECLINE INSPECTION QUOTE ──────────────────────────────────────────────────

export async function declineInspectionQuoteAction(params: {
  activityId: string
  transactionId: string
  brokerageId: string
  reason?: string
}) {
  const supabase = await createClient()
  const { data: userData } = await supabase.auth.getUser()

  await declineQuote({
    activityId:    params.activityId,
    transactionId: params.transactionId,
    brokerageId:   params.brokerageId,
    declinedBy:    userData.user?.id ?? "system",
    reason:        params.reason,
  })

  revalidatePath(`/dashboard/transactions/${params.transactionId}`)
  return { success: true }
}

// ─── MARK INSPECTION COMPLETE ──────────────────────────────────────────────────

export async function markInspectionCompleteAction(params: {
  inspectionId: string
  transactionId: string
  brokerageId: string
}) {
  const result = await updateInspection(params.inspectionId, {
    status: "report_received",
    completed_date: new Date().toISOString(),
    report_received: true,
  })

  if (!result.success) {
    return { success: false, error: result.error }
  }

  revalidatePath(`/dashboard/transactions/${params.transactionId}`)
  return { success: true }
}

// ─── UPLOAD INSPECTION REPORT ──────────────────────────────────────────────────

export async function uploadInspectionReportAction(params: {
  inspectionId: string
  transactionId: string
  brokerageId: string
  reportUrl: string
  fileName: string
}) {
  const supabase = await createClient()
  const { data: userData } = await supabase.auth.getUser()

  // Update inspection with report URL
  await updateInspection(params.inspectionId, {
    report_url: params.reportUrl,
    report_received: true,
    status: "report_received",
  })

  // Add as transaction document
  await supabase.from("transaction_documents").insert({
    transaction_id: params.transactionId,
    brokerage_id:   params.brokerageId,
    doc_type:       "inspection_report",
    file_name:      params.fileName,
    file_url:       params.reportUrl,
    status:         "uploaded",
    uploaded_by:    userData.user?.id,
    uploaded_at:    new Date().toISOString(),
  })

  revalidatePath(`/dashboard/transactions/${params.transactionId}`)
  return { success: true }
}

// ─── REQUEST INSURANCE QUOTE ───────────────────────────────────────────────────

export async function requestInsuranceQuoteAction(params: {
  transactionId: string
  brokerageId: string
  vendorName: string
  vendorEmail?: string
  vendorPhone?: string
  notes?: string
}) {
  const supabase = await createClient()
  const { data: userData } = await supabase.auth.getUser()

  // Insert into vendor services
  const { data, error } = await supabase
    .from("transaction_vendor_services")
    .insert({
      transaction_id: params.transactionId,
      brokerage_id:   params.brokerageId,
      service_type:   "insurance_quote",
      vendor_name:    params.vendorName,
      vendor_email:   params.vendorEmail,
      vendor_phone:   params.vendorPhone,
      status:         "quote_requested",
      notes:          params.notes,
      created_at:     new Date().toISOString(),
    })
    .select()
    .single()

  if (error) {
    return { success: false, error: error.message }
  }

  await supabase.from("lifecycle_events").insert({
    brokerage_id: params.brokerageId,
    entity_type:  "transaction",
    entity_id:    params.transactionId,
    event_type:   KernelEvent.INSURANCE_QUOTE_REQUESTED,
    metadata:     { vendor_name: params.vendorName, service_id: data?.id },
  })

  revalidatePath(`/dashboard/transactions/${params.transactionId}`)
  return { success: true, data }
}

// ─── SUBMIT INSURANCE QUOTE FOR APPROVAL ───────────────────────────────────────

export async function submitInsuranceQuoteApprovalAction(params: {
  serviceId: string
  transactionId: string
  brokerageId: string
  vendorName: string
  quoteAmount: number
}) {
  const supabase = await createClient()
  const { data: userData } = await supabase.auth.getUser()

  // Update service with quote amount
  await supabase
    .from("transaction_vendor_services")
    .update({ cost: params.quoteAmount, status: "pending_approval" })
    .eq("id", params.serviceId)

  // Request approval through workflow
  await requestQuoteApproval({
    transactionId:   params.transactionId,
    brokerageId:     params.brokerageId,
    quoteType:       "insurance",
    vendorName:      params.vendorName,
    quoteAmount:     params.quoteAmount,
    quoteDocumentId: params.serviceId,
    requestedBy:     userData.user?.id ?? "system",
  })

  revalidatePath(`/dashboard/transactions/${params.transactionId}`)
  return { success: true }
}

// ─── APPROVE INSURANCE QUOTE ───────────────────────────────────────────────────

export async function approveInsuranceQuoteAction(params: {
  activityId: string
  serviceId: string
  transactionId: string
  brokerageId: string
  vendorName: string
  notes?: string
}) {
  const supabase = await createClient()
  const { data: userData } = await supabase.auth.getUser()

  // Update service status
  await supabase
    .from("transaction_vendor_services")
    .update({ status: "approved" })
    .eq("id", params.serviceId)

  await approveQuote({
    activityId:    params.activityId,
    transactionId: params.transactionId,
    brokerageId:   params.brokerageId,
    vendorName:    params.vendorName,
    quoteType:     "insurance",
    approvedBy:    userData.user?.id ?? "system",
    notes:         params.notes,
  })

  await supabase.from("lifecycle_events").insert({
    brokerage_id: params.brokerageId,
    entity_type:  "transaction",
    entity_id:    params.transactionId,
    event_type:   KernelEvent.INSURANCE_QUOTE_APPROVED,
    metadata:     { vendor_name: params.vendorName },
  })

  revalidatePath(`/dashboard/transactions/${params.transactionId}`)
  return { success: true }
}

// ─── UPDATE EARNEST MONEY ──────────────────────────────────────────────────────

export async function updateEarnestMoneyAction(params: {
  transactionId: string
  brokerageId: string
  titleEscrowId?: string
  earnestMoneyAmount?: number
  earnestMoneyHeldBy?: string
  earnestMoneyReceivedDate?: string
}) {
  const supabase = await createClient()
  const { data: userData } = await supabase.auth.getUser()

  const updates: Record<string, unknown> = {}
  if (params.earnestMoneyAmount !== undefined) {
    updates.earnest_money_amount = params.earnestMoneyAmount
  }
  if (params.earnestMoneyHeldBy !== undefined) {
    updates.earnest_money_held_by = params.earnestMoneyHeldBy
  }
  if (params.earnestMoneyReceivedDate !== undefined) {
    updates.earnest_money_received_date = params.earnestMoneyReceivedDate
  }

  if (params.titleEscrowId) {
    // Update existing record
    const { error } = await supabase
      .from("transaction_title_escrow")
      .update(updates)
      .eq("id", params.titleEscrowId)

    if (error) {
      return { success: false, error: error.message }
    }
  } else {
    // Create new record
    const { error } = await supabase.from("transaction_title_escrow").insert({
      transaction_id: params.transactionId,
      brokerage_id:   params.brokerageId,
      ...updates,
    })

    if (error) {
      return { success: false, error: error.message }
    }
  }

  // If earnest money received date is set, complete the milestone + emit event
  if (params.earnestMoneyReceivedDate) {
    await supabase.from("lifecycle_events").insert({
      brokerage_id: params.brokerageId,
      entity_type:  "transaction",
      entity_id:    params.transactionId,
      event_type:   KernelEvent.EARNEST_MONEY_RECEIVED,
      metadata:     {
        amount:       params.earnestMoneyAmount ?? null,
        held_by:      params.earnestMoneyHeldBy ?? null,
        received_at:  params.earnestMoneyReceivedDate,
      },
    })

    // Complete earnest_money_due milestone
    await completeMilestone({
      transactionId: params.transactionId,
      brokerageId:   params.brokerageId,
      milestoneName: "earnest_money_due",
      completedBy:   userData.user?.id ?? "system",
    }).catch(() => {
      // Milestone may not exist, ignore error
    })

    await supabase.from("lifecycle_events").insert({
      brokerage_id: params.brokerageId,
      entity_type:  "transaction",
      entity_id:    params.transactionId,
      event_type:   KernelEvent.EARNEST_MONEY_MILESTONE_COMPLETED,
      metadata:     { milestone: "earnest_money_due" },
    })
  }

  revalidatePath(`/dashboard/transactions/${params.transactionId}`)
  return { success: true }
}

// ─── GET PENDING QUOTE APPROVALS ───────────────────────────────────────────────

export async function getPendingQuoteApprovalsAction(transactionId: string) {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from("activities")
    .select("*")
    .eq("transaction_id", transactionId)
    .eq("activity_type", "client_quote_approval_needed")
    .eq("status", "pending")
    .order("created_at", { ascending: false })

  if (error) {
    return { success: false, error: error.message, data: [] }
  }

  return { success: true, data: data ?? [] }
}

// ─── GET INSPECTIONS ───────────────────────────────────────────────────────────

export async function getInspectionsAction(transactionId: string) {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from("transaction_inspections")
    .select("*")
    .eq("transaction_id", transactionId)
    .order("created_at", { ascending: false })

  if (error) {
    return { success: false, error: error.message, data: [] }
  }

  return { success: true, data: data ?? [] }
}
