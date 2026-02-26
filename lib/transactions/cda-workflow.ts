import { createServiceClient } from "@/lib/supabase/service"
import { calculateCommission } from "@/lib/commission"

/**
 * CDA Workflow: Preview → Generate → Compare → Approve → Deliver
 * Triggered on CLOSING_PREP stage entry
 */
export async function generateCDAPreview(params: {
  transactionId: string
  brokerageId: string
  agentId: string
}) {
  const supabase = createServiceClient()
  
  // Run Commission Engine in PREVIEW mode
  const commissionResult = await calculateCommission({
    transactionId: params.transactionId,
    brokerageId: params.brokerageId,
    agentId: params.agentId,
    preview: true
  })
  
  if (!commissionResult.success) {
    throw new Error(`[cda-workflow] Commission calculation failed: ${commissionResult.error}`)
  }
  
  // Create CDA record
  const { data: cda, error: cdaError } = await supabase
    .from("closing_disclosure_agreement")
    .insert({
      transaction_id: params.transactionId,
      brokerage_id: params.brokerageId,
      status: "pending",
      gross_commission: commissionResult.grossCommissionCents / 100,
      agent_net: commissionResult.agentFinalNetCents / 100,
      brokerage_net: commissionResult.brokerageFinalCents / 100,
      calculation_version: "8.0",
      created_at: new Date().toISOString()
    })
    .select()
    .single()
  
  if (cdaError || !cda) {
    throw new Error(`[cda-workflow] Failed to create CDA: ${cdaError?.message}`)
  }
  
  // Run comparison (placeholder - actual comparison logic based on your schema)
  const discrepancies = await compareCDAToExpected(cda.id, commissionResult)
  
  if (discrepancies.length > 0) {
    // Notify compliance officer + broker
    await supabase.from("lifecycle_events").insert({
      entity_type: "transaction",
      entity_id: params.transactionId,
      event_type: "transaction.cda.discrepancy_detected",
      brokerage_id: params.brokerageId,
      metadata: {
        cda_id: cda.id,
        discrepancies
      }
    })
    
    // Create activity for review
    await supabase.from("activities").insert({
      transaction_id: params.transactionId,
      brokerage_id: params.brokerageId,
      activity_type: "cda_review_required",
      title: "CDA Discrepancy Detected",
      description: `Commission calculation has ${discrepancies.length} discrepancies. Review required.`,
      priority: "urgent",
      status: "pending",
      created_at: new Date().toISOString()
    })
  }
  
  return { success: true, cdaId: cda.id, hasDiscrepancies: discrepancies.length > 0 }
}

/**
 * Agent submits CDA for approval
 */
export async function submitCDA(cdaId: string, agentId: string) {
  const supabase = createServiceClient()
  
  await supabase
    .from("closing_disclosure_agreement")
    .update({
      status: "submitted",
      agent_submitted_at: new Date().toISOString(),
      agent_submitted_by: agentId
    })
    .eq("id", cdaId)
  
  // Log event
  const { data: cda } = await supabase
    .from("closing_disclosure_agreement")
    .select("transaction_id, brokerage_id")
    .eq("id", cdaId)
    .single()
  
  if (cda) {
    await supabase.from("lifecycle_events").insert({
      entity_type: "transaction",
      entity_id: cda.transaction_id,
      event_type: "transaction.cda.submitted",
      brokerage_id: cda.brokerage_id,
      actor_user_id: agentId,
      metadata: { cda_id: cdaId }
    })
  }
  
  return { success: true }
}

/**
 * Compliance/Broker approves CDA
 */
export async function approveCDA(params: {
  cdaId: string
  approverId: string
  approverRole: string
}) {
  const supabase = createServiceClient()
  
  await supabase
    .from("closing_disclosure_agreement")
    .update({
      status: "approved",
      compliance_approved_at: new Date().toISOString(),
      compliance_approved_by: params.approverId
    })
    .eq("id", params.cdaId)
  
  // Complete milestone
  const { data: cda } = await supabase
    .from("closing_disclosure_agreement")
    .select("transaction_id, brokerage_id")
    .eq("id", params.cdaId)
    .single()
  
  if (cda) {
    await supabase
      .from("transaction_milestones")
      .update({ status: "completed", completed_at: new Date().toISOString() })
      .eq("transaction_id", cda.transaction_id)
      .eq("milestone_name", "cda_delivered")
    
    await supabase.from("lifecycle_events").insert({
      entity_type: "transaction",
      entity_id: cda.transaction_id,
      event_type: "transaction.cda.approved",
      brokerage_id: cda.brokerage_id,
      actor_user_id: params.approverId,
      metadata: { cda_id: params.cdaId, approver_role: params.approverRole }
    })
  }
  
  return { success: true }
}

async function compareCDAToExpected(cdaId: string, commissionResult: any): Promise<any[]> {
  // Placeholder for comparison logic
  // In production, this would compare CDA amounts to expected contract terms
  return []
}
