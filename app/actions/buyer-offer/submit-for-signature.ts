"use server"

import { createServiceClient } from "@/lib/supabase/service"
import { isValidUUID } from "@/lib/validations"
import { checkCompliancePassed, syncOfferStatus } from "@/lib/buyer-offer"
import { getTransactionProvider } from "@/lib/integrations"

interface SubmitForSignatureParams {
  offerId: string
  userId: string
  signers: Array<{
    name: string
    email: string
    role: "buyer" | "co_buyer" | "agent"
  }>
}

export async function submitForSignature(params: SubmitForSignatureParams) {
  const { offerId, userId, signers } = params

  if (!isValidUUID(offerId) || !isValidUUID(userId)) {
    return { success: false, error: "Invalid IDs" }
  }

  const supabase = createServiceClient()

  // Get offer and validate
  const { data: offer, error: offerError } = await supabase
    .from("offers")
    .select("id, contact_id, listing_id, external_provider_id, external_provider")
    .eq("id", offerId)
    .single()

  if (offerError || !offer) {
    return { success: false, error: "Offer not found" }
  }

  // COMPLIANCE GATE: Must pass before requesting signatures
  const compliancePassed = await checkCompliancePassed(offerId)
  if (!compliancePassed) {
    // Emit block event
    await supabase.from("activities").insert({
      activity_type: "buyer.offer.block",
      user_id: userId,
      metadata: {
        offer_id: offerId,
        reason: "compliance_gate_failed",
        attempted_action: "submit_for_signature"
      }
    })

    return {
      success: false,
      error: "Cannot submit for signature: compliance check not passed",
      blockerType: "compliance_gate"
    }
  }

  // Emit signature request event
  const { error: eventError } = await supabase.from("activities").insert({
    activity_type: "buyer.offer.signature.requested",
    user_id: userId,
    metadata: {
      offer_id: offerId,
      signers,
      timestamp: new Date().toISOString()
    }
  })

  if (eventError) {
    return { success: false, error: "Failed to log signature request event" }
  }

  // Send to provider for signature workflow
  if (offer.external_provider && offer.external_provider_id) {
    try {
      const provider = await getTransactionProvider(offer.external_provider)
      await provider.requestSignatures(offer.external_provider_id, signers)

      // Emit provider event
      await supabase.from("activities").insert({
        activity_type: "buyer.offer.provider.signature.requested",
        user_id: userId,
        metadata: {
          offer_id: offerId,
          provider: offer.external_provider,
          external_id: offer.external_provider_id
        }
      })
    } catch (error) {
      console.error("[v0] Provider signature request failed:", error)
      // Continue - event already logged
    }
  }

  // Sync status
  await syncOfferStatus(offerId)

  return {
    success: true,
    message: "Offer submitted for signature"
  }
}
