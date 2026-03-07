"use server"

import { createServiceClient } from "@/lib/supabase/service"
import { isValidUUID } from "@/lib/validations"
import { syncOfferStatus } from "@/lib/buyer-offer"

interface RollbackOfferParams {
  offerId: string
  userId: string
  reason: string
  action: "withdraw" | "void"
}

export async function rollbackOffer(params: RollbackOfferParams) {
  const { offerId, userId, reason, action } = params

  if (!isValidUUID(offerId) || !isValidUUID(userId)) {
    return { success: false, error: "Invalid IDs" }
  }

  const supabase = createServiceClient()

  // Validate offer exists and not already under contract
  const { data: offer } = await supabase
    .from("offers")
    .select("id, contact_id")
    .eq("id", offerId)
    .single()

  if (!offer) {
    return { success: false, error: "Offer not found" }
  }

  // Check if already under contract (cannot rollback)
  const { data: underContractEvent } = await supabase
    .from("activities")
    .select("id")
    .eq("metadata->>offer_id", offerId)
    .eq("activity_type", "buyer.under_contract")
    .single()

  if (underContractEvent) {
    return {
      success: false,
      error: "Cannot rollback: offer already under contract"
    }
  }

  // Emit rollback events
  const eventType = action === "withdraw" ? "buyer.offer.withdrawn" : "buyer.offer.voided"

  await supabase.from("activities").insert([
    {
      activity_type: eventType,
      user_id: userId,
      metadata: {
        offer_id: offerId,
        reason,
        timestamp: new Date().toISOString()
      }
    },
    {
      activity_type: "buyer.offer.rollback",
      user_id: userId,
      metadata: {
        offer_id: offerId,
        rollback_action: action,
        reason
      }
    }
  ])

  // Sync status
  await syncOfferStatus(offerId)

  return {
    success: true,
    message: `Offer ${action}ed successfully`
  }
}
