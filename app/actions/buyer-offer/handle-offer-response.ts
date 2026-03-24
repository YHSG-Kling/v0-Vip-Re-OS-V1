"use server"

import { createServiceClient } from "@/lib/supabase/service"
import { isValidUUID } from "@/lib/validations"
import { checkCompliancePassed, syncOfferStatus } from "@/lib/buyer-offer"

interface HandleOfferResponseParams {
  offerId: string
  response: "accepted" | "rejected" | "countered"
  userId: string
  counterTerms?: Record<string, any>
  rejectionReason?: string
}

export async function handleOfferResponse(params: HandleOfferResponseParams) {
  const { offerId, response, userId, counterTerms, rejectionReason } = params

  if (!isValidUUID(offerId) || !isValidUUID(userId)) {
    return { success: false, error: "Invalid IDs" }
  }

  const supabase = createServiceClient()

  // Get offer and validate
  const { data: offer, error: offerError } = await supabase
    .from("offers")
    .select("id, contact_id, listing_id, transaction_id")
    .eq("id", offerId)
    .single()

  if (offerError || !offer) {
    return { success: false, error: "Offer not found" }
  }

  // Resolve brokerage_id once for all inserts
  const { data: agentRow } = await supabase
    .from("users")
    .select("brokerage_id")
    .eq("id", userId)
    .maybeSingle()
  const brokerageId = agentRow?.brokerage_id ?? null

  // COMPLIANCE GATE (ABSOLUTE): Must pass before acceptance
  if (response === "accepted") {
    const compliancePassed = await checkCompliancePassed(offerId)
    if (!compliancePassed) {
      // Emit block event
      await supabase.from("activities").insert({
        brokerage_id: brokerageId,
        agent_id: userId,
        contact_id: offer.contact_id,
        activity_type: "buyer.offer.block",
        title: "Offer acceptance blocked: compliance gate failed",
        description: "Cannot accept offer: compliance.passed event not found",
        notes: JSON.stringify({ offer_id: offerId, reason: "compliance_gate_failed", attempted_action: "accept_offer" }),
        status: "completed",
        entity_type: "contact",
      })

      return {
        success: false,
        error: "Cannot accept offer: compliance.passed event not found",
        blockerType: "compliance_gate"
      }
    }

    // Emit acceptance events
    await supabase.from("activities").insert([
      {
        brokerage_id: brokerageId,
        agent_id: userId,
        contact_id: offer.contact_id,
        activity_type: "buyer.offer.accepted",
        title: "Offer accepted",
        description: `Offer ${offerId} accepted`,
        notes: JSON.stringify({ offer_id: offerId }),
        status: "completed",
        entity_type: "contact",
      },
      {
        brokerage_id: brokerageId,
        agent_id: userId,
        contact_id: offer.contact_id,
        activity_type: "buyer.under_contract",
        title: "Buyer under contract",
        description: `Buyer moved to under contract status`,
        notes: JSON.stringify({ buyer_id: offer.contact_id, offer_id: offerId, listing_id: offer.listing_id, transaction_id: offer.transaction_id }),
        status: "completed",
        entity_type: "contact",
        transaction_id: offer.transaction_id ?? null,
      }
    ])

    // Emit transaction handoff event
    if (offer.transaction_id) {
      await supabase.from("activities").insert({
        brokerage_id: brokerageId,
        agent_id: userId,
        contact_id: offer.contact_id,
        activity_type: "transaction.lifecycle.initiated",
        title: "Transaction lifecycle initiated",
        description: `Transaction initiated from buyer offer engine`,
        notes: JSON.stringify({ transaction_id: offer.transaction_id, source: "buyer_offer_engine", offer_id: offerId }),
        status: "completed",
        entity_type: "transaction",
        transaction_id: offer.transaction_id,
      })
    }
  } else if (response === "rejected") {
    // Emit rejection event
    await supabase.from("activities").insert({
      brokerage_id: brokerageId,
      agent_id: userId,
      contact_id: offer.contact_id,
      activity_type: "buyer.offer.rejected",
      title: "Offer rejected",
      description: rejectionReason ?? `Offer ${offerId} rejected`,
      notes: JSON.stringify({ offer_id: offerId, reason: rejectionReason }),
      status: "completed",
      entity_type: "contact",
    })
  } else if (response === "countered") {
    // Emit counter event
    await supabase.from("activities").insert({
      brokerage_id: brokerageId,
      agent_id: userId,
      contact_id: offer.contact_id,
      activity_type: "buyer.offer.counter.received",
      title: "Counter offer received",
      description: `Counter offer received for offer ${offerId}`,
      notes: JSON.stringify({ offer_id: offerId, counter_terms: counterTerms }),
      status: "pending",
      entity_type: "contact",
    })
  }

  // Sync status
  await syncOfferStatus(offerId)

  return {
    success: true,
    response,
    message: `Offer ${response}`
  }
}
