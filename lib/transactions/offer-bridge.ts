import { createServiceClient } from "@/lib/supabase/service"
import { ensureRequiredMilestones } from "./milestone-service"
import { transitionLifecycle } from "@/lib/kernel/lifecycle"
import { populateInitialParticipants } from "./participant-populator"

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

  // Resolve property address + seller_contact_id from listing if available
  let resolvedAddress = (offer as any).property_address ?? null
  let sellerContactId: string | null = null
  if ((offer as any).listing_id) {
    const { data: listing } = await supabase
      .from("listings")
      .select("address, city, state, seller_contact_id")
      .eq("id", (offer as any).listing_id)
      .maybeSingle()
    if (listing) {
      if (!resolvedAddress) {
        resolvedAddress = [listing.address, listing.city, listing.state].filter(Boolean).join(", ")
      }
      sellerContactId = (listing as any).seller_contact_id ?? null
    }
  }

  // Create transaction — use contact_id (not buyer_id) and agent_id (not buyer_agents join)
  // deal_name is NOT NULL on transactions; default to property_address (or
  // a synthetic name from offer id if address is somehow missing) so the
  // chain never fails the insert.
  const dealName = resolvedAddress
    ?? `Transaction ${params.offerId.slice(0, 8)}`
  const { data: transaction, error: txnError } = await supabase
    .from("transactions")
    .insert({
      brokerage_id:         params.brokerageId,
      agent_id:             (offer as any).agent_id,
      contact_id:           (offer as any).contact_id,   // live FK (not buyer_id)
      buyer_contact_id:     (offer as any).contact_id,
      seller_contact_id:    sellerContactId,             // resolved from listing → enables seller-side close logic
      listing_id:           (offer as any).listing_id ?? null,
      offer_id:             params.offerId,
      deal_name:            dealName,
      property_address:     resolvedAddress,
      // Schema CHECK: deal_type ∈ {buyer, seller, dual}. Voice-cockpit + manual
      // offers create the BUYER side of the transaction; "purchase" was the
      // pre-existing value here and never matched the constraint.
      deal_type:            "buyer",
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
  
  // Client-facing "under contract" card now flows through the canonical kernel template path
  // (idempotent + buyer/seller-aware) instead of a one-off direct transparency_updates write — this
  // is the single chokepoint all four accept flows share, so emitting here gives every flow the same
  // notification + sequence-enrollment + portal card. For the seller-accept path (which also emits
  // OFFER_ACCEPTED) the portal writer's idempotency collapses the two into one card. Best-effort:
  // never break transaction creation on a fan-out failure. Contract dates surface as their own
  // milestone cards (earnest money, inspection, closing) as the deal progresses.
  try {
    const { emitTransactionEvent } = await import("@/lib/kernel/transactions")
    const { KernelEvent } = await import("@/lib/kernel/events")
    await emitTransactionEvent({
      event:       KernelEvent.OFFER_ACCEPTED,
      brokerageId: params.brokerageId,
      entityId:    transaction.id,
      actorUserId: "",
      metadata: {
        earnest_money_due:   params.contractTerms.earnestMoneyDue ?? null,
        inspection_deadline: params.contractTerms.inspectionDeadline ?? null,
        closing_date:        params.contractTerms.closingDate ?? null,
        created_from_offer:  params.offerId,
      },
    })
  } catch (err) {
    console.error("[offer-bridge] emitTransactionEvent(OFFER_ACCEPTED) failed", err)
  }

  // Auto-populate transaction_participants from offer + listing + brokerage
  // preferred-vendor directory. Never inserts placeholders — only rows for
  // which we can resolve real names/emails. Idempotent (skips when the
  // transaction already has any participants).
  try {
    await populateInitialParticipants(supabase as any, transaction.id, params.brokerageId)
  } catch (err: any) {
    // Failure here must not roll back the transaction. The agent can still
    // populate participants manually from the transaction UI.
    console.error("[offer-bridge] populateInitialParticipants failed (non-fatal):", err?.message ?? err)
  }

  return { success: true, transactionId: transaction.id }
}
