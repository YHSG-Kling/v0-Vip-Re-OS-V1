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

  // COMPLIANCE GATE (ABSOLUTE): Must pass before acceptance
  if (response === "accepted") {
    const compliancePassed = await checkCompliancePassed(offerId)
    if (!compliancePassed) {
      // Emit block event
      await supabase.from("activities").insert({
        activity_type: "buyer.offer.block",
        user_id: userId,
        metadata: {
          offer_id: offerId,
          reason: "compliance_gate_failed",
          attempted_action: "accept_offer"
        }
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
        activity_type: "buyer.offer.accepted",
        user_id: userId,
        metadata: {
          offer_id: offerId,
          timestamp: new Date().toISOString()
        }
      },
      {
        activity_type: "buyer.under_contract",
        user_id: userId,
        metadata: {
          buyer_id: offer.contact_id,
          offer_id: offerId,
          listing_id: offer.listing_id,
          transaction_id: offer.transaction_id
        }
      }
    ])

    // Emit transaction handoff event
    if (offer.transaction_id) {
      await supabase.from("activities").insert({
        activity_type: "transaction.lifecycle.initiated",
        user_id: userId,
        metadata: {
          transaction_id: offer.transaction_id,
          source: "buyer_offer_engine",
          offer_id: offerId
        }
      })
    }
  } else if (response === "rejected") {
    // Emit rejection event
    await supabase.from("activities").insert({
      activity_type: "buyer.offer.rejected",
      user_id: userId,
      metadata: {
        offer_id: offerId,
        reason: rejectionReason,
        timestamp: new Date().toISOString()
      }
    })
  } else if (response === "countered") {
    // Emit counter event
    await supabase.from("activities").insert({
      activity_type: "buyer.offer.counter.received",
      user_id: userId,
      metadata: {
        offer_id: offerId,
        counter_terms: counterTerms,
        timestamp: new Date().toISOString()
      }
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
