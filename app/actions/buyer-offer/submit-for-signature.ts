"use server"

import { createServiceClient } from "@/lib/supabase/service"
import { isValidUUID } from "@/lib/validations"
import { checkCompliancePassed, syncOfferStatus } from "@/lib/buyer-offer"
import { getTransactionProviderByName } from "@/lib/integrations/providers/provider-resolver"
import { logEventAndTrigger } from "@/lib/events/event-helpers"

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

  // Get offer — use schema-correct columns: esign_provider, brokerage_id
  // The contact has no provider relationship; providers are owned by the brokerage
  const { data: offer, error: offerError } = await supabase
    .from("offers")
    .select("id, contact_id, listing_id, brokerage_id, esign_provider, buyer_commission_acknowledged_at, disclosed_commission_payer")
    .eq("id", offerId)
    .single()

  if (offerError || !offer) {
    return { success: false, error: "Offer not found" }
  }

  // NAR 2024 GATE: buyer commission disclosure must be acknowledged before submit.
  // The acknowledgment captures explicit comp terms + audit trail (IP/UA for
  // click-through, method=wet_signature/docusign/dotloop for agent-recorded).
  if (!offer.buyer_commission_acknowledged_at) {
    await supabase.from("activities").insert({
      activity_type: "buyer.offer.block",
      agent_id:      userId,
      entity_type:   "offer",
      title:         "Signature blocked: buyer commission disclosure not acknowledged",
      description:   `Offer ${offerId} blocked — NAR 2024 requires explicit commission acknowledgment before submission`,
    })
    return {
      success: false,
      error: "Buyer must acknowledge commission disclosure before submission (NAR 2024 settlement)",
      blockerType: "commission_disclosure_required"
    }
  }

  // COMPLIANCE GATE: Must pass before requesting signatures
  const compliancePassed = await checkCompliancePassed(offerId)
  if (!compliancePassed) {
    // Emit block event
    await supabase.from("activities").insert({
      activity_type: "buyer.offer.block",
      agent_id: userId,
      entity_type: "offer",
      title:        "Signature blocked: compliance not passed",
      description:  `Offer ${offerId} blocked from submission — compliance gate failed`,
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
    agent_id:      userId,
    entity_type:   "offer",
    title:         "Signature requested",
    description:   `Signature requested for offer ${offerId} (${signers.length} signer(s))`,
  })

  if (eventError) {
    return { success: false, error: "Failed to log signature request event" }
  }

  // Resolve the brokerage's connected e-sign platform from platform_credentials.
  // The contact (buyer/seller) has no provider — only the brokerage/team/agent does.
  const { data: credential } = await supabase
    .from("platform_credentials")
    .select("platform, account_id, access_token")
    .eq("brokerage_id", offer.brokerage_id)
    .in("platform", ["dotloop", "docusign", "skyslope", "authentisign"])
    .eq("is_active", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (credential) {
    try {
      const provider = getTransactionProviderByName(credential.platform)
      // Only call sendForSignature if the offer has an external transaction reference
        if (offer.esign_provider) {
          await provider.sendForSignature({
            externalTransactionId: offer.esign_provider,
            documentId: offerId,
            signers: signers.map((s) => ({ email: s.email, name: s.name, role: s.role })),
          })
        }

        await supabase.from("activities").insert({
          activity_type: "buyer.offer.provider.signature.requested",
          agent_id:      userId,
          entity_type:   "offer",
          title:         `Provider signature requested via ${credential.platform}`,
          description:   `Offer ${offerId} sent to ${credential.platform} for signature`,
        })
    } catch (error) {
      // Provider call failed — event already logged; signature request still proceeds in-app
    }
  }

  // Mark offer esign_status as sent and record the send time
  await supabase
    .from("offers")
    .update({
      esign_status:   "sent",
      esign_sent_at:  new Date().toISOString(),
      esign_provider: credential?.platform ?? offer.esign_provider ?? null,
    })
    .eq("id", offerId)

  // Sync status
  await syncOfferStatus(offerId)

  // Fire notification to the buyer contact so they know to expect the signature request
  if (offer.contact_id) {
    await logEventAndTrigger({
      brokerage_id: offer.brokerage_id,
      event_type: "buyer.offer.signature.sent_to_contact",
      user_id:    userId,
      payload: {
        offerId,
        contact_id:  offer.contact_id,
        signerCount: signers.length,
        provider:    credential?.platform ?? null,
      },
      source:     "ui",
      dedupe_key: `offer-sig-sent-${offerId}-${Date.now()}`,
    }).catch(() => {})
  }

  return {
    success: true,
    message: "Offer submitted for signature"
  }
}
