"use server"

import { createServiceClient } from "@/lib/supabase/service"
import { isValidUUID } from "@/lib/validations"
import { getTransactionProviderByName } from "@/lib/integrations/providers/provider-resolver"
import { logEventAndTrigger } from "@/lib/events/event-helpers"

interface SubmitListingForSignatureParams {
  listingId: string
  userId: string
  signers: Array<{
    name: string
    email: string
    role: "seller" | "co_seller" | "agent"
  }>
}

export async function submitListingForSignature(params: SubmitListingForSignatureParams) {
  const { listingId, userId, signers } = params

  if (!isValidUUID(listingId) || !isValidUUID(userId)) {
    return { success: false, error: "Invalid IDs" }
  }

  const supabase = createServiceClient()

  // Get listing with brokerage_id and seller_contact_id for provider resolution + notification
  // Note: esign columns live on listing_agreements, not listings
  const { data: listing, error: listingError } = await supabase
    .from("listings")
    .select("id, brokerage_id, address, status, seller_contact_id")
    .eq("id", listingId)
    .single()

  if (listingError || !listing) {
    return { success: false, error: "Listing not found" }
  }

  // Emit signature request event using schema-correct columns
  const { error: eventError } = await supabase.from("activities").insert({
    activity_type: "listing.signature.requested",
    agent_id:      userId,
    entity_type:   "listing",
    title:         "Signature requested",
    description:   `Signature requested for listing ${listingId} (${signers.length} signer(s))`,
  })

  if (eventError) {
    return { success: false, error: "Failed to log signature request event" }
  }

  // Resolve brokerage e-sign provider from platform_credentials (same as offer flow)
  const { data: credential } = await supabase
    .from("platform_credentials")
    .select("platform, account_id, access_token")
    .eq("brokerage_id", listing.brokerage_id)
    .in("platform", ["dotloop", "docusign", "skyslope", "authentisign"])
    .eq("is_active", true)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  // Resolve existing listing_agreement to get provider_ref for the sendForSignature call
  const { data: agreement } = await supabase
    .from("listing_agreements")
    .select("id, provider_ref, provider_name, esign_status")
    .eq("listing_id", listingId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (credential) {
    try {
      const provider = getTransactionProviderByName(credential.platform)
      // Only call sendForSignature if a provider_ref exists on the listing agreement
      if (agreement?.provider_ref) {
        await provider.sendForSignature({
          externalTransactionId: agreement.provider_ref,
          documentId: listingId,
          signers: signers.map((s) => ({ email: s.email, name: s.name, role: s.role })),
        })
      }

      await supabase.from("activities").insert({
        activity_type: "listing.provider.signature.requested",
        agent_id:      userId,
        entity_type:   "listing",
        title:         `Provider signature requested via ${credential.platform}`,
        description:   `Listing ${listingId} sent to ${credential.platform} for signature`,
      })
    } catch {
      // Provider call failed — in-app signature request still proceeds
    }
  }

  // Update esign_status on listing_agreements (esign columns live there, not on listings)
  if (agreement?.id) {
    await supabase
      .from("listing_agreements")
      .update({
        esign_status:  "sent",
        provider_name: credential?.platform ?? agreement.provider_name ?? null,
      })
      .eq("id", agreement.id)
  }

  // Fire notification to the seller contact so they know to expect the signature request
  if (listing.seller_contact_id) {
    await logEventAndTrigger({
      event_type: "listing.signature.sent_to_contact",
      user_id:    listing.seller_contact_id,
      payload: {
        listingId,
        address:      listing.address,
        signerCount:  signers.length,
        provider:     credential?.platform ?? null,
      },
      source:     "action",
      dedupe_key: `listing-sig-sent-${listingId}-${Date.now()}`,
    }).catch(() => {})
  }

  return {
    success: true,
    message: "Listing submitted for signature",
    provider: credential?.platform ?? null,
  }
}
