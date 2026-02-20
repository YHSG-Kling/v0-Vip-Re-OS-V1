import { createServiceClient } from "@/lib/supabase/service"

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
  
  // Create activity for client approval
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
  
  // Log event
  await supabase.from("lifecycle_events").insert({
    entity_type: "transaction",
    entity_id: params.transactionId,
    event_type: "transaction.quote.requested",
    brokerage_id: params.brokerageId,
    actor_user_id: params.requestedBy,
    metadata: {
      quote_type: params.quoteType,
      vendor_name: params.vendorName,
      quote_amount: params.quoteAmount
    }
  })
  
  // Create transparency update
  await supabase.from("transparency_updates").insert({
    transaction_id: params.transactionId,
    brokerage_id: params.brokerageId,
    update_type: "action_required",
    title: "Quote Approval Needed",
    message: `Please review and approve the ${params.quoteType} quote from ${params.vendorName}.`,
    is_client_visible: true,
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
    added_at: new Date().toISOString()
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
  
  // Log event
  await supabase.from("lifecycle_events").insert({
    entity_type: "transaction",
    entity_id: params.transactionId,
    event_type: "transaction.quote.approved",
    brokerage_id: params.brokerageId,
    actor_user_id: params.approvedBy,
    metadata: {
      quote_type: params.quoteType,
      vendor_name: params.vendorName,
      notes: params.notes
    }
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
    is_client_visible: true,
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
  
  // Log event
  await supabase.from("lifecycle_events").insert({
    entity_type: "transaction",
    entity_id: params.transactionId,
    event_type: "transaction.quote.declined",
    brokerage_id: params.brokerageId,
    actor_user_id: params.declinedBy,
    metadata: {
      reason: params.reason
    }
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
