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
  
  // Get offer details.
  // NOTE: buyer_agents table does NOT exist — use offer.agent_id directly.
  //       offer.buyer_id does NOT exist — live FK is offer.contact_id.
  const { data: offer, error: offerError } = await supabase
    .from("offers")
    .select("id, agent_id, contact_id, listing_id, offer_price, closing_date, property_address")
    .eq("id", params.offerId)
    .maybeSingle()

  if (offerError || !offer) {
    throw new Error(`[offer-bridge] Offer not found: ${params.offerId}`)
  }

  // Resolve property address from listing if not on the offer directly
  let resolvedAddress = (offer as any).property_address ?? null
  if (!resolvedAddress && (offer as any).listing_id) {
    const { data: listing } = await supabase
      .from("listings")
      .select("address, city, state")
      .eq("id", (offer as any).listing_id)
      .maybeSingle()
    if (listing) {
      resolvedAddress = [listing.address, listing.city, listing.state].filter(Boolean).join(", ")
    }
  }

  // Create transaction — use contact_id (not buyer_id) and agent_id (not buyer_agents join)
  const { data: transaction, error: txnError } = await supabase
    .from("transactions")
    .insert({
      brokerage_id:         params.brokerageId,
      agent_id:             (offer as any).agent_id,
      contact_id:           (offer as any).contact_id,   // live FK (not buyer_id)
      buyer_contact_id:     (offer as any).contact_id,
      listing_id:           (offer as any).listing_id ?? null,
      offer_id:             params.offerId,
      property_address:     resolvedAddress,
      deal_type:            "purchase",
      purchase_price:       (offer as any).offer_price,
      contract_date:        params.contractDate,
      compliance_passed_at: params.compliancePassedAt,
      stage:                "UNDER_CONTRACT",
      status:               "under_contract",
      created_at:           new Date().toISOString(),
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
    actorUserId: "",
    actorRole:   "tc",
    eventType:   "contract_date.set",
    metadata:    {
      contract_date:       params.contractDate,
      compliance_passed_at: params.compliancePassedAt,
      created_from_offer:  params.offerId,
    },
  })
  
  // ensureRequiredMilestones looks up dates by snake_case milestone_name key
  // e.g. contractTerms["closing_date"], contractTerms["inspection_deadline"]
  // Normalise camelCase keys from the offer bridge params before passing in
  const normalisedTerms: Record<string, string> = {}
  const { closingDate, inspectionDeadline, appraisalDeadline, financingDeadline, earnestMoneyDue } = params.contractTerms
  if (closingDate)        normalisedTerms["closing_date"]        = closingDate
  if (inspectionDeadline) normalisedTerms["inspection_deadline"] = inspectionDeadline
  if (appraisalDeadline)  normalisedTerms["appraisal_deadline"]  = appraisalDeadline
  if (financingDeadline)  normalisedTerms["financing_deadline"]  = financingDeadline
  if (earnestMoneyDue)    normalisedTerms["earnest_money_due"]   = earnestMoneyDue

  await ensureRequiredMilestones(
    transaction.id,
    params.brokerageId,
    normalisedTerms
  )
  
  // Back-link the offer to the created transaction
  await supabase
    .from("offers")
    .update({ transaction_id: transaction.id, updated_at: new Date().toISOString() })
    .eq("id", params.offerId)

  // Create first activity — Agent task (correct location, no changes) — activity_type: transaction_started
  await supabase.from("activities").insert({
    transaction_id: transaction.id,
    brokerage_id:   params.brokerageId,
    agent_id:       (offer as any).agent_id,  // buyer_agents table does NOT exist
    activity_type:  "transaction_started",
    title:          "Transaction Created - Schedule Inspection",
    description:    "Transaction is now under contract. Next step: schedule home inspection.",
    priority:       "high",
    status:         "pending",
    created_at:     new Date().toISOString(),
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
