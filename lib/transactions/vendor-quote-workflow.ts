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
  const { data: activity } = await supabase
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
  
  // Mark activity complete
  await supabase
    .from("activities")
    .update({
      status: "completed",
      completed_at: new Date().toISOString()
    })
    .eq("id", params.activityId)
  
  // Add vendor to deal team
  await supabase.from("deal_team_members").insert({
    transaction_id: params.transactionId,
    brokerage_id: params.brokerageId,
    member_type: params.quoteType === "inspector" ? "inspector" : "insurance_provider",
    name: params.vendorName,
  })
  
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
  
  // Create TC activity for next step
  await supabase.from("activities").insert({
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
  
  // Mark activity declined
  await supabase
    .from("activities")
    .update({
      status: "cancelled",
      completed_at: new Date().toISOString()
    })
    .eq("id", params.activityId)
  
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
  
  // Create TC activity to get alternative
  await supabase.from("activities").insert({
    transaction_id: params.transactionId,
    brokerage_id: params.brokerageId,
    activity_type: "get_alternative_quote",
    title: "Get Alternative Quote",
    description: `Client declined quote. Reason: ${params.reason || 'Not provided'}`,
    priority: "high",
    status: "pending",
    created_at: new Date().toISOString()
  })
  
  return { success: true }
}
