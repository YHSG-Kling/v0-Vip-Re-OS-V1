import { createServiceClient } from "@/lib/supabase/service"
import type { TransactionStage } from "./transaction-stages"
import { ensureRequiredMilestones } from "./milestone-service"
import { transitionLifecycle } from "@/lib/kernel/lifecycle"

/**
 * Create transaction from accepted offer
 * Enforces: contract_date + compliance_passed_at gates
 */
export async function createTransactionFromOffer(params: {
  offerId: string
  brokerageId: string
  contractDate: string
  compliancePassedAt: string
  contractTerms: {
    earnestMoneyDue?: string
    inspectionDeadline?: string
    appraisalDeadline?: string
    financingDeadline?: string
    closingDate?: string
  }
}) {
  const supabase = createServiceClient()
  
  // Validate gates
  if (!params.contractDate) {
    throw new Error("[offer-bridge] contract_date required to create transaction")
  }
  
  if (!params.compliancePassedAt) {
    throw new Error("[offer-bridge] compliance_passed_at required to create transaction")
  }
  
  // Get offer details
  const { data: offer, error: offerError } = await supabase
    .from("offers")
    .select("*, buyer_agents!inner(agent_id, brokerage_id)")
    .eq("id", params.offerId)
    .single()
  
  if (offerError || !offer) {
    throw new Error(`[offer-bridge] Offer not found: ${params.offerId}`)
  }
  
  // Create transaction
  const { data: transaction, error: txnError } = await supabase
    .from("transactions")
    .insert({
      brokerage_id: params.brokerageId,
      agent_id: offer.buyer_agents[0]?.agent_id,
      contact_id: offer.buyer_id,
      property_address: offer.property_address,
      deal_type: "purchase",
      purchase_price: offer.offer_price,
      contract_date: params.contractDate,
      compliance_passed_at: params.compliancePassedAt,
      stage: "UNDER_CONTRACT",
      status: "under_contract",
      created_at: new Date().toISOString()
    })
    .select()
    .single()
  
  if (txnError || !transaction) {
    throw new Error(`[offer-bridge] Failed to create transaction: ${txnError?.message}`)
  }
  
  // Log contract date set event via kernel
  await transitionLifecycle({
    brokerageId: params.brokerageId,
    entityType:  "transaction",
    entityId:    transaction.id,
    fromState:   "offer_accepted",
    toState:     "UNDER_CONTRACT",
    actorUserId: undefined,
    actorRole:   "tc",
    eventType:   "contract_date.set",
    metadata:    {
      contract_date:       params.contractDate,
      compliance_passed_at: params.compliancePassedAt,
      created_from_offer:  params.offerId,
    },
  })
  
  // Generate required milestones — signature: (transactionId, brokerageId, contractTerms)
  await ensureRequiredMilestones(
    transaction.id,
    params.brokerageId,
    params.contractTerms
  )
  
  // Create first activity — Agent task (correct location, no changes) — activity_type: transaction_started
  await supabase.from("activities").insert({
    transaction_id: transaction.id,
    brokerage_id: params.brokerageId,
    agent_id: offer.buyer_agents[0]?.agent_id,
    activity_type: "transaction_started",
    title: "Transaction Created - Schedule Inspection",
    description: "Transaction is now under contract. Next step: schedule home inspection.",
    priority: "high",
    assigned_to: offer.buyer_agents[0]?.agent_id,
    status: "pending",
    created_at: new Date().toISOString()
  })
  
  // Create transparency update for client
  await supabase.from("transparency_updates").insert({
    transaction_id: transaction.id,
    brokerage_id: params.brokerageId,
    update_type: "stage_change",
    title: "Under Contract",
    message: `Congratulations! Your offer has been accepted and the contract is fully executed. 
    
Earnest money due: ${params.contractTerms.earnestMoneyDue || 'TBD'}
Inspection deadline: ${params.contractTerms.inspectionDeadline || 'TBD'}
Estimated closing: ${params.contractTerms.closingDate || 'TBD'}`,
    is_client_visible: true,
    created_at: new Date().toISOString()
  })
  
  return { success: true, transactionId: transaction.id }
}
