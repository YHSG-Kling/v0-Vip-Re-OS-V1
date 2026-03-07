"use server"

import { createServiceClient } from "@/lib/supabase/service"
import { isValidUUID } from "@/lib/validations"
import { checkCompliancePassed, syncOfferStatus } from "@/lib/buyer-offer"

interface RespondToCounterParams {
  offerId: string
  response: "accept" | "reject" | "counter_back"
  userId: string
  counterTerms?: Record<string, any>
  rejectionReason?: string
}

export async function respondToCounter(params: RespondToCounterParams) {
  const { offerId, response, userId, counterTerms, rejectionReason } = params

  if (!isValidUUID(offerId) || !isValidUUID(userId)) {
    return { success: false, error: "Invalid IDs" }
  }

  const supabase = createServiceClient()

  // Get offer
  const { data: offer, error: offerError } = await supabase
    .from("offers")
    .select("id, contact_id, listing_id, transaction_id")
    .eq("id", offerId)
    .single()

  if (offerError || !offer) {
    return { success: false, error: "Offer not found" }
  }

  // Count counter rounds (max 5)
  const { data: counterEvents } = await supabase
    .from("activities")
    .select("id")
    .eq("metadata->>offer_id", offerId)
    .in("activity_type", ["buyer.offer.counter.received", "buyer.offer.counter.submitted"])

  if (counterEvents && counterEvents.length >= 5 && response === "counter_back") {
    return {
      success: false,
      error: "Maximum counter rounds (5) exceeded"
    }
  }

  // COMPLIANCE GATE: Must pass before accepting counter
  if (response === "accept") {
    const compliancePassed = await checkCompliancePassed(offerId)
    if (!compliancePassed) {
      await supabase.from("activities").insert({
        activity_type: "buyer.offer.block",
        user_id: userId,
        metadata: {
          offer_id: offerId,
          reason: "compliance_gate_failed",
          attempted_action: "accept_counter"
        }
      })

      return {
        success: false,
        error: "Cannot accept counter: compliance.passed event not found",
        blockerType: "compliance_gate"
      }
    }

    // Emit counter acceptance
    await supabase.from("activities").insert([
      {
        activity_type: "buyer.offer.counter.accepted",
        user_id: userId,
        metadata: { offer_id: offerId }
      },
      {
        activity_type: "buyer.offer.accepted",
        user_id: userId,
        metadata: { offer_id: offerId }
      },
      {
        activity_type: "buyer.under_contract",
        user_id: userId,
        metadata: {
          buyer_id: offer.contact_id,
          offer_id: offerId,
          transaction_id: offer.transaction_id
        }
      }
    ])

    // Transaction handoff
    if (offer.transaction_id) {
      await supabase.from("activities").insert({
        activity_type: "transaction.lifecycle.initiated",
        user_id: userId,
        metadata: {
          transaction_id: offer.transaction_id,
          source: "buyer_offer_counter_acceptance",
          offer_id: offerId
        }
      })
    }
  } else if (response === "reject") {
    await supabase.from("activities").insert({
      activity_type: "buyer.offer.counter.rejected",
      user_id: userId,
      metadata: { offer_id: offerId, reason: rejectionReason }
    })
  } else if (response === "counter_back") {
    await supabase.from("activities").insert({
      activity_type: "buyer.offer.counter.submitted",
      user_id: userId,
      metadata: { offer_id: offerId, counter_terms: counterTerms }
    })
  }

  // Sync status
  await syncOfferStatus(offerId)

  return { success: true, response }
}
